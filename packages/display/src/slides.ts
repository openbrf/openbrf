/**
 * One slide's body as DOM.
 *
 * Every text from the document is set with `textContent` and nothing is ever
 * parsed as markup, because the contract makes every string plain text: a
 * news title that reads `<img src=x onerror=…>` shows those characters.
 */
import type {
  AddonDoorsBody,
  AddonTableBody,
  AddonTextBody,
  AvailabilityBody,
  EventsBody,
  MeetingBody,
  NewsBody,
  PictureBody,
  PictureRef,
  ScreenLocale,
  Slide,
} from "./contract.ts";
import { PAGED_LIST_ATTRIBUTE } from "./fit.ts";
import { translate } from "./translate.ts";
import { zonedDayStartAfter, zonedParts } from "./time.ts";

/** What a body needs besides itself. */
export interface SlideContext {
  readonly document: Document;
  readonly locale: ScreenLocale;
  readonly timeZone: string;
  readonly now: number;
  /** The picture's URL when the caller handed one, otherwise null. */
  pictureUrl(ref: PictureRef): string | null;
  /** The browser could not show a picture it was given. */
  pictureFailed(ref: PictureRef): void;
}

/** The language tag a locale is formatted in: 24-hour, day before month. */
export function localeTag(locale: ScreenLocale): string {
  return locale === "sv" ? "sv-SE" : "en-GB";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Formats an instant in the screen's locale and time zone. */
export function formatTime(
  time: number,
  locale: ScreenLocale,
  timeZone: string,
  style: "time" | "date" | "dayShort" | "weekdayDate" | "weekdayDateTime",
): string {
  const key = `${locale}\u0000${timeZone}\u0000${style}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(localeTag(locale), {
      timeZone,
      ...FORMATS[style],
    });
    formatters.set(key, formatter);
  }
  return formatter.format(time);
}

const TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

const FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
  time: TIME,
  date: { day: "numeric", month: "long" },
  dayShort: { weekday: "short", day: "numeric", month: "short" },
  weekdayDate: { weekday: "long", day: "numeric", month: "long" },
  weekdayDateTime: {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...TIME,
  },
};

/** The text with its first letter in capitals, as a heading starts. */
export function capitalised(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** A new element, with a class and its text. */
export function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** A list the renderer may show a page at a time, when the canvas cannot hold all of it. */
function pagedList<K extends "ol" | "ul" | "tbody">(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const list = element(document, tag, className);
  list.setAttribute(PAGED_LIST_ATTRIBUTE, "");
  return list;
}

/** The slide's body, or null when it cannot be shown now (a picture slide without its picture). */
export function renderSlide(
  slide: Slide,
  context: SlideContext,
): HTMLElement | null {
  const { body } = slide;
  switch (body.kind) {
    case "news":
      return news(body, context);
    case "events":
      return events(body, context);
    case "meeting":
      return meeting(body, context);
    case "availability":
      return availability(body, context);
    case "picture":
      return picture(body, context);
    case "text":
      return text(body, context);
    case "table":
      return table(body, context);
    case "doors":
      return doors(body, context);
  }
}

function container(context: SlideContext, kind: string): HTMLElement {
  return element(
    context.document,
    "section",
    `obrf-display-slide obrf-display-${kind}`,
  );
}

function image(ref: PictureRef, url: string, context: SlideContext) {
  const img = element(context.document, "img", "obrf-display-picture");
  img.alt = ref.alt;
  img.decoding = "async";
  img.addEventListener("error", () => context.pictureFailed(ref), {
    once: true,
  });
  img.src = url;
  return img;
}

function news(body: NewsBody, context: SlideContext): HTMLElement {
  const { document } = context;
  const section = container(context, "news");
  const copy = element(document, "div", "obrf-display-copy");
  const published = Date.parse(body.publishedAt);
  copy.append(
    element(
      document,
      "p",
      "obrf-display-date",
      formatTime(published, context.locale, context.timeZone, "date"),
    ),
    element(document, "h2", "obrf-display-heading", body.title),
    ...body.paragraphs.map((paragraph) =>
      element(document, "p", "obrf-display-text", paragraph),
    ),
  );
  section.append(copy);
  const url = body.picture === null ? null : context.pictureUrl(body.picture);
  if (body.picture !== null && url !== null) {
    section.classList.add("obrf-display-news--picture");
    section.append(image(body.picture, url, context));
  }
  return section;
}

function timeRange(start: number, end: number, context: SlideContext): string {
  const { locale, timeZone } = context;
  const from = formatTime(start, locale, timeZone, "time");
  const sameDay =
    zonedDayStartAfter(start, 0, timeZone) ===
    zonedDayStartAfter(end, 0, timeZone);
  const to = sameDay
    ? formatTime(end, locale, timeZone, "time")
    : `${formatTime(end, locale, timeZone, "dayShort")} ${formatTime(end, locale, timeZone, "time")}`;
  return translate(locale, "timeRange", { from, to });
}

function events(body: EventsBody, context: SlideContext): HTMLElement {
  const { document, locale, timeZone } = context;
  const section = container(context, "events");
  section.append(
    element(
      document,
      "h2",
      "obrf-display-heading",
      translate(locale, "comingEvents"),
    ),
  );
  const list = pagedList(document, "ol", "obrf-display-list");
  for (const occurrence of body.occurrences) {
    const start = Date.parse(occurrence.startsAt);
    const end = Date.parse(occurrence.endsAt);
    const item = element(document, "li", "obrf-display-event");
    const when = element(document, "div", "obrf-display-when");
    when.append(
      element(
        document,
        "span",
        undefined,
        capitalised(formatTime(start, locale, timeZone, "dayShort")),
      ),
      element(document, "span", undefined, timeRange(start, end, context)),
    );
    const what = element(document, "div", "obrf-display-what");
    what.append(element(document, "p", "obrf-display-title", occurrence.title));
    if (occurrence.location !== null) {
      what.append(
        element(
          document,
          "p",
          "obrf-display-text obrf-display-muted",
          occurrence.location,
        ),
      );
    }
    if (occurrence.description !== null) {
      what.append(
        element(
          document,
          "p",
          "obrf-display-description",
          occurrence.description,
        ),
      );
    }
    if (occurrence.calledOff) {
      item.classList.add("obrf-display-event--called-off");
      what.append(
        element(
          document,
          "span",
          "obrf-display-badge",
          translate(locale, "calledOff"),
        ),
      );
    } else if (occurrence.placesLeft !== null) {
      what.append(
        element(
          document,
          "p",
          "obrf-display-text",
          occurrence.placesLeft === 0
            ? translate(locale, "fullyBooked")
            : translate(locale, "placesLeft", { count: occurrence.placesLeft }),
        ),
      );
    }
    item.append(when, what);
    list.append(item);
  }
  section.append(list);
  return section;
}

function meeting(body: MeetingBody, context: SlideContext): HTMLElement {
  const { document, locale, timeZone } = context;
  const section = container(context, "meeting");
  section.append(
    element(
      document,
      "h2",
      "obrf-display-heading",
      translate(
        locale,
        body.meetingKind === "extraordinary"
          ? "extraordinaryMeeting"
          : "ordinaryMeeting",
      ),
    ),
  );
  const facts = element(document, "dl", "obrf-display-facts");
  const fact = (term: string, value: string, className?: string) => {
    facts.append(
      element(document, "dt", undefined, term),
      element(document, "dd", className, value),
    );
  };
  fact(
    translate(locale, "meetingWhen"),
    capitalised(
      formatTime(
        Date.parse(body.startsAt),
        locale,
        timeZone,
        "weekdayDateTime",
      ),
    ),
    "obrf-display-data",
  );
  fact(translate(locale, "meetingWhere"), body.place);
  if (body.digitalParticipation !== null) {
    fact(translate(locale, "digitalParticipation"), body.digitalParticipation);
  }
  section.append(facts);
  if (body.agenda.length > 0) {
    const agenda = pagedList(document, "ol", "obrf-display-agenda");
    for (const item of body.agenda) {
      const entry = element(document, "li");
      entry.append(
        element(
          document,
          "span",
          "obrf-display-agenda-position",
          `${item.position}.`,
        ),
        element(document, "span", undefined, item.title),
      );
      agenda.append(entry);
    }
    section.append(
      element(
        document,
        "h3",
        "obrf-display-subheading",
        translate(locale, "agenda"),
      ),
      agenda,
    );
  }
  return section;
}

function availability(
  body: AvailabilityBody,
  context: SlideContext,
): HTMLElement {
  const { document, locale, timeZone, now } = context;
  const section = container(context, "availability");
  section.append(
    element(
      document,
      "h2",
      "obrf-display-heading",
      translate(locale, "freeAndBusy"),
    ),
  );
  const to = Date.parse(body.to);
  const todayStart = zonedDayStartAfter(now, 0, timeZone);
  const tomorrowStart = zonedDayStartAfter(now, 1, timeZone);
  const dayAfterStart = zonedDayStartAfter(now, 2, timeZone);
  // A day is shown only as far as the document knows it: today from now,
  // tomorrow only when the document reaches its end.
  const days: {
    label: string;
    /** The calendar day's first instant. */
    dayStart: number;
    /** Where the slide starts telling: the day's start, or now on today. */
    from: number;
    end: number;
    today: boolean;
  }[] = [];
  if (to > now) {
    days.push({
      label: translate(locale, "today"),
      dayStart: todayStart,
      from: Math.max(todayStart, now),
      end: tomorrowStart,
      today: true,
    });
  }
  if (to >= dayAfterStart) {
    days.push({
      label: translate(locale, "tomorrow"),
      dayStart: tomorrowStart,
      from: tomorrowStart,
      end: dayAfterStart,
      today: false,
    });
  }
  const list = pagedList(document, "ul", "obrf-display-resources");
  for (const resource of body.resources) {
    const item = element(document, "li", "obrf-display-resource");
    item.append(element(document, "p", "obrf-display-title", resource.name));
    for (const day of days) {
      const row = element(document, "p", "obrf-display-day");
      row.append(
        element(document, "span", "obrf-display-day-label", day.label),
      );
      const busy = resource.busy
        .map((interval) => ({
          start: Date.parse(interval.start),
          end: Date.parse(interval.end),
        }))
        .filter(({ start, end }) => end > day.from && start < day.end);
      if (busy.length === 0) {
        row.append(
          element(
            document,
            "span",
            undefined,
            translate(locale, day.today ? "freeRestOfDay" : "freeAllDay"),
          ),
        );
      } else if (
        busy.length === 1 &&
        busy[0] !== undefined &&
        busy[0].start <= day.from &&
        busy[0].end >= day.end
      ) {
        row.append(
          element(
            document,
            "span",
            "obrf-display-busy",
            translate(locale, "busyAllDay"),
          ),
        );
      } else {
        row.append(
          element(document, "span", undefined, translate(locale, "busy")),
        );
        for (const interval of busy) {
          const start = Math.max(interval.start, day.dayStart);
          const end = Math.min(interval.end, day.end);
          row.append(
            element(
              document,
              "span",
              "obrf-display-busy obrf-display-data",
              translate(locale, "timeRange", {
                from: formatTime(start, locale, timeZone, "time"),
                to:
                  end === day.end
                    ? "24:00"
                    : formatTime(end, locale, timeZone, "time"),
              }),
            ),
          );
        }
      }
      item.append(row);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function picture(body: PictureBody, context: SlideContext): HTMLElement | null {
  const url = context.pictureUrl(body.picture);
  if (url === null) {
    return null;
  }
  const { document } = context;
  const section = container(context, "picture");
  const figure = element(document, "figure", "obrf-display-figure");
  figure.append(image(body.picture, url, context));
  if (body.caption !== null) {
    figure.append(
      element(document, "figcaption", "obrf-display-caption", body.caption),
    );
  }
  section.append(figure);
  return section;
}

function text(body: AddonTextBody, context: SlideContext): HTMLElement {
  const { document } = context;
  const section = container(context, "addon-text");
  section.append(
    element(document, "h2", "obrf-display-heading", body.heading),
    ...body.body.map((paragraph) =>
      element(document, "p", "obrf-display-text", paragraph),
    ),
  );
  return section;
}

function table(body: AddonTableBody, context: SlideContext): HTMLElement {
  const { document } = context;
  const section = container(context, "addon-table");
  const grid = element(document, "table", "obrf-display-table");
  const head = element(document, "thead");
  const headRow = element(document, "tr");
  for (const column of body.columns) {
    const cell = element(document, "th", undefined, column);
    cell.scope = "col";
    headRow.append(cell);
  }
  head.append(headRow);
  const rows = pagedList(document, "tbody");
  for (const row of body.rows) {
    const line = element(document, "tr");
    for (const cell of row) {
      line.append(element(document, "td", undefined, cell));
    }
    rows.append(line);
  }
  grid.append(head, rows);
  section.append(
    element(document, "h2", "obrf-display-heading", body.heading),
    grid,
  );
  return section;
}

function doors(body: AddonDoorsBody, context: SlideContext): HTMLElement {
  const { document, locale } = context;
  const section = container(context, "addon-doors");
  const list = pagedList(document, "ul", "obrf-display-doors");
  for (const door of body.doors) {
    const item = element(document, "li", "obrf-display-door");
    item.append(
      element(document, "span", "obrf-display-door-apartment", door.apartment),
    );
    if (door.floor !== null) {
      item.append(
        element(
          document,
          "span",
          "obrf-display-muted",
          translate(locale, "floor", { floor: door.floor }),
        ),
      );
    }
    for (const name of door.names) {
      item.append(element(document, "span", undefined, name));
    }
    list.append(item);
  }
  section.append(
    element(document, "h2", "obrf-display-heading", body.heading),
    list,
  );
  return section;
}

/** Whether the zone's wall clock at `time` is inside one of the windows. */
export function inSchedule(
  windows: readonly { days: readonly number[]; from: string; to: string }[],
  time: number,
  timeZone: string,
): boolean {
  if (windows.length === 0) {
    return true;
  }
  const parts = zonedParts(time, timeZone);
  const clock = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return windows.some(
    (window) =>
      window.days.includes(parts.weekday) &&
      window.from <= clock &&
      clock < window.to,
  );
}
