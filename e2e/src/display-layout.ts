/**
 * The fullest slides a screen content document may hold, and what a browser
 * shows of them (docs/screen-content-contract.md).
 *
 * Every limit the contract sets on a slide is reached here: eight events with
 * the longest texts, an agenda of forty items, twelve resources busy all
 * through both days, a news item of two thousand characters, and for the
 * signage module's addons, sixty table rows and a hundred and twenty doors.
 * Beside them, a news item of fifty short paragraphs and one of a paragraph of
 * a hundred lines, too tall for a canvas even at the smallest a slide is set.
 * Made-up words throughout, naming nobody.
 */

/** The instant the page's clock is set to: Friday 23 October 2026, 10:00 in Stockholm. */
export const LAYOUT_NOW = "2026-10-23T08:00:00Z";

/** How long each slide, and so each of its pages, stays. */
export const LAYOUT_SECONDS = 5;

const WORDS = [
  "tvättstuga",
  "gården",
  "cykelrummet",
  "föreningslokalen",
  "trapphuset",
  "soprummet",
  "styrelsen",
  "vårstädning",
  "nycklar",
  "portkod",
  "ventilation",
  "stammar",
];

/** Words up to `length` characters, ending with "…" as the route shortens a text. */
function words(length: number, seed = 0): string {
  let text = "";
  for (let index = seed; text.length < length; index += 1) {
    text += `${text === "" ? "" : " "}${WORDS[index % WORDS.length]}`;
  }
  return `${text.slice(0, length - 1).trimEnd()}…`;
}

