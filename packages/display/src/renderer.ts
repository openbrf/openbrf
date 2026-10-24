/**
 * The renderer: mounts on an element and shows a screen content document.
 *
 * It takes a document and nothing else, and fetches nothing. A picture comes
 * from a function its caller hands it, so that a device token never has to be
 * in a picture's URL; the caller fetches the bytes with the token in a header
 * and hands back an object URL.
 */
import type {
  PictureRef,
  ScreenContent,
  ScreenLocale,
  Slide,
} from "./contract.ts";
import {
  capitalised,
  element as newElement,
  formatTime,
  inSchedule,
  renderSlide,
} from "./slides.ts";
import { fitSlide } from "./fit.ts";
import { DISPLAY_STYLESHEET } from "./styles.ts";
import { translate, type Phrase } from "./translate.ts";
import { MINUTE, zonedDayStartAfter } from "./time.ts";

/** What the renderer is handed besides the element. */
export interface RendererOptions {
  /**
   * Hands back a URL the renderer may put in an `<img>`, or null when the
   * picture cannot be had. Called once for each `mediaFileId` and `version` a
   * document refers to, and the result reused while documents go on referring
   * to it; a null or a failure is asked again on a document shown five or more
   * minutes later. The renderer never fetches.
   */
  picture?: (ref: PictureRef) => Promise<string | null>;
  /**
   * Told when a URL `picture` handed back is no longer used: the documents
   * stopped referring to it, the browser could not show it, the renderer
   * showed a message, or it was destroyed. Told once for each URL each call
   * of `picture` handed back, also one that arrived after it was no longer
   * wanted. The place to revoke an object URL.
   */
  releasePicture?: (url: string, ref: PictureRef) => void;
  /** The clock, for tests. Timers are the global `setTimeout` and `clearTimeout`. */
  now?: () => Date;
}

/** How fresh the content being shown is. */
export interface DisplayStatus {
  /** When the content was last fetched, or confirmed by a 304. */
  fetchedAt: Date;
  /** True while the instance cannot be reached and this is the last good content. */
  stale: boolean;
}

/**
 * A full-screen message shown instead of content, with nothing from the
 * instance in it:
 *
 * - `loading`: no content yet.
 * - `link-invalid`: the instance refused the device token; the display link
 *   is no longer valid.
 * - `not-connected`: no content to show for 24 hours.
 * - `link-missing`: the address holds no device token.
 * - `paused`: the route is switched off (a plugin's device route answering 404).
 */
export type DisplayMessage =
  "loading" | "link-invalid" | "not-connected" | "link-missing" | "paused";

/** A mounted renderer. */
export interface DisplayRenderer {
  /**
   * Shows a document, replacing the previous one whole. The slide on screen
   * stays when the new document still has a slide with its id; otherwise the
   * rotation starts from the first. With `status.stale`, a small note says
   * when the content was fetched.
   *
   * A slide the canvas cannot hold whole, such as eight events or a long news
   * item, is shown a page at a time, each page for the slide's `seconds`, and
   * nothing on it is cut off.
   */
  show(content: ScreenContent, status?: DisplayStatus): void;
  /** Shows a message instead of content, in the given language. */
  message(kind: DisplayMessage, locale: ScreenLocale): void;
  /** Clears every timer and empties the element. */
  destroy(): void;
}

const MESSAGES: Readonly<
  Record<DisplayMessage, { title: Phrase; detail: Phrase | null }>
> = {
  loading: { title: "loading", detail: null },
  "link-invalid": { title: "linkInvalid", detail: "linkInvalidDetail" },
  "not-connected": { title: "notConnected", detail: "notConnectedDetail" },
  "link-missing": { title: "linkMissing", detail: "linkMissingDetail" },
  paused: { title: "paused", detail: "pausedDetail" },
};

const STYLE_ATTRIBUTE = "data-obrf-display";
const PICTURE_RETRY = 5 * MINUTE;

