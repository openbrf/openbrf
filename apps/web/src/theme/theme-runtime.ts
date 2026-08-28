import {
  buildFontFaceStylesheet,
  type ThemeFontFaceSource,
} from "@openbrf/theme-tools";
import {
  buildThemeStylesheet,
  type TokenSet,
  tokenValueProblem,
} from "@openbrf/tokens";

import type { ThemeRendering } from "../api/themes";
import { reapplyAccentOverride, setAccentBaseModes } from "./accent-override";

/**
 * An installed theme, applied to the running page.
 *
 * The default theme's values are a static stylesheet built at compile time, so
 * an installed theme has to arrive at runtime. It arrives as a stylesheet
 * rather than as inline styles on the root element for the same reason the
 * accent override does: the three-block shape the theme engine uses cannot be
 * expressed inline, and pinning one mode's values to both would break the light
 * and dark switch.
 *
 * This is also what live preview is. Applying a rendering writes a style
 * element into this browser and nothing else, so a board member trying a theme
 * changes nothing for anybody else and nothing at all until they activate.
 *
 * Values are re-validated here even though the API refuses an unsafe one at
 * install time. This function writes text into a stylesheet, and a boundary
 * that writes CSS checks its own input rather than trusting that some earlier
 * boundary did.
 */

const TOKENS_ELEMENT_ID = "openbrf-theme-tokens";
const FONTS_ELEMENT_ID = "openbrf-theme-fonts";

function upsertStyle(id: string, css: string): void {
  const existing = document.getElementById(id);

  if (css === "") {
    existing?.remove();
    return;
  }

  const style =
    existing instanceof HTMLStyleElement
      ? existing
      : document.createElement("style");
  style.id = id;
  style.textContent = css;

  if (style.parentNode === null) {
    document.head.append(style);
  }
}

/** Drops any value that has no business inside a declaration block. */
function safeTokens(values: Record<string, string>): TokenSet {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (tokenValueProblem(value) === null) {
      safe[name] = value;
    }
  }
  return safe as TokenSet;
}

/**
 * Applies a rendering, or removes any applied theme when given null.
 *
 * The built-in theme is applied by removing the elements rather than by writing
 * its values out: its values are already the first stylesheet the browser
 * parsed, and re-stating them would only add a second copy to keep in step.
 */
export function applyThemeRendering(rendering: ThemeRendering | null): void {
  if (rendering === null || rendering.builtIn) {
    upsertStyle(TOKENS_ELEMENT_ID, "");
    upsertStyle(FONTS_ELEMENT_ID, "");
    setAccentBaseModes(null);
    reapplyAccentOverride();
    return;
  }

  upsertStyle(
    TOKENS_ELEMENT_ID,
    buildThemeStylesheet({
      light: safeTokens(rendering.modes.light),
      dark: safeTokens(rendering.modes.dark),
    }),
  );

  upsertStyle(
    FONTS_ELEMENT_ID,
    buildFontFaceStylesheet(rendering.fontFaces as ThemeFontFaceSource[]),
  );

  /*
   * The housing cooperative's own accent is derived from whichever theme is
   * active, not always from the default one. Deriving it from the default while
   * a different theme renders would measure the accent against surfaces that
   * are not on the screen, and the register pairs are the statutory ones.
   *
   * Re-applied after the theme so its style element stays last in the document
   * and therefore still wins at equal specificity.
   */
  setAccentBaseModes({
    light: safeTokens(rendering.modes.light),
    dark: safeTokens(rendering.modes.dark),
  });
  reapplyAccentOverride();
}
