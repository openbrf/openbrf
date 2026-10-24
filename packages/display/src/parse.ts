import {
  SCREEN_CONTENT_LIMITS as LIMITS,
  SCREEN_CONTENT_VERSION,
  SLIDE_ID_PATTERN,
  type AddonDoor,
  type AgendaItem,
  type AvailabilityResource,
  type BusyInterval,
  type EventsOccurrence,
  type IsoWeekday,
  type PictureRef,
  type ScreenContent,
  type ScreenLayout,
  type ScreenSchedule,
  type ScreenScheduleWindow,
  type Slide,
  type SlideBody,
  type SlideSource,
} from "./contract.ts";
import { isTimeZone } from "./time.ts";

/** Why a document was refused. */
export type ScreenContentErrorReason = "version-unknown" | "document-invalid";

/**
 * A document the player cannot show at all.
 *
 * To the fetch loop it is a failed fetch, as the contract says of a document
 * with a version the player does not know.
 */
export class ScreenContentError extends Error {
  override readonly name = "ScreenContentError";

  constructor(
    readonly reason: ScreenContentErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads a screen content document by the player's rules, and hands back only
 * what the contract names.
 *
 * - **Objects are open.** A field the contract does not name is ignored, and is
 *   absent from the result.
 * - **A slide whose `body.kind` is unknown is skipped**, so that a kind added
 *   later in version 1 does not stop an older player.
 * - **A malformed slide is skipped too**: a slide of a known kind with a field
 *   of the wrong type, a text over its limit, a count out of bounds, a `source`
 *   that does not match its body, or an `id` an earlier slide already has. The
 *   rest of the rotation is shown without it.
 * - **A `version` other than 1, or none, is refused** with the reason
 *   `version-unknown`.
 * - **A document whose own fields are malformed is refused** with the reason
 *   `document-invalid`: the screen id, the instants, the locale, the time zone,
 *   the release channel, the layout, the schedule, or a rotation that is not a
 *   list of at most 100.
 *
 * `refreshSeconds` is held to 30 to 60 rather than refused, because the
 * contract says the player fetches again within a minute whatever the document
 * says.
 */
export function parseScreenContent(value: unknown): ScreenContent {
  if (!isRecord(value)) {
    throw invalid("The document is not a JSON object.");
  }
  if (value["version"] !== SCREEN_CONTENT_VERSION) {
    throw new ScreenContentError(
      "version-unknown",
      `The document's version is not ${SCREEN_CONTENT_VERSION}.`,
    );
  }
  const screenId = value["screenId"];
  if (typeof screenId !== "string" || screenId.length === 0) {
    throw invalid("screenId is not a string.");
  }
  const generatedAt = value["generatedAt"];
  if (!isInstant(generatedAt)) {
    throw invalid("generatedAt is not an instant.");
  }
  const refreshSeconds = value["refreshSeconds"];
  if (
    typeof refreshSeconds !== "number" ||
    !Number.isFinite(refreshSeconds) ||
    refreshSeconds <= 0
  ) {
    throw invalid("refreshSeconds is not a number of seconds.");
  }
  const locale = value["locale"];
  if (locale !== "sv" && locale !== "en") {
    throw invalid("locale is not sv or en.");
  }
  const timeZone = value["timeZone"];
  if (typeof timeZone !== "string" || !isTimeZone(timeZone)) {
    throw invalid("timeZone is not a time zone.");
  }
  const releaseChannel = value["releaseChannel"];
  if (releaseChannel !== "stable" && releaseChannel !== "beta") {
    throw invalid("releaseChannel is not stable or beta.");
  }
  const layout = parseLayout(value["layout"]);
  const schedule = parseSchedule(value["schedule"]);
  const rotation = value["rotation"];
  if (!Array.isArray(rotation) || rotation.length > LIMITS.rotation) {
    throw invalid(`rotation is not a list of at most ${LIMITS.rotation}.`);
  }
  const slides: Slide[] = [];
  const ids = new Set<string>();
  for (const candidate of rotation) {
    const slide = parseSlide(candidate);
    if (slide !== null && !ids.has(slide.id)) {
      ids.add(slide.id);
      slides.push(slide);
    }
  }
  return {
    version: SCREEN_CONTENT_VERSION,
    screenId,
    generatedAt,
    refreshSeconds: Math.min(
      LIMITS.refreshSecondsMax,
      Math.max(LIMITS.refreshSecondsMin, Math.round(refreshSeconds)),
    ),
    locale,
    timeZone,
    releaseChannel,
    layout,
    schedule,
    rotation: slides,
  };
}

function invalid(message: string): ScreenContentError {
  return new ScreenContentError("document-invalid", message);
}

function parseLayout(value: unknown): ScreenLayout {
  if (!isRecord(value)) {
    throw invalid("layout is not an object.");
  }
  const { orientation, header, theme } = value;
  if (
    orientation !== 0 &&
    orientation !== 90 &&
    orientation !== 180 &&
    orientation !== 270
  ) {
    throw invalid("layout.orientation is not 0, 90, 180 or 270.");
  }
  if (header !== "none" && header !== "clock") {
    throw invalid("layout.header is not none or clock.");
  }
  if (theme !== "light" && theme !== "dark") {
    throw invalid("layout.theme is not light or dark.");
  }
  return { orientation, header, theme };
}

const LOCAL_TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

function parseSchedule(value: unknown): ScreenSchedule {
  if (!isRecord(value)) {
    throw invalid("schedule is not an object.");
  }
  const on = value["on"];
  if (!Array.isArray(on) || on.length > LIMITS.scheduleWindows) {
    throw invalid(
      `schedule.on is not a list of at most ${LIMITS.scheduleWindows}.`,
    );
  }
  return {
    on: on.map((window): ScreenScheduleWindow => {
      if (!isRecord(window)) {
        throw invalid("A schedule window is not an object.");
      }
      const { days, from, to } = window;
      if (
        !Array.isArray(days) ||
        !days.every(
          (day): day is IsoWeekday =>
            typeof day === "number" &&
            Number.isInteger(day) &&
            day >= 1 &&
            day <= 7,
        )
      ) {
        throw invalid("A schedule window's days are not ISO weekdays.");
      }
      if (
        typeof from !== "string" ||
        typeof to !== "string" ||
        !LOCAL_TIME.test(from) ||
        !LOCAL_TIME.test(to) ||
        from >= to
      ) {
        throw invalid(
          "A schedule window's from and to are not times in order.",
        );
      }
      return { days: [...days], from, to };
    }),
  };
}

const SOURCE_OF_KIND: Readonly<Record<SlideBody["kind"], SlideSource>> = {
  news: "news",
  events: "events",
  meeting: "meeting",
  availability: "availability",
  picture: "picture",
  text: "addon",
  table: "addon",
  doors: "addon",
};

function parseSlide(value: unknown): Slide | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, seconds, until, source, addon, body } = value;
  if (typeof id !== "string" || !SLIDE_ID_PATTERN.test(id)) {
    return null;
  }
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < LIMITS.slideSecondsMin ||
    seconds > LIMITS.slideSecondsMax
  ) {
    return null;
  }
  if (until !== null && !isInstant(until)) {
    return null;
  }
  const parsed = parseBody(body);
  if (parsed === null) {
    return null;
  }
  const sourceOfBody = SOURCE_OF_KIND[parsed.kind];
  if (source !== sourceOfBody) {
    return null;
  }
  let addonId: string | null = null;
  if (sourceOfBody === "addon") {
    if (typeof addon !== "string" || addon.length === 0) {
      return null;
    }
    addonId = addon;
  } else if (addon !== null) {
    return null;
  }
  return {
    id,
    seconds,
    until,
    source: sourceOfBody,
    addon: addonId,
    body: parsed,
  };
}

