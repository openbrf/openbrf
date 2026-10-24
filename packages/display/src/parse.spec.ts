import { describe, expect, it } from "vite-plus/test";

import {
  addonSlides,
  availabilitySlide,
  eventsSlide,
  meetingSlide,
  newsSlide,
  pictureSlide,
  screenContent,
} from "../test/fixtures.ts";
import { parseScreenContent, ScreenContentError } from "./parse.ts";

function reasonOf(value: unknown): string {
  try {
    parseScreenContent(value);
  } catch (error) {
    if (error instanceof ScreenContentError) {
      return error.reason;
    }
    throw error;
  }
  return "accepted";
}

const everyKind = () => [
  newsSlide("news.1"),
  eventsSlide(),
  meetingSlide(),
  availabilitySlide(),
  pictureSlide("picture.1"),
  ...addonSlides(),
];

describe("parseScreenContent", () => {
  it("reads a document with every body kind as it is", () => {
    const document = screenContent(everyKind());

    expect(parseScreenContent(structuredClone(document))).toEqual(document);
  });

  it("ignores fields it does not know, and leaves them out of the result", () => {
    const document = {
      ...screenContent([
        {
          ...newsSlide("news.1"),
          later: true,
          body: { ...newsSlide("news.1").body, subtitle: "From version 1.1" },
        },
      ]),
      addedLater: { anything: 1 },
      layout: {
        orientation: 0,
        header: "none",
        theme: "dark",
        contrast: "high",
      },
    };

    const parsed = parseScreenContent(document);

    expect(parsed).not.toHaveProperty("addedLater");
    expect(parsed.layout).toEqual({
      orientation: 0,
      header: "none",
      theme: "dark",
    });
    expect(parsed.rotation[0]).not.toHaveProperty("later");
    expect(parsed.rotation[0]?.body).not.toHaveProperty("subtitle");
  });

  it("skips a slide whose body kind it does not know, and keeps the rest", () => {
    const document = screenContent([
      newsSlide("news.1"),
      {
        ...newsSlide("weather"),
        body: { kind: "weather", celsius: 4 },
      } as never,
      newsSlide("news.2"),
    ]);

    expect(
      parseScreenContent(document).rotation.map((slide) => slide.id),
    ).toEqual(["news.1", "news.2"]);
  });

  it.each([
    ["an id outside the pattern", { id: "news 1" }],
    ["an id over 64 characters", { id: "n".repeat(65) }],
    ["seconds under 5", { seconds: 4 }],
    ["seconds over 120", { seconds: 121 }],
    ["seconds that are not whole", { seconds: 7.5 }],
    ["an until that is not an instant", { until: "2026-10-23 10:00" }],
    [
      "an until on a day that does not exist",
      { until: "2026-02-30T10:00:00Z" },
    ],
    ["an until with milliseconds", { until: "2026-10-23T10:00:00.000Z" }],
    ["a source that does not match its body", { source: "events" }],
    ["an addon id on a slide that is not an addon's", { addon: "residents" }],
  ])("skips a slide with %s", (_, change) => {
    const document = screenContent([
      newsSlide("news.1"),
      { ...newsSlide("news.2"), ...change } as never,
    ]);

    expect(
      parseScreenContent(document).rotation.map((slide) => slide.id),
    ).toEqual(["news.1"]);
  });

  it.each([
    ["a title over 200 characters", { title: "x".repeat(201) }],
    [
      "paragraphs over 2 000 characters together",
      {
        paragraphs: ["x".repeat(1000), "y".repeat(1001)],
      },
    ],
    ["a paragraph that is not text", { paragraphs: [1] }],
    [
      "a picture without its version",
      {
        picture: {
          mediaFileId: "f",
          contentType: "image/png",
          byteSize: 1,
          alt: "",
        },
      },
    ],
  ])("skips a news slide with %s", (_, change) => {
    const slide = newsSlide("news.2");
    const document = screenContent([
      newsSlide("news.1"),
      { ...slide, body: { ...slide.body, ...change } } as never,
    ]);

    expect(
      parseScreenContent(document).rotation.map((each) => each.id),
    ).toEqual(["news.1"]);
  });

  it("counts characters as code points, so a text of emoji at its limit is read", () => {
    const slide = newsSlide("news.1");
    const document = screenContent([
      { ...slide, body: { ...slide.body, title: "🏠".repeat(200) } } as never,
    ]);

    expect(parseScreenContent(document).rotation).toHaveLength(1);
  });

  it("skips an events slide with no occurrence or more than eight", () => {
    const slide = eventsSlide();
    const body = slide.body as { occurrences: unknown[] };
    const none = { ...slide, id: "none", body: { ...body, occurrences: [] } };
    const nine = {
      ...slide,
      id: "nine",
      body: { ...body, occurrences: Array(9).fill(body.occurrences[0]) },
    };

    expect(
      parseScreenContent(screenContent([none, nine] as never)).rotation,
    ).toEqual([]);
  });

  it("skips an availability slide reaching more than 7 days, or with 13 resources", () => {
    const slide = availabilitySlide();
    const body = slide.body as { resources: unknown[] };
    const long = {
      ...slide,
      id: "long",
      body: { ...body, to: "2026-10-30T10:00:01Z" },
    };
    const many = {
      ...slide,
      id: "many",
      body: { ...body, resources: Array(13).fill(body.resources[0]) },
    };

    expect(
      parseScreenContent(screenContent([long, many] as never)).rotation,
    ).toEqual([]);
  });

  it("skips a table whose row is not as wide as its columns", () => {
    const [, table] = addonSlides();
    const document = screenContent([
      {
        ...table,
        body: {
          kind: "table",
          heading: "Waste",
          columns: ["Kind", "Day"],
          rows: [["Paper"]],
        },
      } as never,
    ]);

    expect(parseScreenContent(document).rotation).toEqual([]);
  });

  it("keeps the first of two slides with the same id", () => {
    const document = screenContent([
      newsSlide("news.1"),
      {
        ...newsSlide("news.1"),
        body: { ...newsSlide("news.1").body, title: "Second" },
      },
    ]);

    const { rotation } = parseScreenContent(document);
    expect(rotation).toHaveLength(1);
    expect(rotation[0]?.body).toMatchObject({ title: "Title of news.1" });
  });

  it.each([2, 0, "1", null, undefined])(
    "refuses version %s as a version it does not know",
    (version) => {
      expect(reasonOf({ ...screenContent([]), version })).toBe(
        "version-unknown",
      );
    },
  );

  it.each([
    ["no object at all", "[]"],
    ["an empty screen id", { screenId: "" }],
    ["a generatedAt that is not an instant", { generatedAt: "today" }],
    ["a locale it does not speak", { locale: "fi" }],
    ["a time zone Intl does not know", { timeZone: "Mars/Olympus_Mons" }],
    ["an unknown release channel", { releaseChannel: "nightly" }],
    [
      "an orientation of 45 degrees",
      {
        layout: { orientation: 45, header: "none", theme: "dark" },
      },
    ],
    [
      "a schedule window that ends before it begins",
      {
        schedule: { on: [{ days: [1], from: "18:00", to: "08:00" }] },
      },
    ],
    [
      "a schedule window on day 8",
      {
        schedule: { on: [{ days: [8], from: "08:00", to: "18:00" }] },
      },
    ],
    [
      "15 schedule windows",
      {
        schedule: {
          on: Array(15).fill({ days: [1], from: "08:00", to: "18:00" }),
        },
      },
    ],
    ["a rotation that is not a list", { rotation: {} }],
    [
      "a rotation of 101 slides",
      {
        rotation: Array.from({ length: 101 }, (_, index) =>
          newsSlide(`news.${index}`),
        ),
      },
    ],
    ["no refreshSeconds", { refreshSeconds: undefined }],
  ])("refuses a document with %s", (_, change) => {
    const value =
      typeof change === "string"
        ? JSON.parse(change)
        : { ...screenContent([]), ...change };

    expect(reasonOf(value)).toBe("document-invalid");
  });

  it("holds refreshSeconds to 30 to 60 rather than refusing it", () => {
    expect(
      parseScreenContent({ ...screenContent([]), refreshSeconds: 600 })
        .refreshSeconds,
    ).toBe(60);
    expect(
      parseScreenContent({ ...screenContent([]), refreshSeconds: 5 })
        .refreshSeconds,
    ).toBe(30);
  });

  it("reads 24:00 as the end of a schedule window", () => {
    const document = screenContent([], {
      schedule: { on: [{ days: [1, 2, 3], from: "06:00", to: "24:00" }] },
    });

    expect(parseScreenContent(document).schedule).toEqual(document.schedule);
  });
});