/** An instant `hours` after `LAYOUT_NOW`, written as the contract writes one: to the second. */
function at(hours: number): string {
  return new Date(Date.parse(LAYOUT_NOW) + hours * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function slide(
  id: string,
  source: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    seconds: LAYOUT_SECONDS,
    until: null,
    source,
    addon: source === "addon" ? "signage-example" : null,
    body,
  };
}

/** Fifty short paragraphs, 441 characters together. */
const PARAGRAPHS = Array.from(
  { length: 50 },
  (_, index) => `Stycke ${index + 1}`,
);

/** One paragraph of a hundred lines, each ended by a line break. */
const LINES = Array.from(
  { length: 100 },
  (_, index) => `Rad ${index + 1}`,
).join("\n");

function occurrences(longest: boolean): Record<string, unknown>[] {
  return Array.from({ length: 8 }, (_, index) => ({
    title: longest ? words(200, index) : `Evenemang ${index + 1}`,
    description: longest ? words(500, index + 3) : null,
    location: longest ? words(200, index + 6) : "Föreningslokalen",
    startsAt: at(24 * (index + 1)),
    endsAt: at(24 * (index + 1) + 3),
    calledOff: index === 2,
    placesLeft: index % 3 === 0 ? 12 : null,
  }));
}

/** Every slide kind, as full as the contract lets it be. */
export const FULLEST_SLIDES: readonly {
  name: string;
  slide: Record<string, unknown>;
  /** Texts of the slide, each to be read whole across its pages. */
  texts?: readonly string[];
}[] = [
  {
    name: "eight short events",
    slide: slide("events", "events", {
      kind: "events",
      occurrences: occurrences(false),
    }),
  },
  {
    name: "eight events with the longest texts",
    slide: slide("events", "events", {
      kind: "events",
      occurrences: occurrences(true),
    }),
  },
  {
    name: "a news item of the longest text",
    slide: slide("news.longest", "news", {
      kind: "news",
      title: words(200),
      paragraphs: [words(700, 1), words(700, 2), words(600, 3)],
      picture: null,
      publishedAt: at(-24),
    }),
  },
  {
    name: "a news item of fifty paragraphs",
    slide: slide("news.paragraphs", "news", {
      kind: "news",
      title: "Femtio stycken",
      paragraphs: PARAGRAPHS,
      picture: null,
      publishedAt: at(-24),
    }),
    texts: [PARAGRAPHS.join(" ")],
  },
  {
    name: "a news item of a hundred lines",
    slide: slide("news.lines", "news", {
      kind: "news",
      title: "Hundra rader",
      paragraphs: [LINES],
      picture: null,
      publishedAt: at(-24),
    }),
    texts: [LINES],
  },
  {
    name: "a meeting with forty agenda items",
    slide: slide("meeting.longest", "meeting", {
      kind: "meeting",
      meetingKind: "ordinary",
      startsAt: at(24 * 20),
      place: words(200, 4),
      digitalParticipation: words(500, 5),
      agenda: Array.from({ length: 40 }, (_, index) => ({
        position: index + 1,
        title: words(index % 4 === 0 ? 200 : 40, index),
      })),
    }),
  },
  {
    name: "twelve resources busy through both days",
    slide: slide("availability", "availability", {
      kind: "availability",
      from: LAYOUT_NOW,
      to: at(38),
      resources: Array.from({ length: 12 }, (_, index) => ({
        name: words(80, index),
        mode: "timeSlots",
        slotMinutes: 60,
        opensAtMinute: 0,
        closesAtMinute: 1440,
        // An hour busy and an hour free, from now to the end of tomorrow.
        busy: Array.from({ length: 19 }, (_, slot) => ({
          start: at(slot * 2),
          end: at(slot * 2 + 1),
        })),
      })),
    }),
  },
  {
    name: "an addon's text of the longest body",
    slide: slide("addon.text", "addon", {
      kind: "text",
      heading: words(80),
      body: [words(1000, 1), words(1000, 2)],
    }),
  },
  {
    name: "an addon's table of sixty rows",
    slide: slide("addon.table", "addon", {
      kind: "table",
      heading: "Sophämtning",
      columns: ["Slag", "Dag", "Plats", "Anmärkning"],
      rows: Array.from({ length: 60 }, (_, index) => [
        words(20, index),
        words(12, index + 1),
        words(30, index + 2),
        words(60, index + 3),
      ]),
    }),
  },
  {
    name: "an addon's hundred and twenty doors",
    slide: slide("addon.doors", "addon", {
      kind: "doors",
      heading: "Port A",
      doors: Array.from({ length: 120 }, (_, index) => ({
        floor: Math.floor(index / 10),
        apartment: String(1001 + index),
        names: [words(24, index), words(24, index + 5)],
      })),
    }),
  },
];

/** A document holding the one slide, as the content route would answer it. */
export function layoutDocument(
  oneSlide: Record<string, unknown>,
  orientation: 0 | 90 | 180 | 270 = 0,
): Record<string, unknown> {
  return {
    version: 1,
    screenId: "layout",
    generatedAt: LAYOUT_NOW,
    refreshSeconds: 60,
    locale: "sv",
    timeZone: "Europe/Stockholm",
    releaseChannel: "stable",
    layout: { orientation, header: "clock", theme: "dark" },
    schedule: { on: [] },
    rotation: [oneSlide],
  };
}

/** What the slide on screen shows, measured in the page. */
export interface SlideMeasure {
  /** The items of the slide's paged list, if it has one. */
  items: number;
  /** The indexes of those items on screen now. */
  shown: number[];
  /** Every box on screen that is not wholly inside the box clipping it. */
  outside: string[];
  /** Every box on screen that clips its own content and holds more than it shows. */
  clipped: string[];
  /** The text on screen, its spaces and line breaks each made one space. */
  text: string;
  /** The slide's size, as a share of the canvas's. */
  scale: number;
}

/**
 * Measures the slide on screen. Run in the page with `page.evaluate`, so it
 * names nothing outside itself.
 */
export function measureSlide(): SlideMeasure | null {
  const stage = document.querySelector(".obrf-display-stage");
  const slide = stage?.querySelector<HTMLElement>(".obrf-display-slide");
  const root = document.querySelector<HTMLElement>(".obrf-display");
  if (stage == null || slide == null || root === null) {
    return null;
  }
  const stageBox = stage.getBoundingClientRect();
  const inside = (box: DOMRect, clip: DOMRect) =>
    box.top >= clip.top - 1 &&
    box.bottom <= clip.bottom + 1 &&
    box.left >= clip.left - 1 &&
    box.right <= clip.right + 1;
  const items = Array.from(
    slide.querySelectorAll<HTMLElement>("[data-obrf-display-paged] > *"),
  );
  const outside: string[] = [];
  const clipped: string[] = [];
  const name = (node: HTMLElement) =>
    `${node.tagName.toLowerCase()}.${node.className} "${(node.textContent ?? "").slice(0, 30)}"`;
  for (const node of [
    slide,
    ...Array.from(slide.querySelectorAll<HTMLElement>("*")),
  ]) {
    const box = node.getBoundingClientRect();
    if (!node.checkVisibility() || (box.width === 0 && box.height === 0)) {
      continue;
    }
    // A box that clips what it holds, such as a text cut to a number of
    // lines, hides the rest inside itself, where no box is outside another.
    const style = getComputedStyle(node);
    if (
      (style.overflowX !== "visible" &&
        node.scrollWidth > node.clientWidth + 1) ||
      (style.overflowY !== "visible" &&
        node.scrollHeight > node.clientHeight + 1)
    ) {
      clipped.push(name(node));
    }
    if (node === slide) {
      continue;
    }
    const copy = node.parentElement?.closest(".obrf-display-copy");
    if (
      !inside(box, stageBox) ||
      (copy != null && !inside(box, copy.getBoundingClientRect()))
    ) {
      outside.push(name(node));
    }
  }
  const unit = (element: Element) =>
    Number.parseFloat(
      getComputedStyle(element).getPropertyValue("--obrf-display-u"),
    );
  return {
    items: items.length,
    shown: items.flatMap((item, index) =>
      item.checkVisibility() ? [index] : [],
    ),
    outside,
    clipped,
    text: slide.innerText.replace(/\s+/g, " ").trim(),
    scale: unit(slide) / unit(root),
  };
}
