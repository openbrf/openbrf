import { resolveViewVariant } from "@openbrf/theme-tools";
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

import { fetchActiveTheme, type ThemeRendering } from "../api/themes";
import { applyThemeRendering } from "./theme-runtime";

/**
 * Which theme this browser is rendering.
 *
 * Two things live here rather than in the screens. The active theme is fetched
 * once and applied before anything depends on it, so the sign-in screen is
 * themed as well as the application - that endpoint is deliberately public for
 * exactly this reason. And the preview is held here rather than in the theme
 * screen, so a board member who previews a theme and then navigates elsewhere
 * keeps seeing the preview instead of it vanishing on a route change.
 *
 * A preview is applied to this browser and to nothing else. Nothing is written
 * and no other viewer is affected until the theme is activated.
 */

interface ThemeRuntimeValue {
  /** What the instance renders. Null until the first read lands. */
  active: ThemeRendering | null;
  /** The theme being previewed, if any. */
  previewing: ThemeRendering | null;
  /** What is applied to this browser right now: the preview, or the active one. */
  applied: ThemeRendering | null;
  /** Applies a theme to this browser only. Null returns to the active one. */
  preview: (rendering: ThemeRendering | null) => void;
  /** Re-reads the active theme, e.g. after activating one. */
  reload: () => Promise<void>;
}

const ThemeRuntimeContext = createContext<ThemeRuntimeValue | undefined>(
  undefined,
);

export function ThemeRuntimeProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [active, setActive] = useState<ThemeRendering | null>(null);
  const [previewing, setPreviewing] = useState<ThemeRendering | null>(null);

  /**
   * Reads the active theme, or null when the read failed.
   *
   * A failure is not reported to the viewer: the generated default stylesheet
   * is already in the document, so the interface stays styled, and nobody
   * asked for this read.
   */
  const read = useCallback(async (): Promise<ThemeRendering | null> => {
    const result = await fetchActiveTheme();
    return result.ok ? result.value : null;
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const rendering = await read();
    if (rendering !== null) {
      setActive(rendering);
    }
  }, [read]);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // provider is gone.
    let live = true;
    void read().then((rendering) => {
      if (live && rendering !== null) {
        setActive(rendering);
      }
    });
    return () => {
      live = false;
    };
  }, [read]);

  // One effect owns what is on the document, so the preview and the active
  // theme cannot both write to it and disagree about which won.
  useEffect(() => {
    applyThemeRendering(previewing ?? active);
  }, [previewing, active]);

  const value = useMemo<ThemeRuntimeValue>(
    () => ({
      active,
      previewing,
      applied: previewing ?? active,
      preview: setPreviewing,
      reload,
    }),
    [active, previewing, reload],
  );

  return (
    <ThemeRuntimeContext.Provider value={value}>
      {children}
    </ThemeRuntimeContext.Provider>
  );
}

export function useThemeRuntime(): ThemeRuntimeValue {
  const context = useContext(ThemeRuntimeContext);
  if (context === undefined) {
    throw new Error(
      "useThemeRuntime must be used inside a ThemeRuntimeProvider.",
    );
  }
  return context;
}

/**
 * The runtime, or null outside the provider.
 *
 * For a component that only mentions the theme in passing. Throwing would be
 * right for the theme screen, which cannot do its job without the runtime, and
 * wrong for a panel whose one job is a link: it would take down the screen it
 * sits on because it could not name a theme.
 */
export function useOptionalThemeRuntime(): ThemeRuntimeValue | null {
  return useContext(ThemeRuntimeContext) ?? null;
}

/**
 * The layout a view should draw for one of the core's view variant slots.
 *
 * A theme may choose among layouts the core maintains; it may not ship one. So
 * this always answers with a variant the core has, falling back to that slot's
 * default when the theme says nothing - which is also what happens for the
 * built-in theme and while the active theme is still loading.
 */
export function useViewVariant(slot: string): string | undefined {
  const { applied } = useThemeRuntime();
  return resolveViewVariant(slot, applied?.viewVariants);
}
