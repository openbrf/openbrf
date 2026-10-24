import {
  mountRenderer,
  startFetchLoop,
  type CachedScreenContent,
  type PictureRef,
  type ScreenContentCache,
} from "@openbrf/display";
import { useEffect, useRef, type ReactElement } from "react";

/**
 * The display page (ADR 0050): the display mode on a screen in the building,
 * opened from a display link.
 *
 * Outside the signed-in frame, and nothing on it reads a session. The token
 * arrives in the link's fragment, which a browser never sends to a server, so
 * it is in no request log; the page keeps it in `localStorage` and takes the
 * fragment out of the address at once, so the token is not left on the screen
 * or in the browser's history. The page's own query is the screen's options,
 * sent unchanged as the query of every content request, with the token in
 * `Authorization` and no cookie.
 *
 * What is done with each answer is the fetch loop's, and what is shown is the
 * renderer's, both from `@openbrf/display`, the same code a paired screen's
 * player runs. On a refused token the page forgets the token and its cached
 * content and says that the display link is no longer valid.
 */

/** Where the page keeps the token between visits. */
export const DISPLAY_TOKEN_KEY = "openbrf.display.token";

/** Where it keeps the last content, with the query it was fetched for. */
export const DISPLAY_CONTENT_KEY = "openbrf.display.content";

/** The content route, and the pictures route beside it. */
const CONTENT_PATH = "/api/display/content";
const PICTURES_PATH = "/api/display/pictures/";

export function DisplayPage(): ReactElement {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = element.current;
    if (target === null) {
      return;
    }
    const search = window.location.search;
    // Held here as well as kept, so a screen whose storage refuses still
    // shows the content while the page is open.
    let token = takeToken();
    const locale = linkLocale(search);
    const pictures = new PictureUrls(() => token);
    const renderer = mountRenderer(target, {
      picture: (ref) => pictures.urlFor(ref),
      releasePicture: (url, ref) => pictures.letGo(url, ref),
    });

    if (token === null) {
      renderer.message("link-missing", locale);
      return () => {
        renderer.destroy();
        pictures.release();
      };
    }

    renderer.message("loading", locale);
    const loop = startFetchLoop({
      url: new URL(`${CONTENT_PATH}${search}`, window.location.origin).href,
      token: () => token,
      cache: contentCache(search),
      onContent: (content, status) => {
        renderer.show(content, status);
      },
      onRevoked: () => {
        // The loop has cleared the content; the token goes with it.
        token = null;
        forget(DISPLAY_TOKEN_KEY);
        pictures.release();
        renderer.message("link-invalid", locale);
      },
      onDisconnected: () => {
        renderer.message("not-connected", locale);
      },
    });

    return () => {
      loop.stop();
      renderer.destroy();
      pictures.release();
    };
  }, []);

  return (
    <div
      ref={element}
      className="fixed inset-0 overflow-hidden bg-black"
      data-testid="display-page"
    />
  );
}

/**
 * The token: the one in the address's fragment, which replaces any kept
 * before, or the one kept from an earlier visit, or null.
 *
 * A new token is a new link, so the content kept for the old one goes. The
 * fragment is taken out of the address whatever it held, with
 * `history.replaceState`, so the address bar and the history keep the query
 * and nothing after it.
 */
