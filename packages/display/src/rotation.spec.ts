import { describe, expect, it } from "vite-plus/test";

import { screenContent } from "../test/fixtures.ts";
import type {
  AvailabilityBody,
  EventsBody,
  MeetingBody,
  NewsBody,
  Slide,
} from "./contract.ts";
import { SLIDE_ID_PATTERN } from "./contract.ts";
import { parseScreenContent } from "./parse.ts";
import {
  availabilityWindow,
  buildRotation,
  type BookableResourceInput,
  type MeetingNoticeInput,
  type NewsItemInput,
  type OccurrenceInput,
} from "./rotation.ts";

const NOW = new Date("2026-10-23T10:00:30.500Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function at(offset: number): string {
  return new Date(NOW.getTime() + offset).toISOString();
}

function newsItem(id: string, overrides: Partial<NewsItemInput> = {}) {
  // The plugin SDK's own fields beyond the builder's, which it ignores.
  return {
    id,
    title: `News ${id}`,
    paragraphs: [`About ${id}.`],
    pictures: [],
    publishedAt: "2026-10-20T08:00:00.123Z",
    audience: "members",
    onScreens: true,
    ...overrides,
  } satisfies NewsItemInput & Record<string, unknown>;
}

function occurrence(
  occurrenceId: string,
  startsIn: number,
  overrides: Partial<OccurrenceInput> = {},
) {
  return {
    eventId: `event-${occurrenceId}`,
    occurrenceId,
    title: `Event ${occurrenceId}`,
    description: null,
    category: "Social",
    location: null,
    startsAt: at(startsIn),
    endsAt: at(startsIn + 2 * HOUR),
    calledOff: false,
    placesLeft: null,
    audience: "anyone",
    onScreens: true,
    ...overrides,
  } satisfies OccurrenceInput & Record<string, unknown>;
}

function notice(
  meetingId: string,
  startsIn: number,
  overrides: Partial<MeetingNoticeInput> = {},
): MeetingNoticeInput {
  return {
    meetingId,
    kind: "ordinary",
    startsAt: at(startsIn),
    place: "The common room",
    digitalParticipation: null,
    agenda: [{ position: 1, title: "Opening" }],
    ...overrides,
  };
}

function resource(id: string): BookableResourceInput {
  return {
    id,
    name: `Resource ${id}`,
    mode: "timeSlots",
    slotMinutes: 120,
    opensAtMinute: 420,
    closesAtMinute: 1320,
  };
}

function body<T>(slides: Slide[], id: string): T {
  const slide = slides.find((each) => each.id === id);
  if (slide === undefined) {
    throw new Error(`No slide ${id}`);
  }
  return slide.body as T;
}