function parseBody(value: unknown): SlideBody | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value["kind"]) {
    case "news":
      return parseNews(value);
    case "events":
      return parseEvents(value);
    case "meeting":
      return parseMeeting(value);
    case "availability":
      return parseAvailability(value);
    case "picture":
      return parsePictureBody(value);
    case "text":
      return parseText(value);
    case "table":
      return parseTable(value);
    case "doors":
      return parseDoors(value);
    default:
      return null;
  }
}

function parseNews(value: Record<string, unknown>): SlideBody | null {
  const { title, paragraphs, picture, publishedAt } = value;
  if (!isText(title, LIMITS.title) || !isInstant(publishedAt)) {
    return null;
  }
  if (!isTextList(paragraphs, LIMITS.paragraphs)) {
    return null;
  }
  const ref = picture === null ? null : parsePictureRef(picture);
  if (ref === undefined) {
    return null;
  }
  return {
    kind: "news",
    title,
    paragraphs: [...paragraphs],
    picture: ref,
    publishedAt,
  };
}

function parseEvents(value: Record<string, unknown>): SlideBody | null {
  const list = value["occurrences"];
  if (
    !Array.isArray(list) ||
    list.length < LIMITS.occurrencesMin ||
    list.length > LIMITS.occurrencesMax
  ) {
    return null;
  }
  const occurrences: EventsOccurrence[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      return null;
    }
    const {
      title,
      description,
      location,
      startsAt,
      endsAt,
      calledOff,
      placesLeft,
    } = item;
    if (
      !isText(title, LIMITS.title) ||
      !isTextOrNull(description, LIMITS.description) ||
      !isTextOrNull(location, LIMITS.location) ||
      !isInstant(startsAt) ||
      !isInstant(endsAt) ||
      typeof calledOff !== "boolean" ||
      !(placesLeft === null || isCount(placesLeft))
    ) {
      return null;
    }
    occurrences.push({
      title,
      description,
      location,
      startsAt,
      endsAt,
      calledOff,
      placesLeft,
    });
  }
  return { kind: "events", occurrences };
}

