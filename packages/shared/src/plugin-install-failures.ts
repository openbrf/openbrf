/**
 * Why a plugin install did not converge.
 *
 * The installer records one of these codes and the values its sentence needs,
 * never a sentence of its own. The API is English throughout and the interface
 * is Swedish by default, so a reason the server phrased would reach the board
 * in English however the interface is set - which is what the install row did
 * until it carried a code. What was actually thrown is kept beside the code for
 * whoever operates the instance, and is not what the board reads.
 *
 * The list lives here rather than in the API because both sides render it: the
 * admin screen turns a code into a sentence, and the command-line tool prints
 * the same sentence from the application's own translations. Codes are stored
 * on the row, so one is never renamed or reused; a reason that stops occurring
 * keeps its code, and one that a build does not recognise is read as
 * unrecognised rather than dropped.
 *
 * Distinct from the plugin contract's finding reasons, which say why a package
 * already on the data volume is not running. These say why it never got there.
 */
export const PLUGIN_INSTALL_FAILURE_REASONS = [
  /** The run's downloads used their whole time before this one began. */
  "download-budget-spent",
  /** The archive did not finish downloading in the time it was given. */
  "download-timed-out",
  /** The archive's address, or a redirect, is not a source this instance reads. */
  "source-not-allowed",
  /** The release host could not be reached, or redirected nowhere usable. */
  "source-unreachable",
  /** The release host answered with an HTTP error status. */
  "source-answered-error",
  /** The archive is larger than an instance accepts. */
  "archive-too-large",
  /** The catalog states a checksum that is not a sha512 digest. */
  "checksum-malformed",
  /** The downloaded bytes do not hash to the checksum the catalog states. */
  "checksum-mismatch",
  /** The download failed for a reason with no code of its own. */
  "download-failed",
  /** A verified archive could not be unpacked to read its package.json. */
  "archive-unreadable",
  /** A verified archive's package.json is not an installable plugin package. */
  "archive-not-a-plugin",
  /** A verified archive holds a different package or version than consented. */
  "archive-package-mismatch",
  /** npm could not install the verified archives. */
  "npm-install-failed",
  /** npm finished without installing a consented archive as a package. */
  "package-not-installed",
  /** npm installed packages that no archive was consented for. */
  "unconsented-packages",
  /** Another run took the installation over while this one was building. */
  "installation-claim-lost",
  /** Building the installation failed for a reason with no code of its own. */
  "build-failed",
] as const;

export type PluginInstallFailureReason =
  (typeof PLUGIN_INSTALL_FAILURE_REASONS)[number];

/**
 * The values a failure's sentence is completed with.
 *
 * Identifiers and numbers - a package name, a status code, a limit in bytes or
 * milliseconds - and never a sentence or a URL: an address a release host
 * redirected to can carry a signature in its query, and the board's screen is
 * no place to repeat it. The full text, URL included, is the operator's.
 */
export type PluginInstallFailureDetail = Readonly<
  Record<string, string | number>
>;

/**
 * The detail as a sentence is completed with it.
 *
 * Stored in the units the code works in - milliseconds and bytes - because
 * those are exact and do not change when a sentence is reworded. Read in the
 * units a board member thinks in: "480 seconds" and "64 MiB", whole numbers so
 * no locale has to decide where a decimal point goes. A deadline is rounded up,
 * so a run cut short a fraction of a second in never reads as "0 seconds".
 * Shared so the admin screen and the command-line tool say the same number.
 */
export function pluginInstallFailureValues(
  detail: PluginInstallFailureDetail,
): Record<string, string | number> {
  const values: Record<string, string | number> = { ...detail };
  const { budgetMs, timeoutMs, maxBytes } = detail;
  if (typeof budgetMs === "number") {
    values["budgetSeconds"] = Math.ceil(budgetMs / 1000);
  }
  if (typeof timeoutMs === "number") {
    values["timeoutSeconds"] = Math.ceil(timeoutMs / 1000);
  }
  if (typeof maxBytes === "number") {
    values["maxMebibytes"] = Math.max(1, Math.round(maxBytes / 1024 / 1024));
  }
  return values;
}

/** Narrows a stored or transmitted code onto the list, or null. */
export function pluginInstallFailureReason(
  value: string | null | undefined,
): PluginInstallFailureReason | null {
  for (const reason of PLUGIN_INSTALL_FAILURE_REASONS) {
    if (value === reason) {
      return reason;
    }
  }
  return null;
}