interface PictureEntry {
  ref: PictureRef;
  state: "pending" | "ready" | "failed";
  url: string | null;
  askedAt: number;
}

/**
 * Mounts a renderer on `element`, replacing what it holds, and adds the
 * stylesheet to its document once. Give the element a size, such as the whole
 * viewport: the canvas fills it, turned by the document's orientation.
 */
export function mountRenderer(
  element: HTMLElement,
  options: RendererOptions = {},
): DisplayRenderer {
  const document = element.ownerDocument;
  const clockNow = (): number =>
    (options.now ?? (() => new Date()))().getTime();
  addStylesheet(document);
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => newElement(document, tag, className, text);

  const root = make("div", "obrf-display obrf-display--dark");
  const canvas = make("div", "obrf-display-canvas");
  const clock = make("div", "obrf-display-clock");
  const clockDate = make("span", "obrf-display-clock-date");
  const clockTime = make("span", "obrf-display-clock-time");
  const stage = make("div", "obrf-display-stage");
  const note = make("div", "obrf-display-note");
  const off = make("div", "obrf-display-off");
  clock.append(clockDate, clockTime);
  canvas.append(clock, stage, note);
  root.append(canvas, off);
  clock.hidden = true;
  note.hidden = true;
  off.hidden = true;
  element.replaceChildren(root);

  let content: ScreenContent | null = null;
  let status: DisplayStatus | null = null;
  let current: {
    index: number;
    id: string;
    key: string;
    endsAt: number;
    /** The page of the slide's list on screen, of `pages`. */
    page: number;
    pages: number;
  } | null = null;
  /** A hundredth of the canvas's shorter side, in pixels; 0 before it has a size. */
  let unit = 0;
  let slideTimer: ReturnType<typeof setTimeout> | null = null;
  let minuteTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  const pictures = new Map<string, PictureEntry>();

  // The canvas is the element's box, turned. At 90 and 270 degrees its width
  // is the element's height, so it is sized from the element in pixels.
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => layout())
      : null;
  const view = document.defaultView;
  if (resizeObserver === null) {
    view?.addEventListener("resize", layout);
  } else {
    resizeObserver.observe(element);
  }
  const fonts = (document as { fonts?: FontFaceSet }).fonts;
  fonts?.addEventListener("loadingdone", refit);

  function layout(): void {
    const orientation = content?.layout.orientation ?? 0;
    const width = element.clientWidth;
    const height = element.clientHeight;
    const turned = orientation === 90 || orientation === 270;
    canvas.style.transform = `translate(-50%, -50%) rotate(${orientation}deg)`;
    if (turned && width > 0 && height > 0) {
      canvas.style.width = `${height}px`;
      canvas.style.height = `${width}px`;
    } else {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
    unit = width > 0 && height > 0 ? Math.min(width, height) / 100 : 0;
    if (unit > 0) {
      root.style.setProperty("--obrf-display-u", `${unit}px`);
    } else {
      root.style.removeProperty("--obrf-display-u");
    }
    const portrait = turned ? width > height : height > width;
    root.classList.toggle("obrf-display--portrait", portrait);
    for (const degrees of [0, 90, 180, 270]) {
      root.classList.toggle(
        `obrf-display--orientation-${degrees}`,
        degrees === orientation,
      );
    }
    refit();
  }

  /**
   * Fits the slide on screen again: a new size, or a typeface that has just
   * loaded, holds another number of items.
   */
  function refit(): void {
    const slide = stage.firstElementChild as HTMLElement | null;
    if (current !== null && slide?.classList.contains("obrf-display-slide")) {
      const { page, pages } = fitSlide(slide, unit, current.page);
      current = { ...current, page, pages };
    }
  }

  function setTheme(theme: "light" | "dark"): void {
    root.classList.toggle("obrf-display--light", theme === "light");
    root.classList.toggle("obrf-display--dark", theme === "dark");
  }

  function clearSlideTimer(): void {
    if (slideTimer !== null) {
      clearTimeout(slideTimer);
      slideTimer = null;
    }
  }

  function pictureKey(ref: PictureRef): string {
    return `${ref.mediaFileId}\u0000${ref.version}`;
  }

  function pictureOf(slide: Slide): PictureRef | null {
    const { body } = slide;
    if (body.kind === "news") {
      return body.picture;
    }
    return body.kind === "picture" ? body.picture : null;
  }

  function pictureUrl(ref: PictureRef): string | null {
    const entry = pictures.get(pictureKey(ref));
    return entry?.state === "ready" ? entry.url : null;
  }

  function release(entry: PictureEntry): void {
    if (entry.url !== null) {
      options.releasePicture?.(entry.url, entry.ref);
    }
  }

  function releaseAllPictures(): void {
    for (const entry of pictures.values()) {
      release(entry);
    }
    pictures.clear();
  }

  /** Asks for every picture the document refers to, and lets go of the rest. */
  function syncPictures(next: ScreenContent, now: number): void {
    const wanted = new Map<string, PictureRef>();
    for (const slide of next.rotation) {
      const ref = pictureOf(slide);
      if (ref !== null) {
        wanted.set(pictureKey(ref), ref);
      }
    }
    for (const [key, entry] of pictures) {
      if (!wanted.has(key)) {
        release(entry);
        pictures.delete(key);
      }
    }
    for (const [key, ref] of wanted) {
      const entry = pictures.get(key);
      if (
        entry === undefined ||
        (entry.state === "failed" && now - entry.askedAt >= PICTURE_RETRY)
      ) {
        ask(key, ref, now);
      }
    }
  }

  function ask(key: string, ref: PictureRef, now: number): void {
    const entry: PictureEntry = {
      ref,
      state: options.picture === undefined ? "failed" : "pending",
      url: null,
      askedAt: now,
    };
    pictures.set(key, entry);
    if (options.picture === undefined) {
      return;
    }
    let request: Promise<string | null>;
    try {
      request = options.picture(ref);
    } catch {
      entry.state = "failed";
      return;
    }
    request.then(
      (url) => settle(key, entry, url),
      () => settle(key, entry, null),
    );
  }

  function settle(key: string, entry: PictureEntry, url: string | null): void {
    if (destroyed || pictures.get(key) !== entry) {
      // Nobody wants it any more: hand it straight back.
      if (url !== null) {
        options.releasePicture?.(url, entry.ref);
      }
      return;
    }
    entry.state = url === null ? "failed" : "ready";
    entry.url = url;
    pictureChanged(key);
  }

  function pictureFailed(ref: PictureRef): void {
    const key = pictureKey(ref);
    const entry = pictures.get(key);
    if (entry === undefined || entry.state !== "ready") {
      return;
    }
    release(entry);
    entry.state = "failed";
    entry.url = null;
    pictureChanged(key);
  }

  /** A picture arrived or went: redraw the slide that shows it, or start the rotation it unblocks. */
  function pictureChanged(key: string): void {
    if (content === null) {
      return;
    }
    if (current === null) {
      startRotation();
      return;
    }
    const slide = content.rotation[current.index];
    const ref = slide === undefined ? null : pictureOf(slide);
    if (slide !== undefined && ref !== null && pictureKey(ref) === key) {
      if (slide.body.kind === "picture" && pictureUrl(ref) === null) {
        advance();
      } else {
        draw(
          slide,
          current.index,
          false,
          clockNow(),
          current.endsAt,
          current.page,
        );
      }
    }
  }

  function showable(slide: Slide, now: number): boolean {
    if (slide.until !== null && now >= Date.parse(slide.until)) {
      return false;
    }
    if (slide.body.kind === "picture") {
      return pictureUrl(slide.body.picture) !== null;
    }
    return true;
  }

  /** What a slide looks like now: redrawn only when this changes. */
  function slideKey(slide: Slide, shown: ScreenContent, now: number): string {
    const ref = pictureOf(slide);
    return JSON.stringify([
      slide,
      shown.locale,
      shown.timeZone,
      ref === null ? null : pictureUrl(ref),
      // Free and busy reads the clock: what has passed drops off each minute.
      slide.body.kind === "availability" ? Math.floor(now / MINUTE) : null,
      // The date on a news slide and the days of events are the zone's.
      zonedDayStartAfter(now, 0, shown.timeZone),
    ]);
  }

  /** Draws page `page` of a slide, or keeps it when it is already on screen. */
  function draw(
    slide: Slide,
    index: number,
    enter: boolean,
    now: number,
    endsAt: number,
    page = 0,
  ): void {
    if (content === null) {
      return;
    }
    const key = slideKey(slide, content, now);
    let fit = { page, pages: current?.pages ?? 1 };
    if (
      current === null ||
      current.id !== slide.id ||
      current.key !== key ||
      current.page !== page
    ) {
      const context = {
        document,
        locale: content.locale,
        timeZone: content.timeZone,
        now,
        pictureUrl,
        pictureFailed,
      };
      const node = renderSlide(slide, context);
      if (node === null) {
        current = null;
        advance();
        return;
      }
      stage.replaceChildren(node);
      const fitted = fitSlide(node, unit, page);
      if (enter) {
        node.classList.add("obrf-display-slide--enter");
      }
      fit = { page: fitted.page, pages: fitted.pages };
    }
    current = { index, id: slide.id, key, endsAt, ...fit };
    clearSlideTimer();
    const until = slide.until === null ? Infinity : Date.parse(slide.until);
    slideTimer = setTimeout(
      advance,
      Math.max(0, Math.min(endsAt, until) - now),
    );
  }

  /** Shows the first slide that can be shown at or after `from`, looping. */
  function showFrom(from: number, enter: boolean): void {
    if (content === null) {
      return;
    }
    const now = clockNow();
    const { rotation } = content;
    for (let step = 0; step < rotation.length; step += 1) {
      const index = (from + step) % rotation.length;
      const slide = rotation[index];
      if (slide !== undefined && showable(slide, now)) {
        // The slide on screen goes on, unless it comes back to its first page.
        const continuing =
          current !== null && current.id === slide.id && current.page === 0;
        draw(
          slide,
          index,
          enter && !continuing,
          now,
          now + slide.seconds * 1000,
        );
        return;
      }
    }
    // Nothing to show now: said quietly, so a screen just opened on a link
    // does not look broken. The minute tick and an arriving picture try again.
    clearSlideTimer();
    current = null;
    stage.replaceChildren(
      make(
        "p",
        "obrf-display-empty",
        translate(content.locale, "nothingToShow"),
      ),
    );
  }

  function startRotation(): void {
    showFrom(0, true);
  }

  /** The slide's next page, or the next slide after its last. */
  function advance(): void {
    slideTimer = null;
    const slide =
      current === null || content === null
        ? undefined
        : content.rotation[current.index];
    const now = clockNow();
    if (
      current !== null &&
      slide !== undefined &&
      current.page + 1 < current.pages &&
      showable(slide, now)
    ) {
      draw(
        slide,
        current.index,
        true,
        now,
        now + slide.seconds * 1000,
        current.page + 1,
      );
      return;
    }
    showFrom(current === null ? 0 : current.index + 1, true);
  }

  function updateClock(now: number): void {
    if (content === null || content.layout.header !== "clock") {
      clock.hidden = true;
      return;
    }
    clock.hidden = false;
    clockDate.textContent = capitalised(
      formatTime(now, content.locale, content.timeZone, "weekdayDate"),
    );
    clockTime.textContent = formatTime(
      now,
      content.locale,
      content.timeZone,
      "time",
    );
  }

  function updateNote(now: number): void {
    if (content === null || status === null || !status.stale) {
      note.hidden = true;
      return;
    }
    const fetchedAt = status.fetchedAt.getTime();
    const { locale, timeZone } = content;
    const sameDay =
      zonedDayStartAfter(fetchedAt, 0, timeZone) ===
      zonedDayStartAfter(now, 0, timeZone);
    const time = formatTime(fetchedAt, locale, timeZone, "time");
    // The date and time in the data face, the words around them not.
    const [before = "", after = ""] = translate(locale, "lastUpdated", {
      time: "\u0000",
    }).split("\u0000");
    note.replaceChildren(
      before,
      make(
        "span",
        "obrf-display-data",
        sameDay
          ? time
          : `${formatTime(fetchedAt, locale, timeZone, "date")} ${time}`,
      ),
      after,
    );
    note.hidden = false;
  }

  function updateSchedule(now: number): void {
    off.hidden =
      content === null ||
      inSchedule(content.schedule.on, now, content.timeZone);
  }

  /** Each minute: the clock, the schedule, the note, and a rotation that had nothing to show. */
  function tick(): void {
    minuteTimer = null;
    if (destroyed) {
      return;
    }
    const now = clockNow();
    updateClock(now);
    updateSchedule(now);
    updateNote(now);
    if (content !== null) {
      if (current === null) {
        startRotation();
      } else {
        const slide = content.rotation[current.index];
        if (
          slide !== undefined &&
          slideKey(slide, content, now) !== current.key
        ) {
          draw(slide, current.index, false, now, current.endsAt, current.page);
        }
      }
    }
    scheduleTick(clockNow());
  }

  function scheduleTick(now: number): void {
    if (minuteTimer !== null) {
      clearTimeout(minuteTimer);
    }
    minuteTimer = setTimeout(tick, MINUTE - (now % MINUTE));
  }

  return {
    show(next, nextStatus) {
      if (destroyed) {
        return;
      }
      const now = clockNow();
      const previous = current;
      content = next;
      status = nextStatus ?? null;
      root.lang = next.locale;
      setTheme(next.layout.theme);
      layout();
      syncPictures(next, now);
      updateClock(now);
      updateSchedule(now);
      updateNote(now);
      const kept =
        previous === null
          ? -1
          : next.rotation.findIndex((slide) => slide.id === previous.id);
      const keptSlide = kept === -1 ? undefined : next.rotation[kept];
      if (
        previous !== null &&
        keptSlide !== undefined &&
        showable(keptSlide, now)
      ) {
        draw(keptSlide, kept, false, now, previous.endsAt, previous.page);
      } else {
        current = null;
        clearSlideTimer();
        startRotation();
      }
      scheduleTick(now);
    },

    message(kind, locale) {
      if (destroyed) {
        return;
      }
      content = null;
      status = null;
      current = null;
      clearSlideTimer();
      releaseAllPictures();
      root.lang = locale;
      clock.hidden = true;
      note.hidden = true;
      off.hidden = true;
      layout();
      const words = MESSAGES[kind];
      const box = make("div", "obrf-display-message");
      box.setAttribute("role", "status");
      box.append(
        make("p", "obrf-display-message-title", translate(locale, words.title)),
      );
      if (words.detail !== null) {
        box.append(
          make(
            "p",
            "obrf-display-message-detail",
            translate(locale, words.detail),
          ),
        );
      }
      stage.replaceChildren(box);
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      clearSlideTimer();
      if (minuteTimer !== null) {
        clearTimeout(minuteTimer);
        minuteTimer = null;
      }
      resizeObserver?.disconnect();
      view?.removeEventListener("resize", layout);
      fonts?.removeEventListener("loadingdone", refit);
      releaseAllPictures();
      content = null;
      current = null;
      element.replaceChildren();
    },
  };
}

function addStylesheet(document: Document): void {
  if (document.head.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = DISPLAY_STYLESHEET;
  document.head.append(style);
}