function parseMeeting(value: Record<string, unknown>): SlideBody | null {
  const { meetingKind, startsAt, place, digitalParticipation, agenda } = value;
  if (
    (meetingKind !== "ordinary" && meetingKind !== "extraordinary") ||
    !isInstant(startsAt) ||
    !isText(place, LIMITS.place) ||
    !isTextOrNull(digitalParticipation, LIMITS.digitalParticipation) ||
    !Array.isArray(agenda) ||
    agenda.length > LIMITS.agendaItems
  ) {
    return null;
  }
  const items: AgendaItem[] = [];
  for (const item of agenda) {
    if (!isRecord(item)) {
      return null;
    }
    const { position, title } = item;
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      !isText(title, LIMITS.agendaTitle)
    ) {
      return null;
    }
    items.push({ position, title });
  }
  return {
    kind: "meeting",
    meetingKind,
    startsAt,
    place,
    digitalParticipation,
    agenda: items,
  };
}

const MINUTES_IN_A_DAY = 24 * 60;

function parseAvailability(value: Record<string, unknown>): SlideBody | null {
  const { from, to, resources } = value;
  if (!isInstant(from) || !isInstant(to)) {
    return null;
  }
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > LIMITS.availabilityDays * 24 * 60 * 60 * 1000) {
    return null;
  }
  if (
    !Array.isArray(resources) ||
    resources.length < LIMITS.resourcesMin ||
    resources.length > LIMITS.resourcesMax
  ) {
    return null;
  }
  const parsed: AvailabilityResource[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) {
      return null;
    }
    const { name, mode, slotMinutes, opensAtMinute, closesAtMinute, busy } =
      resource;
    if (
      !isText(name, LIMITS.resourceName) ||
      (mode !== "timeSlots" && mode !== "wholeDay" && mode !== "dateRange") ||
      !isMinutesOrNull(slotMinutes) ||
      !isMinutesOrNull(opensAtMinute) ||
      !isMinutesOrNull(closesAtMinute) ||
      !Array.isArray(busy)
    ) {
      return null;
    }
    const intervals: BusyInterval[] = [];
    for (const interval of busy) {
      if (!isRecord(interval)) {
        return null;
      }
      const { start, end } = interval;
      if (
        !isInstant(start) ||
        !isInstant(end) ||
        Date.parse(start) >= Date.parse(end)
      ) {
        return null;
      }
      intervals.push({ start, end });
    }
    parsed.push({
      name,
      mode,
      slotMinutes,
      opensAtMinute,
      closesAtMinute,
      busy: intervals,
    });
  }
  return { kind: "availability", from, to, resources: parsed };
}

