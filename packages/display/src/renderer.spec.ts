// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  addonSlides,
  availabilitySlide,
  eventsSlide,
  meetingSlide,
  newsSlide,
  pictureSlide,
  screenContent,
} from "../test/fixtures.ts";
import type { NewsBody, PictureRef, Slide } from "./contract.ts";
import {
  mountRenderer,
  type DisplayRenderer,
  type RendererOptions,
} from "./renderer.ts";

// Friday 23 October 2026, 12:00 in Stockholm.
const NOW = new Date("2026-10-23T10:00:00Z");

let host: HTMLElement;
let renderer: DisplayRenderer | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  renderer?.destroy();
  renderer = null;
  host.remove();
  vi.useRealTimers();
});

function mount(options?: RendererOptions): DisplayRenderer {
  renderer = mountRenderer(host, options);
  return renderer;
}

function part(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`Nothing matches ${selector}`);
  }
  return found;
}

const stage = () => part(".obrf-display-stage");
const shownTitle = () =>
  stage().querySelector(".obrf-display-heading")?.textContent ?? null;

function withNews(slide: Slide, change: Partial<NewsBody>): Slide {
  return { ...slide, body: { ...(slide.body as NewsBody), ...change } };
}

describe("the renderer", () => {
  it("shows a news item's text as text, and never reads it as markup", () => {
    const title = '<img src=x onerror="alert(1)">';
    mount().show(
      screenContent([
        withNews(newsSlide("news.1"), {
          title,
          paragraphs: ["<b>Bold?</b>", "Second paragraph"],
        }),
      ]),
    );

    expect(shownTitle()).toBe(title);
    expect(stage().textContent).toContain("<b>Bold?</b>");
    expect(stage().querySelector("img")).toBeNull();
    expect(stage().querySelector("b")).toBeNull();
  });

  it("lists coming events with their times in the association's zone", () => {
    mount().show(screenContent([eventsSlide()]));
    const text = stage().textContent;

    expect(shownTitle()).toBe("Coming events");
    expect(text).toContain("Cleaning day");
    expect(text).toContain("10:00–13:00");
    expect(text).toContain("The courtyard");
    expect(text).toContain("3 places left");
    expect(text).toContain("Called off");
    expect(text).toContain("Fully booked");
  });

  it("speaks the document's language", () => {
    mount().show(screenContent([eventsSlide()], { locale: "sv" }));
    const text = stage().textContent;

    expect(shownTitle()).toBe("Kommande evenemang");
    expect(text).toContain("3 platser kvar");
    expect(text).toContain("Inställt");
    expect(text).toContain("Fullbokat");
    expect(part(".obrf-display").lang).toBe("sv");
  });

  it("shows the notice of a general meeting", () => {
    const view = mount();
    view.show(screenContent([meetingSlide()]));
    const text = stage().textContent;

    expect(shownTitle()).toBe("Ordinary general meeting");
    expect(text).toContain("When");
    expect(text).toContain("18:30");
    expect(text).toContain("The common room");
    expect(text).toContain("Taking part digitally");
    expect(text).toContain("Agenda");
    expect(text).toContain("Election of a chair");

    const slide = meetingSlide();
    view.show(
      screenContent(
        [
          {
            ...slide,
            body: { ...(slide.body as object), meetingKind: "extraordinary" },
          } as Slide,
        ],
        { locale: "sv" },
      ),
    );
    expect(shownTitle()).toBe("Extra föreningsstämma");
  });

  it("shows when each resource is busy today and tomorrow", () => {
    mount().show(screenContent([availabilitySlide()]));
    const text = stage().textContent;

    expect(shownTitle()).toBe("Free and busy");
    expect(text).toContain("Laundry room");
    expect(text).toContain("Today");
    expect(text).toContain("14:00–16:00");
    expect(text).toContain("Tomorrow");
    expect(text).toContain("Free all day");
  });

  it("drops a busy period from the slide once it has passed", () => {
    mount().show(screenContent([availabilitySlide()]));

    vi.advanceTimersByTime(4 * 60 * 60 * 1000);

    expect(stage().textContent).not.toContain("14:00–16:00");
    expect(stage().textContent).toContain("Free for the rest of the day");
  });

  it("shows the addons' text, table and doors", () => {
    const view = mount();
    const [text, table, doors] = addonSlides() as [Slide, Slide, Slide];

    view.show(screenContent([text]));
    expect(shownTitle()).toBe("Welcome");
    expect(stage().textContent).toContain("Shoes off, please.");

    view.show(screenContent([table]));
    expect(
      [...stage().querySelectorAll("th")].map((cell) => cell.textContent),
    ).toEqual(["Kind", "Day"]);
    expect(stage().querySelectorAll("tbody tr")).toHaveLength(2);

    view.show(screenContent([doors]));
    expect(stage().textContent).toContain("1201");
    expect(stage().textContent).toContain("Floor 2");
    expect(stage().textContent).toContain("Andersson");
  });

  describe("pictures", () => {
    it("skips a picture slide when there is no way to get the picture", () => {
      mount().show(
        screenContent([pictureSlide("picture.1"), newsSlide("news.1")]),
      );

      expect(shownTitle()).toBe("Title of news.1");
    });

    it("shows a picture slide with the URL the caller hands back", async () => {
      const picture = vi.fn(
        async (ref: PictureRef) => `blob:${ref.mediaFileId}`,
      );
      mount({ picture }).show(screenContent([pictureSlide("picture.1")]));
      await vi.advanceTimersByTimeAsync(0);

      const img = stage().querySelector("img");
      expect(img?.getAttribute("src")).toBe("blob:file-picture.1");
      expect(img?.alt).toBe("The courtyard in autumn");
      expect(stage().textContent).toContain("Autumn in the courtyard");
    });

    it("shows a news item without its picture when the picture cannot be had", async () => {
      const ref = (pictureSlide("p").body as { picture: PictureRef }).picture;
      mount({ picture: () => Promise.reject(new Error("404")) }).show(
        screenContent([withNews(newsSlide("news.1"), { picture: ref })]),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(shownTitle()).toBe("Title of news.1");
      expect(stage().querySelector("img")).toBeNull();
    });

    it("adds a news item's picture when it arrives", async () => {
      const ref = (pictureSlide("p").body as { picture: PictureRef }).picture;
      mount({ picture: async () => "blob:news" }).show(
        screenContent([withNews(newsSlide("news.1"), { picture: ref })]),
      );
      expect(stage().querySelector("img")).toBeNull();

      await vi.advanceTimersByTimeAsync(0);

      expect(stage().querySelector("img")?.getAttribute("src")).toBe(
        "blob:news",
      );
      expect(shownTitle()).toBe("Title of news.1");
    });

    it("asks once for each picture and version, and lets go of one no longer shown", async () => {
      const picture = vi.fn(
        async (ref: PictureRef) => `blob:${ref.mediaFileId}`,
      );
      const releasePicture = vi.fn();
      const view = mount({ picture, releasePicture });
      const document = screenContent([pictureSlide("picture.1")]);

      view.show(document);
      await vi.advanceTimersByTimeAsync(0);
      view.show(structuredClone(document));
      await vi.advanceTimersByTimeAsync(0);
      expect(picture).toHaveBeenCalledTimes(1);

      view.show(screenContent([newsSlide("news.1")]));
      expect(releasePicture).toHaveBeenCalledWith(
        "blob:file-picture.1",
        expect.objectContaining({ mediaFileId: "file-picture.1" }),
      );
    });
  });

  describe("the rotation", () => {
    it("shows each slide for its seconds, and loops", () => {
      mount().show(
        screenContent([
          newsSlide("news.1"),
          newsSlide("news.2", { seconds: 30 }),
        ]),
      );
      expect(shownTitle()).toBe("Title of news.1");

      vi.advanceTimersByTime(14_999);
      expect(shownTitle()).toBe("Title of news.1");
      vi.advanceTimersByTime(1);
      expect(shownTitle()).toBe("Title of news.2");
      vi.advanceTimersByTime(30_000);
      expect(shownTitle()).toBe("Title of news.1");
    });

    it("leaves a slide at its until, without waiting for its seconds or a fetch", () => {
      mount().show(
        screenContent([
          newsSlide("news.1", { until: "2026-10-23T10:00:05Z" }),
          newsSlide("news.2"),
        ]),
      );

      vi.advanceTimersByTime(5_000);
      expect(shownTitle()).toBe("Title of news.2");
      vi.advanceTimersByTime(15_000);
      expect(shownTitle()).toBe("Title of news.2");
    });

    it("never shows a slide whose until has passed", () => {
      mount().show(
        screenContent([
          newsSlide("news.old", { until: "2026-10-23T09:59:59Z" }),
          newsSlide("news.2"),
        ]),
      );

      expect(shownTitle()).toBe("Title of news.2");
    });

    it("goes on with the slide on screen when a new document still has it", () => {
      const view = mount();
      view.show(screenContent([newsSlide("news.1"), newsSlide("news.2")]));
      vi.advanceTimersByTime(20_000);
      expect(shownTitle()).toBe("Title of news.2");

      view.show(
        screenContent([
          newsSlide("news.1"),
          withNews(newsSlide("news.2"), { title: "Corrected" }),
        ]),
      );
      expect(shownTitle()).toBe("Corrected");

      // news.2 came on at 15 s and still leaves at 30 s.
      vi.advanceTimersByTime(10_000);
      expect(shownTitle()).toBe("Title of news.1");
    });

    it("starts from the first slide when the one on screen is gone", () => {
      const view = mount();
      view.show(screenContent([newsSlide("news.1"), newsSlide("news.2")]));
      vi.advanceTimersByTime(15_000);

      view.show(screenContent([newsSlide("news.3"), newsSlide("news.1")]));

      expect(shownTitle()).toBe("Title of news.3");
    });
  });

  describe("a slide fuller than the canvas", () => {
    // jsdom lays nothing out, so the page's measurements are made up here: a
    // canvas of 1920 by 1080 pixels whose slide holds 1 000 pixels, an event
    // row 300 of them and the rest of the slide 100.
    let measured: { mockRestore(): void }[] = [];

    function layOut(slideHeight: (slide: HTMLElement) => number): void {
      for (const side of ["clientWidth", "clientHeight"] as const) {
        Object.defineProperty(host, side, {
          configurable: true,
          value: side === "clientWidth" ? 1920 : 1080,
        });
      }
      const isSlide = (node: Element): node is HTMLElement =>
        node.classList.contains("obrf-display-slide");
      measured = [
        vi
          .spyOn(Element.prototype, "clientHeight", "get")
          .mockImplementation(function (this: Element) {
            return isSlide(this) ? 1000 : 0;
          }),
        vi
          .spyOn(Element.prototype, "scrollHeight", "get")
          .mockImplementation(function (this: Element) {
            return isSlide(this) ? slideHeight(this) : 0;
          }),
      ];
    }

    afterEach(() => {
      for (const spy of measured) {
        spy.mockRestore();
      }
      measured = [];
    });

    function eightEvents(): Slide {
      const slide = eventsSlide();
      return {
        ...slide,
        body: {
          kind: "events",
          occurrences: Array.from({ length: 8 }, (_, index) => ({
            title: `Event ${index + 1}`,
            description: null,
            location: null,
            startsAt: `2026-10-${24 + index}T08:00:00Z`,
            endsAt: `2026-10-${24 + index}T09:00:00Z`,
            calledOff: false,
            placesLeft: null,
          })),
        },
      };
    }

    const shownEvents = () =>
      Array.from(
        stage().querySelectorAll<HTMLElement>(".obrf-display-event"),
      ).flatMap((row) =>
        row.hidden
          ? []
          : [row.querySelector(".obrf-display-title")?.textContent],
      );

    const rowsHigh = (slide: HTMLElement) =>
      100 +
      300 *
        Array.from(
          slide.querySelectorAll<HTMLElement>(".obrf-display-event"),
        ).filter((row) => !row.hidden).length;

    it("shows a list a page at a time, each page for the slide's seconds, and then the next slide", () => {
      layOut(rowsHigh);
      mount().show(screenContent([eightEvents(), newsSlide("news.1")]));

      expect(shownEvents()).toEqual(["Event 1", "Event 2", "Event 3"]);
      vi.advanceTimersByTime(20_000);
      expect(shownEvents()).toEqual(["Event 4", "Event 5", "Event 6"]);
      expect(
        stage()
          .querySelector(".obrf-display-slide")
          ?.classList.contains("obrf-display-slide--enter"),
      ).toBe(true);
      vi.advanceTimersByTime(20_000);
      expect(shownEvents()).toEqual(["Event 7", "Event 8"]);
      vi.advanceTimersByTime(20_000);
      expect(shownTitle()).toBe("Title of news.1");
      vi.advanceTimersByTime(15_000);
      expect(shownEvents()).toEqual(["Event 1", "Event 2", "Event 3"]);
    });

    it("keeps the page on screen when a fetch brings the same slide", () => {
      layOut(rowsHigh);
      const view = mount();
      view.show(screenContent([eightEvents()]));
      vi.advanceTimersByTime(20_000);

      view.show(screenContent([eightEvents()]));

      expect(shownEvents()).toEqual(["Event 4", "Event 5", "Event 6"]);
    });

    it("sets a slide without a list smaller until it fits", () => {
      // 1 500 pixels at full size: it fits at two thirds of it.
      layOut((slide) => {
        const set = slide.style.getPropertyValue("--obrf-display-u");
        return set === "" ? 1500 : (1500 * Number.parseFloat(set)) / 10.8;
      });
      mount().show(screenContent([newsSlide("news.long")]));

      const slide = part(".obrf-display-slide");
      expect(
        Number.parseFloat(slide.style.getPropertyValue("--obrf-display-u")),
      ).toBeCloseTo(10.8 * 0.65);
    });

    // A line of text 100 pixels high at full size, and a slide of nothing else.
    const linesHigh = (slide: HTMLElement) => {
      const set = slide.style.getPropertyValue("--obrf-display-u");
      const scale = set === "" ? 1 : Number.parseFloat(set) / 10.8;
      const lines = shownTexts(slide).reduce(
        (sum, text) => sum + (text === "" ? 0 : text.split("\n").length),
        0,
      );
      return 100 * lines * scale;
    };

    const shownTexts = (slide: Element) =>
      Array.from(
        slide.querySelectorAll(
          ".obrf-display-date, .obrf-display-heading, .obrf-display-text",
        ),
      ).flatMap((text) =>
        text.closest("[data-obrf-display-elsewhere]") === null
          ? [text.textContent ?? ""]
          : [],
      );

    /** The paragraphs on each page of the slide, until the next slide. */
    function pagesOfParagraphs(): string[][] {
      const pages: string[][] = [];
      while (shownTitle() !== "Title of news.2" && pages.length < 20) {
        pages.push(
          shownTexts(part(".obrf-display-slide")).filter(
            (_, index) => index >= (pages.length === 0 ? 2 : 0),
          ),
        );
        vi.advanceTimersByTime(15_000);
      }
      return pages;
    }

    it("goes on with a text on the next page when it is too tall even at its smallest", () => {
      // Sixteen lines a page at three fifths of the size: the date and the
      // title, then fourteen paragraphs, and sixteen on each page after.
      layOut(linesHigh);
      const paragraphs = Array.from(
        { length: 50 },
        (_, index) => `Stycke ${index + 1}`,
      );
      mount().show(
        screenContent([
          withNews(newsSlide("news.long"), { paragraphs }),
          newsSlide("news.2"),
        ]),
      );

      expect(
        Number.parseFloat(
          part(".obrf-display-slide").style.getPropertyValue(
            "--obrf-display-u",
          ),
        ),
      ).toBeCloseTo(10.8 * 0.6);
      const pages = pagesOfParagraphs();
      expect(pages.map((page) => page.length)).toEqual([14, 16, 16, 4]);
      expect(pages.flat()).toEqual(paragraphs);
      expect(shownTitle()).toBe("Title of news.2");
    });

    it("breaks a paragraph of many lines between two of them", () => {
      layOut(linesHigh);
      const lines = Array.from(
        { length: 100 },
        (_, index) => `Rad ${index + 1}`,
      );
      mount().show(
        screenContent([
          withNews(newsSlide("news.long"), { paragraphs: [lines.join("\n")] }),
          newsSlide("news.2"),
        ]),
      );

      const pages = pagesOfParagraphs();
      expect(pages.map((page) => page.join("").split("\n").length)).toEqual([
        14, 16, 16, 16, 16, 16, 6,
      ]);
      expect(pages.map((page) => page.join("")).join("\n")).toBe(
        lines.join("\n"),
      );
    });
  });

  describe("the layout", () => {
    it("shows black outside every window of the schedule", () => {
      mount().show(
        screenContent([newsSlide("news.1")], {
          // Fridays from 13:00 Stockholm time; it is 12:00.
          schedule: { on: [{ days: [5], from: "13:00", to: "14:00" }] },
        }),
      );
      expect(part(".obrf-display-off").hidden).toBe(false);

      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(part(".obrf-display-off").hidden).toBe(true);

      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(part(".obrf-display-off").hidden).toBe(false);
    });

    it("says quietly that there is nothing to show when no slide can be shown", () => {
      mount().show(screenContent([], { locale: "sv" }));

      expect(part(".obrf-display-empty").textContent).toBe(
        "Inget att visa just nu",
      );
    });

    it("shows the rotation always with an empty schedule", () => {
      mount().show(screenContent([newsSlide("news.1")]));

      expect(part(".obrf-display-off").hidden).toBe(true);
    });

    it("shows the clock band only when the layout asks for it, and keeps it to the minute", () => {
      const view = mount();
      view.show(screenContent([newsSlide("news.1")]));
      expect(part(".obrf-display-clock").hidden).toBe(true);

      view.show(
        screenContent([newsSlide("news.1")], {
          layout: { orientation: 0, header: "clock", theme: "dark" },
        }),
      );
      expect(part(".obrf-display-clock").hidden).toBe(false);
      expect(part(".obrf-display-clock-time").textContent).toBe("12:00");
      expect(part(".obrf-display-clock-date").textContent).toBe(
        "Friday 23 October",
      );

      vi.advanceTimersByTime(60_000);
      expect(part(".obrf-display-clock-time").textContent).toBe("12:01");
    });

    it("writes the date in Swedish on a Swedish screen", () => {
      mount().show(
        screenContent([newsSlide("news.1")], {
          locale: "sv",
          layout: { orientation: 0, header: "clock", theme: "dark" },
        }),
      );

      expect(part(".obrf-display-clock-date").textContent).toBe(
        "Fredag 23 oktober",
      );
    });

    it("turns the canvas by the orientation, and takes the theme", () => {
      mount().show(
        screenContent([newsSlide("news.1")], {
          layout: { orientation: 90, header: "none", theme: "light" },
        }),
      );
      const root = part(".obrf-display");

      expect(part(".obrf-display-canvas").style.transform).toContain(
        "rotate(90deg)",
      );
      expect(root.classList.contains("obrf-display--orientation-90")).toBe(
        true,
      );
      expect(root.classList.contains("obrf-display--light")).toBe(true);
      expect(root.classList.contains("obrf-display--dark")).toBe(false);
    });

    it("says when the content was fetched while it is stale", () => {
      const view = mount();
      view.show(screenContent([newsSlide("news.1")]), {
        fetchedAt: new Date("2026-10-23T09:50:00Z"),
        stale: true,
      });
      expect(part(".obrf-display-note").textContent).toBe("Last updated 11:50");
      expect(part(".obrf-display-note").hidden).toBe(false);

      view.show(screenContent([newsSlide("news.1")]), {
        fetchedAt: NOW,
        stale: false,
      });
      expect(part(".obrf-display-note").hidden).toBe(true);
    });

    it("sets the time of stale content in the data face, with its date from another day", () => {
      mount().show(screenContent([newsSlide("news.1")], { locale: "sv" }), {
        fetchedAt: new Date("2026-10-22T09:00:00Z"),
        stale: true,
      });

      expect(part(".obrf-display-note").textContent).toBe(
        "Senast uppdaterad 22 oktober 11:00",
      );
      expect(part(".obrf-display-note .obrf-display-data").textContent).toBe(
        "22 oktober 11:00",
      );
    });

    it("adds its stylesheet to the document once, with motion off for those who ask", () => {
      mount();
      mountRenderer(document.createElement("div")).destroy();
      const sheets = document.head.querySelectorAll("style[data-obrf-display]");

      expect(sheets).toHaveLength(1);
      expect(sheets[0]?.textContent).toContain("prefers-reduced-motion");
    });
  });

  describe("messages", () => {
    it("says the display link is no longer valid, and shows nothing of the content", () => {
      const view = mount();
      view.show(screenContent([newsSlide("news.1")]));

      view.message("link-invalid", "sv");

      expect(stage().textContent).toContain(
        "Visningslänken gäller inte längre",
      );
      expect(stage().textContent).not.toContain("news.1");
      vi.advanceTimersByTime(60_000);
      expect(stage().textContent).not.toContain("news.1");
    });

    it.each([
      ["loading", "Loading"],
      ["not-connected", "Not connected"],
      ["link-missing", "The display link is not complete"],
      ["paused", "The screen is paused"],
    ] as const)("says %s in English", (kind, words) => {
      mount().message(kind, "en");

      expect(stage().textContent).toContain(words);
    });
  });

  it("clears every timer and the element when destroyed", async () => {
    const releasePicture = vi.fn();
    const view = mountRenderer(host, {
      picture: async () => "blob:x",
      releasePicture,
    });
    view.show(
      screenContent([newsSlide("news.1"), pictureSlide("picture.1")], {
        layout: { orientation: 0, header: "clock", theme: "dark" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.destroy();

    expect(vi.getTimerCount()).toBe(0);
    expect(host.childNodes).toHaveLength(0);
    expect(releasePicture).toHaveBeenCalledWith("blob:x", expect.anything());
  });
});
