/**
 * Theme mode: light, dark, or follow the system.
 *
 * The generated stylesheet already handles all three states, so this module's
 * only job is to set (or clear) `data-theme` on the document element:
 *
 *   "system" -> no attribute, and prefers-color-scheme decides
 *   "light"  -> data-theme="light", which beats a dark system preference
 *   "dark"   -> data-theme="dark", which beats a light system preference
 *
 * Deliberately free of React so it can run before the app mounts, which is what
 * stops a light flash on load for a viewer who chose dark.
 */

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DEFAULT_THEME_MODE: ThemeMode = "system";

/** Where the choice is remembered until the account setting exists. */
export const THEME_MODE_STORAGE_KEY = "openbrf.theme-mode";

/**
 * The slice of Web Storage this module needs.
 *
 * Taken as a parameter rather than reached for globally so tests can inject a
 * deterministic one. That is not only for convenience: Node 26 ships its own
 * experimental `localStorage` global which is unavailable unless the process
 * was started with --localstorage-file, and it shadows the one jsdom provides.
 * Depending on the global in tests therefore fails for a reason that has
 * nothing to do with this code.
 */
export interface ThemePreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * The browser's storage, when it is usable.
 *
 * Returns undefined rather than throwing: a private window, cleared site data,
 * or a browser configured to block storage are all normal, and a theme
 * preference must never be able to break the application.
 */
export function browserThemeStorage(): ThemePreferenceStorage | undefined {
  try {
    const storage = globalThis.localStorage;
    return storage === undefined || storage === null ? undefined : storage;
  } catch {
    return undefined;
  }
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return (
    typeof value === "string" &&
    (THEME_MODES as readonly string[]).includes(value)
  );
}

/**
 * Reads the stored preference.
 *
 * Every access is guarded: storage throws rather than returning null in a
 * private window or when a browser is set to block site data, and a theme
 * preference is never worth breaking the application over.
 */
export function readStoredThemeMode(
  storage: ThemePreferenceStorage | undefined = browserThemeStorage(),
): ThemeMode {
  try {
    const stored = storage?.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function storeThemeMode(
  mode: ThemeMode,
  storage: ThemePreferenceStorage | undefined = browserThemeStorage(),
): void {
  try {
    storage?.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference is not persisted; the session still honours the choice.
  }
}

/**
 * Applies a mode to the document.
 *
 * "system" removes the attribute rather than writing a resolved value, so a
 * viewer who changes their OS appearance mid-session follows along without the
 * page being reloaded.
 */
export function applyThemeMode(
  mode: ThemeMode,
  element: HTMLElement | undefined = globalThis.document?.documentElement,
): void {
  if (element === undefined) {
    return;
  }
  if (mode === "system") {
    element.removeAttribute("data-theme");
    return;
  }
  element.setAttribute("data-theme", mode);
}

/** Which palette a mode currently renders as, resolving "system". */
export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") {
    return mode;
  }
  const prefersDark =
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  return prefersDark ? "dark" : "light";
}

/**
 * Applies the stored preference immediately.
 *
 * Called from the entry module before React renders. Without this, a viewer who
 * chose dark sees a light frame first, because the attribute would not exist
 * until the provider's first effect ran.
 */
export function initializeThemeMode(
  storage: ThemePreferenceStorage | undefined = browserThemeStorage(),
): ThemeMode {
  const mode = readStoredThemeMode(storage);
  applyThemeMode(mode);
  return mode;
}
