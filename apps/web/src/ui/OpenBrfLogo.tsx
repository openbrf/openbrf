import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/**
 * Where the logo files are served from.
 *
 * They live in the client's public directory, so they sit under the same prefix
 * as every other built file. Vite's `base` is that prefix, and reading it here
 * keeps the logo in step with the router's basepath and the API's static route
 * rather than repeating "/app" a fourth time.
 */
const BRAND = `${import.meta.env.BASE_URL}brand/`;

/**
 * The Open BRF logo: the building with one lit window, and the name beside it.
 *
 * Unlike every other colour on screen, the logo's are not the theme's to
 * change. It is the project's mark (TRADEMARK.md), drawn in fixed colours in
 * docs/brand, and a theme or an association's own accent restyling it would be
 * restyling the trademark. So it is an image, as the association's own logo in
 * the band is, rather than a component painted with tokens.
 *
 * It ships as two files, one drawn for a light ground and one for a dark
 * ground, and index.css shows exactly one of them by the same rule the theme
 * uses to pick its palette. The stylesheet makes that choice rather than the
 * theme-mode context, so the screens that carry the logo - all of them outside
 * the application frame - render the same with or without that provider.
 *
 * `className` places it and nothing else: the size is the logo's own.
 */
export function OpenBrfLogo({
  className = "",
}: {
  className?: string;
}): ReactElement {
  const { t } = useTranslation();
  const name = t("welcome.title");

  return (
    <span className={`flex w-fit ${className}`}>
      <img
        src={`${BRAND}openbrf-lockup.svg`}
        alt={name}
        width={172}
        height={42}
        className="openbrf-logo-on-light h-8 w-auto"
      />
      <img
        src={`${BRAND}openbrf-lockup-on-dark.svg`}
        alt={name}
        width={172}
        height={42}
        className="openbrf-logo-on-dark h-8 w-auto"
      />
    </span>
  );
}
