import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  applyThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  storeThemeMode,
  type ThemeMode,
} from "./theme-mode";

interface ThemeModeContextValue {
  /** What the viewer chose, which may be "system". */
  mode: ThemeMode;
  /** Which palette that currently renders as. */
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | undefined>(
  undefined,
);

/**
 * Provides the theme mode and keeps the document in step with it.
 *
 * The initial state is read from storage rather than defaulted, because the
 * entry module has already applied that value to the document; defaulting here
 * would make React disagree with the DOM on the first render.
 */
export function ThemeModeProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [mode, setModeState] = useState<ThemeMode>(readStoredThemeMode);
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolveThemeMode(readStoredThemeMode()),
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    storeThemeMode(next);
    applyThemeMode(next);
    setResolved(resolveThemeMode(next));
  }, []);

  // Follow the system while the choice is "system". Without this, a viewer who
  // changes their OS appearance keeps the old palette until a reload.
  useEffect(() => {
    if (mode !== "system") {
      return;
    }
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (query === undefined) {
      return;
    }
    const onChange = (): void => {
      setResolved(resolveThemeMode("system"));
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [mode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return (
    <ThemeModeContext.Provider value={value}>
      {children}
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode(): ThemeModeContextValue {
  const context = useContext(ThemeModeContext);
  if (context === undefined) {
    throw new Error("useThemeMode must be used inside a ThemeModeProvider.");
  }
  return context;
}
