/**
 * The screen content contract, version 1: the document a screen fetches and
 * shows, as ADR 0034 defined it and ADR 0050 made the core's.
 *
 * The text of record is docs/screen-content-contract.md. These types and
 * limits are that text in code, and a change to either is a change to the
 * contract under its version rules: a field or a body kind may be added within
 * version 1, because an older player ignores what it does not know, and a
 * change an older player would misread raises the version.
 *
 * "Characters" in a limit are Unicode code points. A server that measures in
 * UTF-16 code units, as JavaScript's `length` does, never exceeds a limit
 * measured in code points, so the builder in this package measures in code
 * units and the parser in code points.
 */

/** The version of the document this package reads and builds. */
export const SCREEN_CONTENT_VERSION = 1;

/** An instant: RFC 3339 in UTC, whole seconds, with "Z": "2026-12-01T09:00:00Z". */
export type Instant = string;

/** A time of day, "HH:MM" from "00:00" to "24:00", in the document's `timeZone`. */
export type LocalTime = string;

/** The languages a screen speaks. */
export type ScreenLocale = "sv" | "en";

/** An ISO weekday: 1 is Monday and 7 is Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** How the screen lays out its canvas. */
export interface ScreenLayout {
  /** Degrees clockwise the player turns its canvas. */
  orientation: 0 | 90 | 180 | 270;
  /** A band above the slides with the date and the time, or none. */
  header: "none" | "clock";
  theme: "light" | "dark";
}

/** One window in which the screen shows the rotation. */
export interface ScreenScheduleWindow {
  days: IsoWeekday[];
  /** Inclusive. */
  from: LocalTime;
  /** Exclusive, and after `from`. A window over midnight is two windows. */
  to: LocalTime;
}

/**
 * When the screen shows the rotation. Outside every window it shows black;
 * with no window at all it shows the rotation always.
 */
export interface ScreenSchedule {
  /** At most 14. */
  on: ScreenScheduleWindow[];
}

/** One kind of thing in a screen's rotation (GLOSSARY.md, "source"). */
export type SlideSource =
  "news" | "events" | "meeting" | "availability" | "picture" | "addon";

/** A picture the screen may show, fetched by its `mediaFileId`. */
export interface PictureRef {
  mediaFileId: string;
  /** The image type the core identified from the bytes. */
  contentType: string;
  byteSize: number;
  /** Opaque, and changes when the file does: the picture's ETag. */
  version: string;
  /** At most 300 characters. */
  alt: string;
}

/** A published news item. */
export interface NewsBody {
  kind: "news";
  /** At most 200 characters. */
  title: string;
  /** At most 2 000 characters together. */
  paragraphs: string[];
  picture: PictureRef | null;
  publishedAt: Instant;
}

/** One occurrence of a published event, as an events slide lists it. */
export interface EventsOccurrence {
  /** At most 200 characters. */
  title: string;
  /** At most 500 characters. */
  description: string | null;
  /** At most 200 characters. */
  location: string | null;
  startsAt: Instant;
  endsAt: Instant;
  calledOff: boolean;
  placesLeft: number | null;
}

/** The coming occurrences of published events. */
export interface EventsBody {
  kind: "events";
  /** 1 to 8, soonest first. */
  occurrences: EventsOccurrence[];
}

/** One matter on a general meeting's agenda. */
export interface AgendaItem {
  position: number;
  /** At most 200 characters. */
  title: string;
}

/** The notice of a general meeting the board has called. */
export interface MeetingBody {
  kind: "meeting";
  meetingKind: "ordinary" | "extraordinary";
  startsAt: Instant;
  /** At most 200 characters. */
  place: string;
  /** At most 500 characters. */
  digitalParticipation: string | null;
  /** At most 40. */
  agenda: AgendaItem[];
}

/** A period a bookable resource is taken. Never by whom. */
export interface BusyInterval {
  start: Instant;
  end: Instant;
}

