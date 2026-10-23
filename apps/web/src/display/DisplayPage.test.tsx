import { render } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  DISPLAY_CONTENT_KEY,
  DISPLAY_TOKEN_KEY,
  DisplayPage,
} from "./DisplayPage";

/**
 * The display page (ADR 0050): where it takes the token from, where it keeps
 * it, and what it forgets when the display route refuses it. What the page
 * shows and how it reads each answer are the renderer's and the fetch loop's,
 * tested in `@openbrf/display`, and stood in for here.
 */

const renderer = {
  show: vi.fn(),
  message: vi.fn(),
  destroy: vi.fn(),
};
const loop = { stop: vi.fn(), refreshNow: vi.fn() };
const startFetchLoop = vi.fn((_options: unknown) => loop);

vi.mock("@openbrf/display", () => ({
  mountRenderer: () => renderer,
  startFetchLoop: (options: unknown) => startFetchLoop(options),
}));

interface LoopOptions {
  url: string;
  token: () => string | null;
  cache: { write(entry: unknown): void; read(): unknown; clear(): void };
  onRevoked(): void;
}

function loopOptions(): LoopOptions {
  const options = startFetchLoop.mock.calls[0]?.[0];
  if (options === undefined) {
    throw new Error("The fetch loop was not started.");
  }
  return options as LoopOptions;
}

beforeEach(() => {
  window.localStorage.clear();
  renderer.show.mockReset();
  renderer.message.mockReset();
  renderer.destroy.mockReset();
  startFetchLoop.mockClear();
  loop.stop.mockReset();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("the display page", () => {
  it("takes the token from the fragment, keeps it, and takes it out of the address", () => {
    window.history.replaceState(
      null,
      "",
      "/app/display?sources=news&theme=light#obrf_dt_fresh",
    );

    render(<DisplayPage />);

    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?sources=news&theme=light");
    expect(window.localStorage.getItem(DISPLAY_TOKEN_KEY)).toBe(
      "obrf_dt_fresh",
    );
    const options = loopOptions();
    // The page's query, unchanged, and the token nowhere in the URL.
    expect(options.url).toBe(
      `${window.location.origin}/api/display/content?sources=news&theme=light`,
    );
    expect(options.url).not.toContain("obrf_dt_");
    expect(options.token()).toBe("obrf_dt_fresh");
  });

  it("uses the token kept from an earlier visit", () => {
    window.localStorage.setItem(DISPLAY_TOKEN_KEY, "obrf_dt_kept");
    window.history.replaceState(null, "", "/app/display");

    render(<DisplayPage />);

    expect(loopOptions().token()).toBe("obrf_dt_kept");
  });

  it("forgets the content kept for another link when a new one is opened", () => {
    window.localStorage.setItem(DISPLAY_TOKEN_KEY, "obrf_dt_old");
    window.localStorage.setItem(DISPLAY_CONTENT_KEY, "{}");
    window.history.replaceState(null, "", "/app/display#obrf_dt_new");

    render(<DisplayPage />);

    expect(window.localStorage.getItem(DISPLAY_CONTENT_KEY)).toBeNull();
    expect(window.localStorage.getItem(DISPLAY_TOKEN_KEY)).toBe("obrf_dt_new");
  });

  it("says a link is missing, and asks nothing, without a token", () => {
    window.history.replaceState(null, "", "/app/display?locale=en");

    render(<DisplayPage />);

    expect(startFetchLoop).not.toHaveBeenCalled();
    expect(renderer.message).toHaveBeenCalledWith("link-missing", "en");
  });

  it("forgets the token and says the link is no longer valid when it is refused", () => {
    window.history.replaceState(null, "", "/app/display#obrf_dt_revoked");

    render(<DisplayPage />);
    loopOptions().onRevoked();

    expect(window.localStorage.getItem(DISPLAY_TOKEN_KEY)).toBeNull();
    expect(loopOptions().token()).toBeNull();
    expect(renderer.message).toHaveBeenLastCalledWith("link-invalid", "sv");
  });

  it("keeps the content with the query it was fetched for", () => {
    window.history.replaceState(null, "", "/app/display?theme=light#obrf_dt_a");

    render(<DisplayPage />);
    const entry = {
      content: {},
      etag: '"x"',
      fetchedAt: "2026-10-23T08:00:00Z",
    };
    loopOptions().cache.write(entry);

    expect(loopOptions().cache.read()).toEqual(entry);
    expect(
      JSON.parse(window.localStorage.getItem(DISPLAY_CONTENT_KEY) ?? "null"),
    ).toEqual({ search: "?theme=light", entry });
  });

  it("does not show content kept for a link with other options", () => {
    window.localStorage.setItem(DISPLAY_TOKEN_KEY, "obrf_dt_a");
    window.localStorage.setItem(
      DISPLAY_CONTENT_KEY,
      JSON.stringify({
        search: "?theme=dark",
        entry: { content: {}, etag: null, fetchedAt: "2026-10-23T08:00:00Z" },
      }),
    );
    window.history.replaceState(null, "", "/app/display?theme=light");

    render(<DisplayPage />);

    expect(loopOptions().cache.read()).toBeNull();
  });

  it("holds the content itself when the storage refuses it, and forgets it on a clear", () => {
    window.history.replaceState(null, "", "/app/display#obrf_dt_a");
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Refused.", "QuotaExceededError");
      });
    try {
      render(<DisplayPage />);
      const { cache } = loopOptions();
      const entry = {
        content: {},
        etag: '"x"',
        fetchedAt: "2026-10-23T08:00:00Z",
      };
      cache.write(entry);

      // A failed fetch after this one still finds it, for the 24 hours.
      expect(window.localStorage.getItem(DISPLAY_CONTENT_KEY)).toBeNull();
      expect(cache.read()).toEqual(entry);

      cache.clear();
      expect(cache.read()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("forgets the content it holds and the content it kept on a clear", () => {
    window.history.replaceState(null, "", "/app/display#obrf_dt_a");

    render(<DisplayPage />);
    const { cache } = loopOptions();
    cache.write({ content: {}, etag: null, fetchedAt: "2026-10-23T08:00:00Z" });
    cache.clear();

    expect(cache.read()).toBeNull();
    expect(window.localStorage.getItem(DISPLAY_CONTENT_KEY)).toBeNull();
  });

  it("stops asking when it is left", () => {
    window.history.replaceState(null, "", "/app/display#obrf_dt_a");

    const page = render(<DisplayPage />);
    page.unmount();

    expect(loop.stop).toHaveBeenCalled();
    expect(renderer.destroy).toHaveBeenCalled();
  });
});
