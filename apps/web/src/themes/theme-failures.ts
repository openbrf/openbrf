import type { ApiFailure } from "../api/client";
import type { ThemeLintFinding } from "../api/themes";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * What a refused theme request is read as.
 *
 * Shared by the theme screen and the composer because both call endpoints that
 * answer with the same reasons: the composer runs the install lint, so it is
 * refused by the same rules, with the same findings attached.
 */
const FAILURE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "catalog-not-configured": "themeCatalog.errors.catalogNotConfigured",
  "catalog-unreachable": "themeCatalog.errors.catalogUnreachable",
  "catalog-invalid": "themeCatalog.errors.catalogInvalid",
  "package-unreachable": "themeCatalog.errors.packageUnreachable",
  "package-too-large": "themeCatalog.errors.packageTooLarge",
  "checksum-mismatch": "themeCatalog.errors.checksumMismatch",
  "package-unreadable": "themeCatalog.errors.packageUnreadable",
  "manifest-invalid": "themeCatalog.errors.manifestInvalid",
  "identity-mismatch": "themeCatalog.errors.identityMismatch",
  "lint-failed": "themeCatalog.errors.lintFailed",
  "not-in-catalog": "themeCatalog.errors.notInCatalog",
  "theme-not-installed": "themeCatalog.errors.themeNotInstalled",
  "theme-not-composed": "themeCatalog.errors.themeNotComposed",
  "built-in-theme": "themeCatalog.errors.builtInTheme",
  "theme-in-use": "themeCatalog.errors.themeInUse",
  "theme-has-dependants": "themeCatalog.errors.themeHasDependants",
  "theme-unresolvable": "themeCatalog.errors.themeUnresolvable",
  "housing-cooperative-missing":
    "themeCatalog.errors.housingCooperativeMissing",
};

export function failureKey(failure: ApiFailure): TranslationKey {
  if (failure.status === 403) {
    return "themeCatalog.errors.forbidden";
  }
  return FAILURE_KEYS[failure.reason] ?? "themeCatalog.errors.unknown";
}

/** Findings the server attached to a refusal, when it attached any. */
export function findingsOf(failure: ApiFailure): ThemeLintFinding[] {
  return Array.isArray(failure.detail)
    ? failure.detail.filter(
        (entry): entry is ThemeLintFinding =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ThemeLintFinding).rule === "string",
      )
    : [];
}
