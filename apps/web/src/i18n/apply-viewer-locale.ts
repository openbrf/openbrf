import { resources } from "@openbrf/i18n";

import i18n from "./index";

/** How many reads of the viewer this page has started. */
let started = 0;
/** Reads numbered below this one are stale: a newer answer or a save won. */
let staleBelow = 0;

function isSupported(locale: string): locale is keyof typeof resources {
  return Object.hasOwn(resources, locale);
}

/**
 * Numbers a read of the viewer as it starts, for `applyViewerLocale` to tell
 * its answer from a newer one.
 */
export function startViewerRead(): number {
  started += 1;
  return started;
}

/**
 * Switches the interface to the language a person saved, once their stored
 * locale is known.
 *
 * The page starts in Swedish, before anyone is signed in, and the settings
 * panel switches the language only at the moment of saving - so without this a
 * fresh load would speak Swedish again to someone who chose English.
 *
 * Called with the answer to every read of the viewer, which many screens make
 * for themselves and which can end in any order. Only the newest answer counts:
 * one from a read that started before an answer already applied, or before the
 * person's last successful language save (`supersedeViewerReads`), is ignored,
 * because it may carry the language they had before. The same answer arriving
 * again changes nothing, and a different person signing in on the same page
 * gets their own.
 *
 * A locale this build has no translations for is ignored, leaving the language
 * as it is.
 */
export function applyViewerLocale(
  read: number,
  viewer: { preferredLocale: string },
): void {
  if (read < staleBelow) {
    return;
  }
  staleBelow = read + 1;
  if (
    isSupported(viewer.preferredLocale) &&
    i18n.language !== viewer.preferredLocale
  ) {
    void i18n.changeLanguage(viewer.preferredLocale);
  }
}

/**
 * Marks every read of the viewer started so far as stale, once a language save
 * has succeeded.
 *
 * Such a read may have been answered before the save was stored, and the
 * settings panel has already switched the interface to the saved language. A
 * read started after this sees the saved language, so it still applies.
 */
export function supersedeViewerReads(): void {
  staleBelow = started + 1;
}

/** Forgets every read so far, for a test that starts from nothing. */
export function resetAppliedViewerLocale(): void {
  started = 0;
  staleBelow = 0;
}
