/**
 * Why a plugin on the data volume is not running.
 *
 * A finding travels as one of these codes plus the values its sentence needs,
 * never as a sentence composed by the host. The interface is Swedish by
 * default and this package is English, so what a board reads has to be a
 * translation of the code: a sentence written where the finding is produced
 * reaches the board panel in the language the server happens to be written in.
 *
 * Listed as values rather than as a bare union so a caller can walk them and
 * prove it has a sentence for each. Part of the contract rather than an
 * implementation detail - docs/plugin-contract.md lists the same set, and a
 * plugin author reading why their package was skipped is reading one of these.
 */
export const PLUGIN_FINDING_REASONS = [
  /** The `openbrf` field failed validation. */
  "manifest-invalid",
  /** Built against a contract version this instance does not implement. */
  "api-version-unsupported",
  /** A declared entry file is not in the package. */
  "entry-missing",
  /** The server bundle does not export `createPlugin`. */
  "entry-invalid",
  /** `createPlugin` returned no NestJS dynamic module. */
  "module-invalid",
  /** Its module declares behaviour a plugin may not register. */
  "module-refused",
  /** Its module could not be built into the application. */
  "module-failed",
  /** The package carries its own copy of a host package it must share. */
  "module-identity",
  /** It asks for more than was consented to. */
  "permissions-widened",
  /** It handles a personal-data category that was not consented to. */
  "personal-data-widened",
  /** On the volume with no record of consent. */
  "not-consented",
  /** Switched off in the admin interface. */
  "disabled",
  /** It threw while being loaded. */
  "load-failed",
  /** Recorded as installed but not present. */
  "not-on-volume",
] as const;

export type PluginFindingReason = (typeof PLUGIN_FINDING_REASONS)[number];

/**
 * The values a finding's sentence is completed with.
 *
 * Identifiers, paths, numbers and what a thrown error said - never a sentence,
 * and never personal data. A list stays a list rather than being joined here,
 * because its members can have sentences of their own: a board told that a
 * package handles a category it never agreed to has to read that category in
 * its own language, not as `residency`.
 */
export type PluginFindingDetail = Readonly<
  Record<string, string | number | readonly string[]>
>;
