import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyThemeMode,
  DEFAULT_THEME_MODE,
  initializeThemeMode,
  isThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  storeThemeMode,
  THEME_MODE_STORAGE_KEY,
  type ThemePreferenceStorage,
} from "./theme-mode";

/**
 * The mode logic is free of React so it can run before the first render.
 *
 * Storage is injected rather than stubbed globally. Node 26 ships its own
 * experimental localStorage that is unavailable without --localstorage-file and
 * shadows jsdom's, so a test leaning on the global fails for reasons unrelated
 * to this code.
 */

function memoryStorage(initial?: string): ThemePreferenceStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) {
    map.set(THEME_MODE_STORAGE_KEY, initial);
  }
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** Storage that denies access, as in a private window. */
const hostileStorage: ThemePreferenceStorage = {
  getItem: () => {
    throw new Error("access denied");
  },
  setItem: () => {
    throw new Error("access denied");
  },
};

function setPrefersDark(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") ? matches : !matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyThemeMode", () => {
  it("writes an explicit choice so it beats the system preference", () => {
    applyThemeMode("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    applyThemeMode("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("removes the attribute for system rather than writing a resolved value", () => {
    applyThemeMode("dark");
    applyThemeMode("system");

    // Writing "light" here would freeze the choice, so a viewer who changed
    // their OS appearance mid-session would stop following it.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("resolveThemeMode", () => {
  it("returns an explicit mode unchanged", () => {
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("light")).toBe("light");
  });

  it("follows the system preference for system", () => {
    setPrefersDark(true);
    expect(resolveThemeMode("system")).toBe("dark");
    setPrefersDark(false);
    expect(resolveThemeMode("system")).toBe("light");
  });

  it("falls back to light when the browser cannot be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveThemeMode("system")).toBe("light");
  });
});

describe("stored preference", () => {
  it("round-trips a choice", () => {
    const storage = memoryStorage();
    storeThemeMode("dark", storage);
    expect(readStoredThemeMode(storage)).toBe("dark");
    expect(storage.getItem(THEME_MODE_STORAGE_KEY)).toBe("dark");
  });

  it("defaults when nothing is stored", () => {
    expect(readStoredThemeMode(memoryStorage())).toBe(DEFAULT_THEME_MODE);
  });

  it("ignores a stored value that is not a mode", () => {
    expect(readStoredThemeMode(memoryStorage("chartreuse"))).toBe(
      DEFAULT_THEME_MODE,
    );
  });

  it("defaults when there is no storage at all", () => {
    expect(readStoredThemeMode(undefined)).toBe(DEFAULT_THEME_MODE);
    expect(() => {
      storeThemeMode("dark", undefined);
    }).not.toThrow();
  });

  it("survives storage that throws, as in a private window", () => {
    expect(() => readStoredThemeMode(hostileStorage)).not.toThrow();
    expect(readStoredThemeMode(hostileStorage)).toBe(DEFAULT_THEME_MODE);
    expect(() => {
      storeThemeMode("dark", hostileStorage);
    }).not.toThrow();
  });
});

describe("initializeThemeMode", () => {
  it("applies the stored choice immediately, before any render", () => {
    const mode = initializeThemeMode(memoryStorage("dark"));

    expect(mode).toBe("dark");
    // This is what stops a light frame flashing past for a dark-mode viewer.
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("leaves the document alone for system", () => {
    const mode = initializeThemeMode(memoryStorage("system"));

    expect(mode).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("isThemeMode", () => {
  it.each(["system", "light", "dark"])("accepts %s", (value) => {
    expect(isThemeMode(value)).toBe(true);
  });

  it.each([["auto"], [""], [null], [undefined], [42]])(
    "rejects %s",
    (value) => {
      expect(isThemeMode(value)).toBe(false);
    },
  );
});