function takeToken(): string | null {
  const fragment = window.location.hash.replace(/^#/, "");
  if (fragment !== "") {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    if (fragment !== storedToken()) {
      keep(DISPLAY_TOKEN_KEY, fragment);
      forget(DISPLAY_CONTENT_KEY);
    }
    return fragment;
  }
  return storedToken();
}

function storedToken(): string | null {
  const token = read(DISPLAY_TOKEN_KEY);
  return token === null || token === "" ? null : token;
}

/** The language a message before any content is in: the link's, or Swedish. */
function linkLocale(search: string): "sv" | "en" {
  return new URLSearchParams(search).get("locale") === "en" ? "en" : "sv";
}

/**
 * The cached content, kept with the query it was fetched for: content fetched
 * for other options is not this link's, and is not shown for it.
 *
 * The page holds the entry itself, and `localStorage` only carries it over a
 * reload, as with the token: a screen whose storage refuses still shows the
 * last content through a failed fetch for as long as the page is open. The
 * kept entry is read once, while the page holds none of its own, and a clear
 * forgets both.
 */
function contentCache(search: string): ScreenContentCache {
  // Undefined until the kept entry has been read.
  let held: CachedScreenContent | null | undefined;
  return {
    read: () => {
      if (held === undefined) {
        held = storedContent(search);
      }
      return held;
    },
    write: (entry) => {
      held = entry;
      keep(DISPLAY_CONTENT_KEY, JSON.stringify({ search, entry }));
    },
    clear: () => {
      held = null;
      forget(DISPLAY_CONTENT_KEY);
    },
  };
}

function storedContent(search: string): CachedScreenContent | null {
  const stored = read(DISPLAY_CONTENT_KEY);
  if (stored === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as {
      search?: unknown;
      entry?: CachedScreenContent;
    };
    return parsed.search === search && parsed.entry !== undefined
      ? parsed.entry
      : null;
  } catch {
    return null;
  }
}

/**
 * The pictures the renderer asks for, fetched with the token in
 * `Authorization` so that it is never in a picture's address, and handed to
 * the renderer as object URLs, one per picture and version.
 *
 * A picture asked for again while it is on its way is fetched once. One that
 * could not be had is forgotten, so the renderer's next ask fetches it again.
 * One the renderer lets go of as often as it was handed out is revoked, so a
 * screen left on for months holds only the pictures its content still shows.
 */
class PictureUrls {
  private readonly pictures = new Map<
    string,
    { url: Promise<string | null>; href: string | null; holders: number }
  >();

  constructor(private readonly token: () => string | null) {}

  urlFor(ref: PictureRef): Promise<string | null> {
    const key = pictureKey(ref);
    const known = this.pictures.get(key);
    if (known !== undefined) {
      known.holders += 1;
      return known.url;
    }
    const picture = {
      url: this.fetch(ref.mediaFileId).then((href) => {
        if (href === null) {
          if (this.pictures.get(key) === picture) {
            this.pictures.delete(key);
          }
        } else {
          picture.href = href;
        }
        return href;
      }),
      href: null as string | null,
      holders: 1,
    };
    this.pictures.set(key, picture);
    return picture.url;
  }

  /** The renderer no longer shows `url`: revoked once nothing holds it. */
  letGo(url: string, ref: PictureRef): void {
    const key = pictureKey(ref);
    const picture = this.pictures.get(key);
    if (picture !== undefined && picture.href === url) {
      picture.holders -= 1;
      if (picture.holders > 0) {
        return;
      }
      this.pictures.delete(key);
    }
    URL.revokeObjectURL(url);
  }

  /** Revokes every picture, including those still on their way. */
  release(): void {
    for (const { url } of this.pictures.values()) {
      void url.then((href) => {
        if (href !== null) {
          URL.revokeObjectURL(href);
        }
      });
    }
    this.pictures.clear();
  }

  private async fetch(mediaFileId: string): Promise<string | null> {
    const token = this.token();
    if (token === null) {
      return null;
    }
    try {
      const answer = await fetch(
        `${PICTURES_PATH}${encodeURIComponent(mediaFileId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          credentials: "omit",
          cache: "no-store",
        },
      );
      // Anything but the picture: its slide is shown without it.
      return answer.ok ? URL.createObjectURL(await answer.blob()) : null;
    } catch {
      return null;
    }
  }
}

function pictureKey(ref: PictureRef): string {
  return `${ref.mediaFileId}\n${ref.version}`;
}

/*
 * `localStorage` can refuse - a private window, storage switched off - and a
 * screen that cannot keep its token still shows the content while the page is
 * open; it only cannot survive a reload.
 */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // See above.
  }
}

function forget(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // See above.
  }
}
