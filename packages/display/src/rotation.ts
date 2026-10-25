/**
 * The rotation builder: the reads of ADR 0032 and the moment of the fetch, in;
 * the `news`, `events`, `meeting` and `availability` slides, out.
 *
 * It reads nothing and keeps no clock, so whatever calls it decides what goes
 * in: the core's display route and the signage plugin's device route hand it
 * the same narrowed reads, and get the same slides back. The input types are
 * structural, and the plugin SDK's `PluginNewsItem`, `PluginOccurrence`,
 * `PluginMeetingNotice`, `PluginBookableResource` and `PluginBusyInterval`
 * satisfy them; a field this module does not name, such as `audience` or
 * `onScreens`, is ignored.
 */
import {
  SCREEN_CONTENT_LIMITS as LIMITS,
  SLIDE_ID_PATTERN,
  type AgendaItem,
  type AvailabilityResource,
  type BusyInterval,
  type EventsOccurrence,
  type PictureRef,
  type Slide,
} from "./contract.ts";
import { shortenText, shortenTexts } from "./text.ts";
import {
  DAY,
  floorToMinute,
  MINUTE,
  toInstant,
  zonedDayStartAfter,
} from "./time.ts";

/** A published news item, as `PluginNewsItem` has it. */
export interface NewsItemInput {
  readonly id: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly pictures: readonly {
    readonly mediaFileId: string;
    readonly alt: string;
  }[];
  /** ISO 8601 instant. */
  readonly publishedAt: string;
}

/** One occurrence of a published event, as `PluginOccurrence` has it. */
export interface OccurrenceInput {
  readonly eventId: string;
  readonly occurrenceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  /** ISO 8601 instant. */
  readonly startsAt: string;
  /** ISO 8601 instant. */
  readonly endsAt: string;
  readonly calledOff: boolean;
  readonly placesLeft: number | null;
}

/** The notice of a general meeting, as `PluginMeetingNotice` has it. */
export interface MeetingNoticeInput {
  readonly meetingId: string;
  readonly kind: "ordinary" | "extraordinary";
  /** ISO 8601 instant. */
  readonly startsAt: string;
  readonly place: string;
  readonly digitalParticipation: string | null;
  readonly agenda: readonly {
    readonly position: number;
    readonly title: string;
  }[];
}

/** A bookable resource, as `PluginBookableResource` has it. */
export interface BookableResourceInput {
  readonly id: string;
  readonly name: string;
  readonly mode: "timeSlots" | "wholeDay" | "dateRange";
  readonly slotMinutes: number | null;
  readonly opensAtMinute: number | null;
  readonly closesAtMinute: number | null;
}

/** A period a resource is taken, as `PluginBusyInterval` has it. */
export interface BusyIntervalInput {
  readonly resourceId: string;
  /** ISO 8601 instant. */
  readonly start: string;
  /** ISO 8601 instant. */
  readonly end: string;
}

/** A picture file the caller resolved, by media file id. */
export interface PictureFileInput {
  readonly contentType: string;
  readonly byteSize: number;
  readonly version: string;
}

/** What one rotation is built from. Each source is in it only when given. */
export interface RotationInput {
  /** The moment of the fetch. */
  readonly now: Date;
  /** Newest first, as the caller read them. */
  readonly news?: readonly NewsItemInput[];
  readonly occurrences?: readonly OccurrenceInput[];
  readonly meetingNotices?: readonly MeetingNoticeInput[];
  readonly availability?: {
    /** Clamped to no earlier than `now`, floored to the minute. */
    readonly from: Date;
    /** Clamped to at most 7 days after `from`. */
    readonly to: Date;
    readonly resources: readonly BookableResourceInput[];
    readonly busy: readonly BusyIntervalInput[];
  };
  /**
   * The picture files the caller resolved, by media file id. A news item's
   * picture without an entry here is left out.
   */
  readonly pictures?: ReadonlyMap<string, PictureFileInput>;
}

/** At most this many news items, a slide each. */
export const NEWS_SLIDES = 10;
/** How far ahead an events slide looks, in days. */
export const EVENTS_DAYS = 31;

const NEWS_SECONDS = 15;
const SLIDE_SECONDS = 20;

/**
 * The slides of one rotation, in the order news, events, meeting,
 * availability, each only when its input is given and has something to show:
 *
 * - **News**: a slide for each of the first ten items, in the order given,
 *   with the first of its pictures that `pictures` resolves.
 * - **Events**: one slide with the soonest eight occurrences that have not
 *   ended and start within 31 days of `now`.
 * - **Meeting**: one slide with the soonest notice of a meeting that has not
 *   begun, shown until it begins.
 * - **Availability**: one slide with the first twelve resources and when each
 *   is busy, merged and clipped to the window.
 *
 * Every text over its limit is shortened with "…", and every slide's id is
 * the same on every fetch while the slide shows the same thing. The slides,
 * put into a document, pass `parseScreenContent`.
 */