describe("buildRotation", () => {
  it("builds news, events, meeting and availability in that order", () => {
    const slides = buildRotation({
      now: NOW,
      availability: {
        ...availabilityWindow(NOW, "Europe/Stockholm"),
        resources: [resource("r1")],
        busy: [],
      },
      meetingNotices: [notice("m1", 20 * DAY)],
      occurrences: [occurrence("o1", DAY)],
      news: [newsItem("n1"), newsItem("n2")],
    });

    expect(
      slides.map((slide) => [slide.id, slide.source, slide.seconds]),
    ).toEqual([
      ["news.n1", "news", 15],
      ["news.n2", "news", 15],
      ["events", "events", 20],
      ["meeting.m1", "meeting", 20],
      ["availability", "availability", 20],
    ]);
  });

  it("builds nothing for a source it is not given", () => {
    expect(buildRotation({ now: NOW })).toEqual([]);
    expect(buildRotation({ now: NOW, news: [newsItem("n1")] })).toHaveLength(1);
  });

  it("builds slides that pass the parser when put into a document", () => {
    const longText = "Lång text ".repeat(400);
    const slides = buildRotation({
      now: NOW,
      news: Array.from({ length: 12 }, (_, index) =>
        newsItem(`item ${index}`, {
          title: longText,
          paragraphs: [longText, longText],
          pictures: [{ mediaFileId: "pic", alt: longText }],
        }),
      ),
      occurrences: Array.from({ length: 12 }, (_, index) =>
        occurrence(`o${index}`, index * HOUR, {
          title: longText,
          description: longText,
          location: longText,
          placesLeft: -2,
        }),
      ),
      meetingNotices: [
        notice("meeting with spaces", DAY, {
          place: longText,
          digitalParticipation: longText,
          agenda: Array.from({ length: 50 }, (_, index) => ({
            position: index + 1,
            title: longText,
          })),
        }),
      ],
      availability: {
        from: new Date(NOW.getTime() - DAY),
        to: new Date(NOW.getTime() + 30 * DAY),
        resources: Array.from({ length: 15 }, (_, index) => ({
          ...resource(`r${index}`),
          name: longText,
        })),
        busy: [{ resourceId: "r0", start: at(-HOUR), end: at(HOUR + 0.5) }],
      },
      pictures: new Map([
        ["pic", { contentType: "image/jpeg", byteSize: 2048, version: "v3" }],
      ]),
    });
    const document = screenContent(slides);

    expect(parseScreenContent(structuredClone(document))).toEqual(document);
  });

  describe("news", () => {
    it("builds a slide for each of the first ten items, in the order given", () => {
      const slides = buildRotation({
        now: NOW,
        news: Array.from({ length: 12 }, (_, index) => newsItem(`n${index}`)),
      });

      expect(slides.map((slide) => slide.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `news.n${index}`),
      );
    });

    it("writes the item's text and when it was published, to the second", () => {
      const [slide] = buildRotation({ now: NOW, news: [newsItem("n1")] });

      expect(slide).toEqual({
        id: "news.n1",
        seconds: 15,
        until: null,
        source: "news",
        addon: null,
        body: {
          kind: "news",
          title: "News n1",
          paragraphs: ["About n1."],
          picture: null,
          publishedAt: "2026-10-20T08:00:00Z",
        },
      });
    });

    it("takes the first picture the caller resolved, with its alt text", () => {
      const slides = buildRotation({
        now: NOW,
        news: [
          newsItem("n1", {
            pictures: [
              { mediaFileId: "gone", alt: "Not resolved" },
              { mediaFileId: "kept", alt: "The courtyard" },
            ],
          }),
          newsItem("n2", { pictures: [{ mediaFileId: "gone", alt: "" }] }),
        ],
        pictures: new Map([
          ["kept", { contentType: "image/png", byteSize: 99, version: "e1" }],
        ]),
      });

      expect(body<NewsBody>(slides, "news.n1").picture).toEqual({
        mediaFileId: "kept",
        contentType: "image/png",
        byteSize: 99,
        version: "e1",
        alt: "The courtyard",
      });
      expect(body<NewsBody>(slides, "news.n2").picture).toBeNull();
    });

    it("shortens a long title with an ellipsis, within its limit", () => {
      const slides = buildRotation({
        now: NOW,
        news: [newsItem("n1", { title: "word ".repeat(100) })],
      });
      const { title } = body<NewsBody>(slides, "news.n1");

      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.endsWith("…")).toBe(true);
      expect(title).not.toMatch(/ …$/);
    });

    it("keeps the paragraphs within 2 000 characters together", () => {
      const slides = buildRotation({
        now: NOW,
        news: [
          newsItem("n1", {
            paragraphs: [
              "a".repeat(1500),
              "",
              "b".repeat(1000),
              "c".repeat(10),
            ],
          }),
        ],
      });
      const { paragraphs } = body<NewsBody>(slides, "news.n1");

      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]).toBe("a".repeat(1500));
      expect(paragraphs[1]).toBe(`${"b".repeat(499)}…`);
      expect(paragraphs.join("").length).toBe(2000);
    });

    it("gives an id that does not fit the pattern a stable hashed one", () => {
      const build = () =>
        buildRotation({
          now: NOW,
          news: [newsItem("an id with spaces"), newsItem("x".repeat(80))],
        }).map((slide) => slide.id);
      const ids = build();

      expect(ids).toEqual(build());
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) {
        expect(id).toMatch(SLIDE_ID_PATTERN);
        expect(id.startsWith("news.h")).toBe(true);
      }
    });

    it("builds one slide for an item given twice", () => {
      expect(
        buildRotation({ now: NOW, news: [newsItem("n1"), newsItem("n1")] }),
      ).toHaveLength(1);
    });
  });

  describe("events", () => {
    it("lists the soonest eight that have not ended, soonest first", () => {
      const slides = buildRotation({
        now: NOW,
        occurrences: [
          occurrence("ended", -3 * HOUR),
          occurrence("ongoing", -HOUR),
          ...Array.from({ length: 9 }, (_, index) =>
            occurrence(`o${9 - index}`, (9 - index) * DAY),
          ),
        ],
      });
      const { occurrences } = body<EventsBody>(slides, "events");

      expect(occurrences.map((each) => each.title)).toEqual([
        "Event ongoing",
        "Event o1",
        "Event o2",
        "Event o3",
        "Event o4",
        "Event o5",
        "Event o6",
        "Event o7",
      ]);
    });

    it("leaves out what starts 31 days or more from now", () => {
      const slides = buildRotation({
        now: NOW,
        occurrences: [
          occurrence("inside", 31 * DAY - 1000),
          occurrence("outside", 31 * DAY),
        ],
      });

      expect(
        body<EventsBody>(slides, "events").occurrences.map(
          (each) => each.title,
        ),
      ).toEqual(["Event inside"]);
    });

    it("orders occurrences starting together by their id", () => {
      const slides = buildRotation({
        now: NOW,
        occurrences: [occurrence("b", DAY), occurrence("a", DAY)],
      });

      expect(
        body<EventsBody>(slides, "events").occurrences.map(
          (each) => each.title,
        ),
      ).toEqual(["Event a", "Event b"]);
    });

    it("builds no slide when nothing is coming", () => {
      expect(
        buildRotation({ now: NOW, occurrences: [occurrence("old", -DAY)] }),
      ).toEqual([]);
    });

    it("writes the occurrence's details, and nothing of its category or audience", () => {
      const slides = buildRotation({
        now: NOW,
        occurrences: [
          occurrence("o1", DAY, {
            description: "Bring gloves.",
            location: " ",
            calledOff: true,
            placesLeft: 4,
          }),
        ],
      });

      expect(body<EventsBody>(slides, "events").occurrences).toEqual([
        {
          title: "Event o1",
          description: "Bring gloves.",
          location: null,
          startsAt: "2026-10-24T10:00:30Z",
          endsAt: "2026-10-24T12:00:30Z",
          calledOff: true,
          placesLeft: 4,
        },
      ]);
    });
  });

  describe("meeting", () => {
    it("shows the soonest meeting that has not begun, until it begins", () => {
      const slides = buildRotation({
        now: NOW,
        meetingNotices: [
          notice("held", -HOUR),
          notice("later", 30 * DAY),
          notice("sooner", 10 * DAY, { kind: "extraordinary" }),
        ],
      });

      expect(slides).toHaveLength(1);
      expect(slides[0]?.id).toBe("meeting.sooner");
      expect(slides[0]?.until).toBe("2026-11-02T10:00:30Z");
      expect(body<MeetingBody>(slides, "meeting.sooner")).toMatchObject({
        meetingKind: "extraordinary",
        startsAt: "2026-11-02T10:00:30Z",
      });
    });

    it("builds no slide when every meeting has begun", () => {
      expect(
        buildRotation({ now: NOW, meetingNotices: [notice("held", -1000)] }),
      ).toEqual([]);
    });

    it("keeps the first 40 agenda items, in the order of their positions", () => {
      const slides = buildRotation({
        now: NOW,
        meetingNotices: [
          notice("m1", DAY, {
            agenda: Array.from({ length: 45 }, (_, index) => ({
              position: 45 - index,
              title: `Item ${45 - index}`,
            })),
          }),
        ],
      });
      const { agenda } = body<MeetingBody>(slides, "meeting.m1");

      expect(agenda).toHaveLength(40);
      expect(agenda[0]).toEqual({ position: 1, title: "Item 1" });
      expect(agenda[39]).toEqual({ position: 40, title: "Item 40" });
    });
  });

  describe("availability", () => {
    it("starts at the minute of the fetch and reaches at most 7 days", () => {
      const slides = buildRotation({
        now: NOW,
        availability: {
          from: new Date(NOW.getTime() - DAY),
          to: new Date(NOW.getTime() + 10 * DAY),
          resources: [resource("r1")],
          busy: [],
        },
      });

      expect(body<AvailabilityBody>(slides, "availability")).toMatchObject({
        from: "2026-10-23T10:00:00Z",
        to: "2026-10-30T10:00:00Z",
      });
    });

    it("lists the first twelve resources in the order given", () => {
      const slides = buildRotation({
        now: NOW,
        availability: {
          ...availabilityWindow(NOW, "Europe/Stockholm"),
          resources: Array.from({ length: 14 }, (_, index) =>
            resource(`r${index}`),
          ),
          busy: [],
        },
      });

      expect(
        body<AvailabilityBody>(slides, "availability").resources.map(
          (each) => each.name,
        ),
      ).toEqual(Array.from({ length: 12 }, (_, index) => `Resource r${index}`));
    });

    it("merges, sorts and clips each resource's busy intervals to the window", () => {
      const window = availabilityWindow(NOW, "Europe/Stockholm");
      const slides = buildRotation({
        now: NOW,
        availability: {
          ...window,
          resources: [resource("r1"), resource("r2")],
          busy: [
            { resourceId: "r1", start: at(5 * HOUR), end: at(6 * HOUR) },
            { resourceId: "r1", start: at(-2 * HOUR), end: at(HOUR) },
            { resourceId: "r1", start: at(HOUR), end: at(2 * HOUR) },
            { resourceId: "r1", start: at(5.5 * HOUR), end: at(7 * HOUR) },
            { resourceId: "r1", start: at(3 * DAY), end: at(4 * DAY) },
            { resourceId: "r2", start: at(-3 * HOUR), end: at(-2 * HOUR) },
            { resourceId: "other", start: at(HOUR), end: at(2 * HOUR) },
          ],
        },
      });
      const [first, second] = body<AvailabilityBody>(
        slides,
        "availability",
      ).resources;

      expect(first?.busy).toEqual([
        { start: "2026-10-23T10:00:00Z", end: "2026-10-23T12:00:31Z" },
        { start: "2026-10-23T15:00:30Z", end: "2026-10-23T17:00:31Z" },
      ]);
      expect(second?.busy).toEqual([]);
    });

    it("takes a booking under way from the minute, however late in it the fetch is", () => {
      const build = (now: Date) =>
        buildRotation({
          now,
          availability: {
            ...availabilityWindow(now, "Europe/Stockholm"),
            resources: [resource("r1")],
            // The busy read starts a booking under way at the moment of the call.
            busy: [
              {
                resourceId: "r1",
                start: now.toISOString(),
                end: "2026-10-23T12:00:00.000Z",
              },
            ],
          },
        });

      const early = build(new Date("2026-10-23T10:00:01.250Z"));
      const late = build(new Date("2026-10-23T10:00:58.900Z"));

      expect(late).toEqual(early);
      expect(
        body<AvailabilityBody>(early, "availability").resources[0]?.busy,
      ).toEqual([
        { start: "2026-10-23T10:00:00Z", end: "2026-10-23T12:00:00Z" },
      ]);
    });

    it("takes a booking under way from the minute when the busy read ran after the fetch", () => {
      // The caller's request time is `now`; the busy read ran later, in the
      // same minute, and started the booking at its own clock.
      const build = (readAt: Date) =>
        buildRotation({
          now: NOW,
          availability: {
            ...availabilityWindow(NOW, "Europe/Stockholm"),
            resources: [resource("r1")],
            busy: [
              {
                resourceId: "r1",
                start: readAt.toISOString(),
                end: "2026-10-23T12:00:00.000Z",
              },
            ],
          },
        });

      const early = build(new Date("2026-10-23T10:00:30.400Z"));
      const late = build(new Date("2026-10-23T10:00:59.900Z"));

      expect(late).toEqual(early);
      expect(
        body<AvailabilityBody>(early, "availability").resources[0]?.busy,
      ).toEqual([
        { start: "2026-10-23T10:00:00Z", end: "2026-10-23T12:00:00Z" },
      ]);
    });

    it("keeps the start of a booking that begins after the fetch, to the second", () => {
      const slides = buildRotation({
        now: NOW,
        availability: {
          ...availabilityWindow(NOW, "Europe/Stockholm"),
          resources: [resource("r1")],
          busy: [{ resourceId: "r1", start: at(70_000), end: at(HOUR) }],
        },
      });

      expect(
        body<AvailabilityBody>(slides, "availability").resources[0]?.busy[0]
          ?.start,
      ).toBe("2026-10-23T10:01:40Z");
    });

    it("builds no slide without a resource", () => {
      expect(
        buildRotation({
          now: NOW,
          availability: {
            ...availabilityWindow(NOW, "Europe/Stockholm"),
            resources: [],
            busy: [],
          },
        }),
      ).toEqual([]);
    });
  });
});

