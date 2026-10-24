/**
 * @openbrf/display: what every screen showing an association's content is
 * built from (ADR 0050). The core's display mode and the signage module's
 * player both use all four parts:
 *
 * 1. the screen content contract and its parser,
 * 2. the rotation builder,
 * 3. the renderer,
 * 4. the fetch loop.
 */
export {
  SCREEN_CONTENT_LIMITS,
  SCREEN_CONTENT_VERSION,
  SLIDE_ID_PATTERN,
} from "./contract.ts";
export type {
  AddonBody,
  AddonDoor,
  AddonDoorsBody,
  AddonTableBody,
  AddonTextBody,
  AgendaItem,
  AvailabilityBody,
  AvailabilityResource,
  BusyInterval,
  EventsBody,
  EventsOccurrence,
  Instant,
  IsoWeekday,
  LocalTime,
  MeetingBody,
  NewsBody,
  PictureBody,
  PictureRef,
  ScreenContent,
  ScreenLayout,
  ScreenLocale,
  ScreenSchedule,
  ScreenScheduleWindow,
  Slide,
  SlideBody,
  SlideSource,
} from "./contract.ts";
export { parseScreenContent, ScreenContentError } from "./parse.ts";
export type { ScreenContentErrorReason } from "./parse.ts";
export { shortenText, shortenTexts } from "./text.ts";
export {
  availabilityWindow,
  buildRotation,
  EVENTS_DAYS,
  NEWS_SLIDES,
} from "./rotation.ts";
export type {
  BookableResourceInput,
  BusyIntervalInput,
  MeetingNoticeInput,
  NewsItemInput,
  OccurrenceInput,
  PictureFileInput,
  RotationInput,
} from "./rotation.ts";
export { mountRenderer } from "./renderer.ts";
export type {
  DisplayMessage,
  DisplayRenderer,
  DisplayStatus,
  RendererOptions,
} from "./renderer.ts";
export { DISPLAY_STYLESHEET } from "./styles.ts";
export { startFetchLoop, STALE_CONTENT_LIMIT_MS } from "./fetch-loop.ts";
export type {
  CachedScreenContent,
  FetchedStatus,
  FetchLoop,
  FetchLoopOptions,
  ScreenContentCache,
} from "./fetch-loop.ts";