export function buildRotation(input: RotationInput): Slide[] {
  const now = input.now.getTime();
  const slides: Slide[] = [];
  if (input.news !== undefined) {
    slides.push(...newsSlides(input.news, input.pictures));
  }
  if (input.occurrences !== undefined) {
    const slide = eventsSlide(input.occurrences, now);
    if (slide !== null) {
      slides.push(slide);
    }
  }
  if (input.meetingNotices !== undefined) {
    const slide = meetingSlide(input.meetingNotices, now);
    if (slide !== null) {
      slides.push(slide);
    }
  }
  if (input.availability !== undefined) {
    const slide = availabilitySlide(input.availability, now);
    if (slide !== null) {
      slides.push(slide);
    }
  }
  return slides;
}

/**
 * The window of an availability slide: from the minute of the fetch to the end
 * of the next day in the association's time zone, which is 23 or 25 hours
 * long on the days the clocks change.
 */
export function availabilityWindow(
  now: Date,
  timeZone: string,
): { from: Date; to: Date } {
  const time = now.getTime();
  return {
    from: new Date(floorToMinute(time)),
    to: new Date(zonedDayStartAfter(time, 2, timeZone)),
  };
}

function newsSlides(
  items: readonly NewsItemInput[],
  pictures: ReadonlyMap<string, PictureFileInput> | undefined,
): Slide[] {
  const slides: Slide[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (slides.length === NEWS_SLIDES) {
      break;
    }
    const publishedAt = timeOf(item.publishedAt);
    const id = slideId("news", item.id);
    if (publishedAt === null || ids.has(id)) {
      continue;
    }
    ids.add(id);
    slides.push({
      id,
      seconds: NEWS_SECONDS,
      until: null,
      source: "news",
      addon: null,
      body: {
        kind: "news",
        title: shortenText(item.title, LIMITS.title),
        paragraphs: shortenTexts(item.paragraphs, LIMITS.paragraphs),
        picture: firstPicture(item.pictures, pictures),
        publishedAt: toInstant(publishedAt),
      },
    });
  }
  return slides;
}

function firstPicture(
  candidates: NewsItemInput["pictures"],
  pictures: ReadonlyMap<string, PictureFileInput> | undefined,
): PictureRef | null {
  for (const candidate of candidates) {
    const file = pictures?.get(candidate.mediaFileId);
    if (
      file !== undefined &&
      candidate.mediaFileId.length > 0 &&
      Number.isInteger(file.byteSize) &&
      file.byteSize >= 0
    ) {
      return {
        mediaFileId: candidate.mediaFileId,
        contentType: file.contentType,
        byteSize: file.byteSize,
        version: file.version,
        alt: shortenText(candidate.alt, LIMITS.alt),
      };
    }
  }
  return null;
}

function eventsSlide(
  occurrences: readonly OccurrenceInput[],
  now: number,
): Slide | null {
  const horizon = now + EVENTS_DAYS * DAY;
  const coming = occurrences
    .map((occurrence) => ({
      occurrence,
      startsAt: timeOf(occurrence.startsAt),
      endsAt: timeOf(occurrence.endsAt),
    }))
    .filter(
      (
        entry,
      ): entry is {
        occurrence: OccurrenceInput;
        startsAt: number;
        endsAt: number;
      } =>
        entry.startsAt !== null &&
        entry.endsAt !== null &&
        entry.endsAt > now &&
        entry.startsAt < horizon,
    )
    .sort(
      (a, b) =>
        a.startsAt - b.startsAt ||
        compareText(a.occurrence.occurrenceId, b.occurrence.occurrenceId),
    )
    .slice(0, LIMITS.occurrencesMax);
  if (coming.length === 0) {
    return null;
  }
  return {
    id: "events",
    seconds: SLIDE_SECONDS,
    until: null,
    source: "events",
    addon: null,
    body: {
      kind: "events",
      occurrences: coming.map(
        ({ occurrence, startsAt, endsAt }): EventsOccurrence => ({
          title: shortenText(occurrence.title, LIMITS.title),
          description: optionalText(occurrence.description, LIMITS.description),
          location: optionalText(occurrence.location, LIMITS.location),
          startsAt: toInstant(startsAt),
          endsAt: toInstant(endsAt),
          calledOff: occurrence.calledOff === true,
          placesLeft:
            typeof occurrence.placesLeft === "number" &&
            Number.isFinite(occurrence.placesLeft)
              ? Math.max(0, Math.floor(occurrence.placesLeft))
              : null,
        }),
      ),
    },
  };
}