/** One bookable resource on an availability slide. */
export interface AvailabilityResource {
  /** At most 80 characters. */
  name: string;
  mode: "timeSlots" | "wholeDay" | "dateRange";
  slotMinutes: number | null;
  /** Minutes after midnight in the document's `timeZone`. */
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  /** Merged, sorted, and inside [from, to). */
  busy: BusyInterval[];
}

/** When the house's bookable resources are free and busy. */
export interface AvailabilityBody {
  kind: "availability";
  /** The fetch, to the minute; never earlier. */
  from: Instant;
  /** At most 7 days after `from`. */
  to: Instant;
  /** 1 to 12. */
  resources: AvailabilityResource[];
}

/** A picture the board chose for the screen. */
export interface PictureBody {
  kind: "picture";
  picture: PictureRef;
  /** At most 200 characters. */
  caption: string | null;
}

/** An addon's text slide. */
export interface AddonTextBody {
  kind: "text";
  heading: string;
  /** At most 2 000 characters together. */
  body: string[];
}

/** An addon's table slide. */
export interface AddonTableBody {
  kind: "table";
  heading: string;
  /** At most 4. */
  columns: string[];
  /** At most 60, each as long as `columns`. */
  rows: string[][];
}

/** One door on an addon's doors slide. */
export interface AddonDoor {
  floor: number | null;
  apartment: string;
  names: string[];
}

/** An addon's doors slide: the names on the doors of one entrance. */
export interface AddonDoorsBody {
  kind: "doors";
  heading: string;
  /** At most 120. */
  doors: AddonDoor[];
}

/** One slide of an addon's output at the `source` extension point. */
export type AddonBody = AddonTextBody | AddonTableBody | AddonDoorsBody;

/** What a slide shows. Its `kind` matches the slide's `source`. */
export type SlideBody =
  | NewsBody
  | EventsBody
  | MeetingBody
  | AvailabilityBody
  | PictureBody
  | AddonBody;

/** One slide of the rotation. */
export interface Slide {
  /** 1 to 64 of A-Z a-z 0-9 . _ : -, the same on every fetch while the slide shows the same thing. */
  id: string;
  /** Integer, 5 to 120: how long it stays. */
  seconds: number;
  /** The player skips the slide from this instant, without waiting for a fetch. */
  until: Instant | null;
  source: SlideSource;
  /** The addon's plugin id when `source` is "addon", otherwise null. */
  addon: string | null;
  body: SlideBody;
}

/** The screen content document, version 1. */
export interface ScreenContent {
  version: 1;
  /** The device token's subject: the screen's id. */
  screenId: string;
  generatedAt: Instant;
  /** Integer, 30 to 60. */
  refreshSeconds: number;
  locale: ScreenLocale;
  /** IANA zone of the association's calendar day: "Europe/Stockholm". */
  timeZone: string;
  /** The only channel a paired screen's shell takes player releases from. */
  releaseChannel: "stable" | "beta";
  layout: ScreenLayout;
  schedule: ScreenSchedule;
  /** In order, at most 100; the player loops through them. */
  rotation: Slide[];
}

/** The contract's limits, by what they bound. */
export const SCREEN_CONTENT_LIMITS = {
  /** The document's size, in bytes of its UTF-8 JSON. */
  documentBytes: 1024 * 1024,
  rotation: 100,
  slideSecondsMin: 5,
  slideSecondsMax: 120,
  refreshSecondsMin: 30,
  refreshSecondsMax: 60,
  scheduleWindows: 14,
  title: 200,
  /** All of a news item's paragraphs together. */
  paragraphs: 2000,
  description: 500,
  location: 200,
  place: 200,
  digitalParticipation: 500,
  agendaItems: 40,
  agendaTitle: 200,
  occurrencesMin: 1,
  occurrencesMax: 8,
  resourcesMin: 1,
  resourcesMax: 12,
  resourceName: 80,
  /** How far an availability slide's `to` may be after its `from`, in days. */
  availabilityDays: 7,
  alt: 300,
  caption: 200,
  /** All of an addon text slide's paragraphs together. */
  addonTextBody: 2000,
  tableColumns: 4,
  tableRows: 60,
  doors: 120,
} as const;

/** What a slide's `id` is made of. */
export const SLIDE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
