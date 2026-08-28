import {
  buildAccentOverrideStylesheet,
  PORTTAVLAN,
  primaryColorOverride,
  type ThemeModes,
} from "@openbrf/tokens";

/**
 * The housing cooperative's own accent colour, applied to the running page.
 *
 * The generated default stylesheet is a static file, so a per-association
 * colour has to arrive at runtime. It arrives as a stylesheet rather than as
 * inline styles on the root element, because the override has to keep the
 * three-block shape the theme engine uses: light on :root, dark under
 * prefers-color-scheme, and dark again under [data-theme="dark"] so an explicit
 * choice still wins in both directions. Inline styles have no media queries and
 * would pin one mode's accent to both.
 *
 * A colour the contrast matrix refuses is ignored. The API refuses to store one
 * in the first place, so this is the second line rather than the first, and
 * silently keeping the theme's own legible accent is the right failure: an
 * association must be able to read its own register.
 *
 * The accent is derived against whichever theme is active, not always against
 * the default one. Deriving it against surfaces that are not on the screen
 * would measure the wrong contrast, and the register pairs are the statutory
 * ones. An installed theme sets the base modes when it is applied; with no
 * theme applied the base is the default theme.
 */

const STYLE_ELEMENT_ID = "openbrf-accent-override";

/** What the accent is measured and mixed against. Null means the default theme. */
let baseModes: ThemeModes | null = null;

/** The colour last applied, so a theme change can re-derive it. */
let currentPrimaryColor: string | null = null;

export function setAccentBaseModes(modes: ThemeModes | null): void {
  baseModes = modes;
}

export function applyAccentOverride(primaryColor: string | null): void {
  currentPrimaryColor = primaryColor;
  const existing = document.getElementById(STYLE_ELEMENT_ID);

  if (primaryColor === null || primaryColor === "") {
    existing?.remove();
    return;
  }

  const result = primaryColorOverride(primaryColor, baseModes ?? PORTTAVLAN);
  if (!result.ok) {
    existing?.remove();
    return;
  }

  const style =
    existing instanceof HTMLStyleElement
      ? existing
      : document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = buildAccentOverrideStylesheet(result.override);

  if (style.parentNode === null) {
    // Appended last so it wins over the generated theme at equal specificity,
    // which is what makes it an override rather than a suggestion.
    document.head.append(style);
  }
}

/**
 * Re-derives the accent against the current base modes.
 *
 * Called after a theme is applied or removed. Also moves the override's style
 * element to the end of the head, which is what keeps it winning once the
 * theme has written a style element of its own.
 */
export function reapplyAccentOverride(): void {
  const colour = currentPrimaryColor;
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  applyAccentOverride(colour);
}