function meetingSlide(
  notices: readonly MeetingNoticeInput[],
  now: number,
): Slide | null {
  let soonest: { notice: MeetingNoticeInput; startsAt: number } | null = null;
  for (const notice of notices) {
    const startsAt = timeOf(notice.startsAt);
    if (startsAt === null || startsAt <= now) {
      continue;
    }
    if (
      soonest === null ||
      startsAt < soonest.startsAt ||
      (startsAt === soonest.startsAt &&
        compareText(notice.meetingId, soonest.notice.meetingId) < 0)
    ) {
      soonest = { notice, startsAt };
    }
  }
  if (soonest === null) {
    return null;
  }
  const { notice } = soonest;
  const startsAt = toInstant(soonest.startsAt);
  const agenda = notice.agenda
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        positionOf(a.item.position, a.index) -
          positionOf(b.item.position, b.index) || a.index - b.index,
    )
    .slice(0, LIMITS.agendaItems)
    .map(({ item, index }): AgendaItem => ({
      position: positionOf(item.position, index),
      title: shortenText(item.title, LIMITS.agendaTitle),
    }));
  return {
    id: slideId("meeting", notice.meetingId),
    seconds: SLIDE_SECONDS,
    until: startsAt,
    source: "meeting",
    addon: null,
    body: {
      kind: "meeting",
      meetingKind:
        notice.kind === "extraordinary" ? "extraordinary" : "ordinary",
      startsAt,
      place: shortenText(notice.place, LIMITS.place),
      digitalParticipation: optionalText(
        notice.digitalParticipation,
        LIMITS.digitalParticipation,
      ),
      agenda,
    },
  };
}

function positionOf(position: number, index: number): number {
  return Number.isInteger(position) ? position : index + 1;
}

const RESOURCE_MODES = new Set(["timeSlots", "wholeDay", "dateRange"]);

function availabilitySlide(
  availability: NonNullable<RotationInput["availability"]>,
  now: number,
): Slide | null {
  const from = floorToMinute(Math.max(availability.from.getTime(), now));
  const to =
    Math.floor(
      Math.min(
        availability.to.getTime(),
        from + LIMITS.availabilityDays * DAY,
      ) / 1000,
    ) * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return null;
  }
  const resources = availability.resources
    .filter((resource) => RESOURCE_MODES.has(resource.mode))
    .slice(0, LIMITS.resourcesMax)
    .map((resource): AvailabilityResource => ({
      name: shortenText(resource.name, LIMITS.resourceName),
      mode: resource.mode,
      slotMinutes: minutesOrNull(resource.slotMinutes),
      opensAtMinute: minutesOrNull(resource.opensAtMinute),
      closesAtMinute: minutesOrNull(resource.closesAtMinute),
      busy: busyOf(resource.id, availability.busy, from, to, now),
    }));
  if (resources.length === 0) {
    return null;
  }
  return {
    id: "availability",
    seconds: SLIDE_SECONDS,
    until: null,
    source: "availability",
    addon: null,
    body: {
      kind: "availability",
      from: toInstant(from),
      to: toInstant(to),
      resources,
    },
  };
}

/**
 * One resource's busy intervals: clipped to [from, to), whole seconds, sorted
 * and merged. An interval that began at or before `now` is under way, and is
 * taken from `from`: the busy read starts it at the moment of the call, so
 * keeping that to the second would change the document on every fetch. So is
 * one that starts later in the minute of `from`, because a busy read that
 * runs after `now` (a caller's request time) starts it at its own, later
 * clock.
 */
function busyOf(
  resourceId: string,
  busy: readonly BusyIntervalInput[],
  from: number,
  to: number,
  now: number,
): BusyInterval[] {
  const clipped: [number, number][] = [];
  for (const interval of busy) {
    if (interval.resourceId !== resourceId) {
      continue;
    }
    const start = timeOf(interval.start);
    const end = timeOf(interval.end);
    if (start === null || end === null || start >= to) {
      continue;
    }
    const clippedStart =
      start <= now || start < from + MINUTE
        ? from
        : Math.max(Math.floor(start / 1000) * 1000, from);
    const clippedEnd = Math.min(Math.ceil(end / 1000) * 1000, to);
    if (clippedStart < clippedEnd) {
      clipped.push([clippedStart, clippedEnd]);
    }
  }
  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged.map(([start, end]) => ({
    start: toInstant(start),
    end: toInstant(end),
  }));
}

const MINUTES_IN_A_DAY = DAY / MINUTE;

function minutesOrNull(value: number | null): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MINUTES_IN_A_DAY
    ? value
    : null;
}

function optionalText(value: string | null, max: number): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? shortenText(value, max)
    : null;
}

function timeOf(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Plain code unit order, the same in every locale and on every runtime. */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * `<prefix>.<id>` when that is a slide id, and otherwise `<prefix>.h` and a
 * hash of the id, so that it stays the same on every fetch.
 */
function slideId(prefix: string, id: string): string {
  const plain = `${prefix}.${id}`;
  return SLIDE_ID_PATTERN.test(plain) ? plain : `${prefix}.h${hash(id)}`;
}

/** A 53-bit hash of a text (cyrb53), in base 36. Not for security. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
