import { resources } from "@openbrf/i18n";

import i18n from "./index";

/** The person and stored locale the interface last followed. */
let followed: { personId: string; preferredLocale: string } | null = null;

function isSupported(locale: string): locale is keyof typeof resources {
  return Object.hasOwn(resources, locale);
}

/**
 * Switches the interface to the language a person saved, once their stored
 * locale is known.
 *
 * The page starts in Swedish, before anyone is signed in, and the settings
 * panel switches the language only at the moment of saving - so without this a
 * fresh load would speak Swedish again to someone who chose English.
 *
 * Called on every read of the viewer, which many screens make for themselves,
 * so it acts only when the person or their stored locale differs from the last
 * one it followed. That keeps three things true: the same answer arriving again
 * changes nothing, a read that began before a save and ended after it cannot
 * put the old language back, and a different person signing in on the same page
 * gets their own.
 *
 * A locale this build has no translations for is ignored, leaving the language
 * as it is.
 */
export function applyViewerLocale(viewer: {
  personId: string;
  preferredLocale: string;
}): void {
  if (
    followed?.personId === viewer.personId &&
    followed.preferredLocale === viewer.preferredLocale
  ) {
    return;
  }
  followed = {
    personId: viewer.personId,
    preferredLocale: viewer.preferredLocale,
  };
  if (
    isSupported(viewer.preferredLocale) &&
    i18n.language !== viewer.preferredLocale
  ) {
    void i18n.changeLanguage(viewer.preferredLocale);
  }
}

/** Forgets whom the interface followed, for a test that starts from nothing. */
export function resetAppliedViewerLocale(): void {
  followed = null;
}
