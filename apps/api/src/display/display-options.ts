import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * How one screen shows the display mode: the options its display link carries
 * (ADR 0050, "Configured at the screen").
 *
 * The display page sends its own query, unchanged, as the query of its
 * content request, so these are read from the request and kept nowhere on the
 * instance. A value this does not know is refused, so a link written by hand
 * with a typing mistake shows the board an error on the screen instead of a
 * rotation it did not ask for. A parameter it does not know is left alone: the
 * page's address may carry more than the display mode reads.
 */

/** The sources the display mode can show, in the order the rotation holds them. */
export const DISPLAY_SOURCES = [
  "news",
  "events",
  "meeting",
  "availability",
] as const;

export type DisplaySource = (typeof DISPLAY_SOURCES)[number];

/** The most bookable resources one screen shows. */
export const MAX_DISPLAY_RESOURCES = 12;

const ORIENTATIONS = { "0": 0, "90": 90, "180": 180, "270": 270 } as const;
const HEADERS = ["none", "clock"] as const;
const THEMES = ["light", "dark"] as const;
const LOCALES = ["sv", "en"] as const;

export type DisplayLocale = (typeof LOCALES)[number];

export interface DisplayOptions {
  sources: readonly DisplaySource[];
  /** The resources the board chose, in its order, or null for the default. */
  resources: readonly string[] | null;
  orientation: 0 | 90 | 180 | 270;
  header: (typeof HEADERS)[number];
  theme: (typeof THEMES)[number];
  /** Null for the instance's default language. */
  locale: DisplayLocale | null;
}

/** A display link's option that the display mode does not know. */
export class DisplayOptionsInvalidError extends DomainError {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly reason = "display-options-invalid";

  constructor(private readonly option: string) {
    super(
      `The display link's "${option}" is not one the display mode knows. Compose the link again on the display screen.`,
    );
  }

  /** Which option, by its name in the link; never the value given. */
  override details(): Record<string, readonly unknown[]> {
    return { options: [this.option] };
  }
}

/** What a resource id in a display link may look like: the ids the core issues. */
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The options in a content request's query, as Fastify parsed it.
 *
 * A parameter given twice is refused, because which of the two the screen
 * meant cannot be told.
 */
export function readDisplayOptions(
  query: Readonly<Record<string, unknown>>,
): DisplayOptions {
  return {
    sources: readSources(single(query, "sources")),
    resources: readResources(single(query, "resources")),
    orientation: readOrientation(single(query, "orientation")),
    header: oneOf(single(query, "header"), "header", HEADERS) ?? "clock",
    theme: oneOf(single(query, "theme"), "theme", THEMES) ?? "dark",
    locale: oneOf(single(query, "locale"), "locale", LOCALES),
  };
}

function single(
  query: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = query[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DisplayOptionsInvalidError(name);
  }
  return value;
}

function readSources(value: string | undefined): readonly DisplaySource[] {
  if (value === undefined) {
    return DISPLAY_SOURCES;
  }
  const named = commaList(value);
  if (
    named.length === 0 ||
    !named.every((source) =>
      (DISPLAY_SOURCES as readonly string[]).includes(source),
    )
  ) {
    throw new DisplayOptionsInvalidError("sources");
  }
  // The rotation's own order, whatever order the link names them in.
  return DISPLAY_SOURCES.filter((source) => named.includes(source));
}

function readResources(value: string | undefined): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  const ids = [...new Set(commaList(value))];
  if (
    ids.length === 0 ||
    ids.length > MAX_DISPLAY_RESOURCES ||
    !ids.every((id) => RESOURCE_ID.test(id))
  ) {
    throw new DisplayOptionsInvalidError("resources");
  }
  return ids;
}

function readOrientation(value: string | undefined): 0 | 90 | 180 | 270 {
  if (value === undefined) {
    return 0;
  }
  if (!Object.hasOwn(ORIENTATIONS, value)) {
    throw new DisplayOptionsInvalidError("orientation");
  }
  return ORIENTATIONS[value as keyof typeof ORIENTATIONS];
}

function oneOf<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | null {
  if (value === undefined) {
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new DisplayOptionsInvalidError(name);
  }
  return value as T;
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
