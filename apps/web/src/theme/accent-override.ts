import {
  buildAccentOverrideStylesheet,
  PORTTAVLAN,
  primaryColorOverride,
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
 * silently keeping the default theme's legible accent is the right failure: an
 * association must be able to read its own register.
 */

const STYLE_ELEMENT_ID = "openbrf-accent-override";

export function applyAccentOverride(primaryColor: string | null): void {
  const existing = document.getElementById(STYLE_ELEMENT_ID);

  if (primaryColor === null || primaryColor === "") {
    existing?.remove();
    return;
  }

  const result = primaryColorOverride(primaryColor, PORTTAVLAN);
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