describe("availabilityWindow", () => {
  it("runs from the minute of the fetch to the end of the next day", () => {
    // Friday noon in Stockholm, summer time.
    expect(
      availabilityWindow(new Date("2026-10-23T10:00:30Z"), "Europe/Stockholm"),
    ).toEqual({
      from: new Date("2026-10-23T10:00:00Z"),
      to: new Date("2026-10-24T22:00:00Z"),
    });
  });

  it("takes in the extra hour of the day the clocks go back", () => {
    // Saturday noon; Sunday 25 October 2026 has 25 hours.
    const { to } = availabilityWindow(
      new Date("2026-10-24T10:00:00Z"),
      "Europe/Stockholm",
    );

    expect(to).toEqual(new Date("2026-10-25T23:00:00Z"));
  });

  it("leaves out the missing hour of the day the clocks go forward", () => {
    // Saturday noon; Sunday 29 March 2026 has 23 hours.
    const { to } = availabilityWindow(
      new Date("2026-03-28T11:00:00Z"),
      "Europe/Stockholm",
    );

    expect(to).toEqual(new Date("2026-03-29T22:00:00Z"));
  });

  it("counts the day in the association's zone, not UTC's", () => {
    // 23:30 UTC is already Saturday in Stockholm.
    const { to } = availabilityWindow(
      new Date("2026-10-23T23:30:00Z"),
      "Europe/Stockholm",
    );

    expect(to).toEqual(new Date("2026-10-25T23:00:00Z"));
  });
});
