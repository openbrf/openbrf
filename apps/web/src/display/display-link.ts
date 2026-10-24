import { APP_BASE_PATH } from "../routes/authorization-request";

/**
 * Composing a display link from the board's choices (ADR 0050, "Configured at
 * the screen").
 *
 * The link is where a screen's choices live: the instance keeps none of them,
 * so the display screen writes each into the link's query and the token into
 * its fragment, which no browser sends to a server and so no request log
 * holds. A choice left at its default is not written, which keeps the link,
 * and the QR code made from it, as short as it can be.
 */

/** The sources the display mode can show, in the order its rotation holds them. */
export const DISPLAY_SOURCES = [
  "news",
  "events",
  "meeting",
  "availability",
] as const;

export type DisplaySource = (typeof DISPLAY_SOURCES)[number];

/** The most bookable resources one screen shows. */
export const MAX_DISPLAY_RESOURCES = 12;

export interface DisplayChoices {
  /** At least one; all four is the default. */
  sources: readonly DisplaySource[];
  /** The chosen resources in order, or empty for every open one, the first twelve. */
  resources: readonly string[];
  orientation: 0 | 90 | 180 | 270;
  header: "none" | "clock";
  theme: "light" | "dark";
  /** Null for the instance's default language. */
  locale: "sv" | "en" | null;
}

export const DEFAULT_CHOICES: DisplayChoices = {
  sources: DISPLAY_SOURCES,
  resources: [],
  orientation: 0,
  header: "clock",
  theme: "dark",
  locale: null,
};

/** The path of the display page, inside the web application. */
export const DISPLAY_PAGE_PATH = "/display";

/**
 * The display link for a token and the board's choices, on `origin`.
 *
 * The query names only what differs from the display mode's defaults, in the
 * order the options table of ADR 0050 lists them. The resources are written
 * only while availability is among the sources: without it they choose
 * nothing.
 */
export function displayLink(
  origin: string,
  token: string,
  choices: DisplayChoices,
): string {
  const query = new URLSearchParams();
  const sources = DISPLAY_SOURCES.filter((source) =>
    choices.sources.includes(source),
  );
  if (sources.length < DISPLAY_SOURCES.length) {
    query.set("sources", sources.join(","));
  }
  if (sources.includes("availability") && choices.resources.length > 0) {
    query.set(
      "resources",
      choices.resources.slice(0, MAX_DISPLAY_RESOURCES).join(","),
    );
  }
  if (choices.orientation !== 0) {
    query.set("orientation", String(choices.orientation));
  }
  if (choices.header !== "clock") {
    query.set("header", choices.header);
  }
  if (choices.theme !== "dark") {
    query.set("theme", choices.theme);
  }
  if (choices.locale !== null) {
    query.set("locale", choices.locale);
  }
  // The commas are left as they are: a comma is allowed in a query, and a
  // link a board member may read aloud or type is clearer without %2C.
  const search = query.toString().replaceAll("%2C", ",");
  const url = new URL(`${APP_BASE_PATH}${DISPLAY_PAGE_PATH}`, origin);
  return `${url.toString()}${search === "" ? "" : `?${search}`}#${token}`;
}
