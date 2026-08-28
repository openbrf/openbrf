import { resolveViewVariant } from "@openbrf/theme-tools";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  /** Re-reads the active theme, e.g. after activating one. False when the read failed. */
  reload: () => Promise<boolean>;
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
   * The number of the newest read, so an older one cannot commit.
   *
   * The read this provider starts on mount and the read an activation asks for
   * go to the same endpoint at the same time, and nothing makes the answers
   * come back in the order they were sent. Without this, a mount read that
   * captured the theme active before the activation and landed after it would
   * put that theme back, and a board member would watch the one they just
   * activated disappear.
   */
  const newestRead = useRef(0);

  /**
   * Re-reads the active theme, answering whether the read landed.
   *
   * A failure is not reported to the viewer here: the generated default
   * stylesheet is already in the document, so the interface stays styled. The
   * rendering already applied is kept rather than cleared, because dropping it
   * would repaint every open page over a moment of network trouble. What the
   * caller gets instead is the failure: after an activation this browser is a
   * version behind what the instance renders, and only the screen that asked
   * for the activation is in a position to say so.
   *
   * A read a later one has overtaken still answers its own caller. What it does
   * not do is decide what is rendered, which belongs to the newest read.
   */
  const reload = useCallback(async (): Promise<boolean> => {
    const read = (newestRead.current += 1);
    const result = await fetchActiveTheme();
    if (!result.ok) {
      return false;
    }
    if (read === newestRead.current) {
      setActive(result.value);
    }
    return true;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