function parsePictureBody(value: Record<string, unknown>): SlideBody | null {
  const picture = parsePictureRef(value["picture"]);
  const caption = value["caption"];
  if (picture === undefined || !isTextOrNull(caption, LIMITS.caption)) {
    return null;
  }
  return { kind: "picture", picture, caption };
}

function parseText(value: Record<string, unknown>): SlideBody | null {
  const { heading, body } = value;
  if (typeof heading !== "string" || !isTextList(body, LIMITS.addonTextBody)) {
    return null;
  }
  return { kind: "text", heading, body: [...body] };
}

function parseTable(value: Record<string, unknown>): SlideBody | null {
  const { heading, columns, rows } = value;
  if (
    typeof heading !== "string" ||
    !isStringList(columns) ||
    columns.length === 0 ||
    columns.length > LIMITS.tableColumns ||
    !Array.isArray(rows) ||
    rows.length > LIMITS.tableRows ||
    !rows.every(
      (row): row is string[] =>
        isStringList(row) && row.length === columns.length,
    )
  ) {
    return null;
  }
  return {
    kind: "table",
    heading,
    columns: [...columns],
    rows: rows.map((row) => [...row]),
  };
}

function parseDoors(value: Record<string, unknown>): SlideBody | null {
  const { heading, doors } = value;
  if (
    typeof heading !== "string" ||
    !Array.isArray(doors) ||
    doors.length > LIMITS.doors
  ) {
    return null;
  }
  const parsed: AddonDoor[] = [];
  for (const door of doors) {
    if (!isRecord(door)) {
      return null;
    }
    const { floor, apartment, names } = door;
    if (!(
      floor === null ||
      (typeof floor === "number" && Number.isInteger(floor))
    )) {
      return null;
    }
    if (typeof apartment !== "string" || !isStringList(names)) {
      return null;
    }
    parsed.push({ floor, apartment, names: [...names] });
  }
  return { kind: "doors", heading, doors: parsed };
}

/** The picture, or undefined when it is not one. */
function parsePictureRef(value: unknown): PictureRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { mediaFileId, contentType, byteSize, version, alt } = value;
  if (
    typeof mediaFileId !== "string" ||
    mediaFileId.length === 0 ||
    typeof contentType !== "string" ||
    !isCount(byteSize) ||
    typeof version !== "string" ||
    !isText(alt, LIMITS.alt)
  ) {
    return undefined;
  }
  return { mediaFileId, contentType, byteSize, version, alt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Whether a value is an instant as the contract writes one, and a real one. */
function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === `${value.slice(0, -1)}.000Z`
  );
}

/** The number of characters (code points) in a text. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && characters(value) <= max;
}

function isTextOrNull(value: unknown, max: number): value is string | null {
  return value === null || isText(value, max);
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** A list of texts at most `max` characters together. */
function isTextList(value: unknown, max: number): value is string[] {
  if (!isStringList(value)) {
    return false;
  }
  let total = 0;
  for (const item of value) {
    total += characters(item);
  }
  return total <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isMinutesOrNull(value: unknown): value is number | null {
  return value === null || (isCount(value) && value <= MINUTES_IN_A_DAY);
}
