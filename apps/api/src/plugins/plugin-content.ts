import type { PluginContentAudience } from "@openbrf/plugin-sdk";
import { parseLocalDay } from "@openbrf/shared";

import type { PageVisibility } from "../generated/prisma/enums";

/**
 * What the content services share: how an audience is named to a plugin, and
 * how a time a plugin passed is read (ADR 0032).
 *
 * A plugin passes plain strings, and nothing it passes is trusted to be what
 * the type says. A value that is not one is refused with a RangeError, and the
 * value itself is never in the message: a plugin may pass anything there, and
 * the message ends up in the log.
 */

/** Who an item is for, in the plugin contract's words. */
export function contentAudience(
  visibility: PageVisibility,
): PluginContentAudience {
  return visibility === "PUBLIC" ? "anyone" : "members";
}

/** The stored visibility an audience a plugin asked for names. */
export function visibilityOf(audience: unknown): PageVisibility {
  if (audience === "anyone") {
    return "PUBLIC";
  }
  if (audience === "members") {
    return "MEMBER";
  }
  throw new RangeError('An audience is "anyone" or "members".');
}

/**
 * A date, a time and an offset, as ISO 8601 writes an instant.
 *
 * Stricter than `Date`, which reads forms nobody means - a bare date as UTC
 * midnight, a time with no offset as the server's own clock - and a window
 * read on the wrong clock is a window of the wrong items. `Date` also rolls a
 * day that is not on the calendar over to the next month, and "24:00" over to
 * the next day, so the day is checked on the calendar and the hour is capped
 * at 23.
 */
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant a plugin passed, read as one. */
export function readInstant(value: unknown, name: string): Date {
  const day = typeof value === "string" ? ISO_INSTANT.exec(value)?.[1] : null;
  const parsed =
    typeof value === "string" && day && parseLocalDay(day) !== null
      ? new Date(value)
      : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw new RangeError(
      `"${name}" is not an ISO 8601 instant with a date, a time and an offset.`,
    );
  }
  return parsed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A half-open window [from, to) a plugin passed, at most so many days long.
 *
 * Bounded because the plugin chooses it: a calendar read over ten years is a
 * read of the whole table. Empty and backwards windows are refused rather than
 * answered with nothing, because either is a plugin's mistake it should hear
 * about.
 */
export function readWindow(
  range: { from?: unknown; to?: unknown } | undefined,
  maxDays: number,
): { from: Date; to: Date } {
  const from = readInstant(range?.from, "from");
  const to = readInstant(range?.to, "to");
  if (to.getTime() <= from.getTime()) {
    throw new RangeError('"to" has to be later than "from".');
  }
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) {
    throw new RangeError(
      `"from" and "to" may be at most ${String(maxDays)} days apart.`,
    );
  }
  return { from, to };
}

/**
 * Who a content read is for, as far as the content services need to know.
 *
 * `forDevices` is set for a plugin that declares a device route (ADR 0031),
 * and for the core's display route (ADR 0050): what it reads may be in front
 * of whoever passes a device, so it is handed only items that pass the
 * register check, and no booking that has ended (ADR 0032). The host sets it
 * from the plugin's manifest, never from anything the plugin passes.
 *
 * `onScreensOnly` is set by the core's display route alone, which shows the
 * news items and events the board marked "show on screens" and nothing else.
 * Read in the query rather than filtered afterwards, so a limit counts marked
 * items. A plugin is handed the mark on every item and decides for itself.
 */
export interface ContentReader {
  readonly forDevices: boolean;
  readonly onScreensOnly?: boolean;
}
