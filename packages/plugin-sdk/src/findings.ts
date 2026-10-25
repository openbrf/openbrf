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
  /** The installed version declares an action the board did not consent to. */
  "actions-widened",
  /** An action the manifest declares could not be registered. */
  "action-refused",
  /**
   * The installed version says otherwise than the board consented to about
   * whether it is an AI package, in either direction.
   */
  "ai-changed",
  /**
   * The installed version reads another entitlement than the board consented
   * to, may present the licence to a service the board was not told of, or
   * declares a key of its issuer's the board has not consented to.
   */
  "licence-widened",
  /**
   * The installed version names another issuer of its licence than the board
   * consented to, or no longer declares a key the board consented to.
   */
  "licence-issuer-changed",
  /** It registered a website block its manifest does not declare. */
  "block-refused",
  /** One of its providers reaches for a core service a plugin may not hold. */
  "forbidden-injection",
  /**
   * It declares the OAuth protected resource, and another installed plugin
   * already does. The one installed first keeps it: the resource URL is the
   * audience every issued token carries, so moving it would strand them all.
   */
  "oauth-resource-conflict",
  /**
   * A plugin it extends is not installed, not loaded, or switched off. The
   * detail names it. An addon does not serve while its host plugin does not.
   */
  "extension-host-missing",
  /** A plugin it extends declares no such extension point. */
  "extension-point-unknown",
  /**
   * A point it extends is at another major version than the one it was
   * written for.
   */
  "extension-version-unsupported",
  /** It hands over a category of personal data the point does not accept. */
  "extension-personal-data-refused",
  /**
   * Of it and a plugin it extends, one puts blocks on the website and the
   * other holds a permission that reads the register. The detail names
   * those permissions.
   */
  "extension-permission-refused",
  /**
   * It puts blocks on the website, and a plugin it extends handles personal
   * data. The detail names those categories.
   */
  "extension-host-personal-data-refused",
  /**
   * The plugins joined to it by extensions, through one host plugin or
   * several, hold one that puts blocks on the website and one that reads the
   * address book. The detail names both.
   */
  "extension-group-refused",
  /**
   * The plugins joined to it by extensions, through one host plugin or
   * several, hold one that declares device routes and one that reads contact
   * details or the finances, or proposes imports (ADR 0052). The detail names
   * both.
   */
  "extension-device-group-refused",
  /**
   * It declares an extension point, or extends one, in a way the board has not
   * consented to.
   */
  "extensions-widened",
  /** A definition or contribution it registered could not be accepted. */
  "extension-refused",
  /**
   * The installed version declares a recipient the board did not consent to:
   * a new one, one at another origin, or one receiving more personal data.
   */
  "recipients-widened",
  /**
   * The installed version declares a device route the board has not consented
   * to, or moves one (ADR 0031).
   */
  "device-routes-widened",
  /**
   * It wrote more audit entries with no request than
   * `PLUGIN_AUDIT_LIMITS.perMinute` allows, and was stopped until the next
   * restart. The detail holds the rate.
   */
  "audit-rate-exceeded",
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

/**
 * The manifest rules whose refusal a board reads in its own language.
 *
 * A manifest that fails validation is reported as `manifest-invalid`, and
 * what Zod says about a field is English for the plugin's author. The rules
 * below are not about one field: they hold two declarations against each
 * other, and a board reading why a package was skipped needs to be told which
 * in a sentence of its own. So the refusal carries the code with the English
 * line, and the interface translates the code. Any other problem stays the
 * English line, which is what an author fixes the package from.
 */
export const PLUGIN_MANIFEST_RULES = [
  /** A device route overlaps the OAuth protected resource. */
  "device-route-overlaps-oauth-resource",
  /** A plugin with a device route also reads the register or the finances. */
  "device-route-reads-register",
  /** A plugin with a website block also reads the register or the finances. */
  "blocks-read-register",
  /** A plugin with a device route also proposes imports. */
  "device-route-proposes-import",
  /** A plugin with a website block also proposes imports. */
  "blocks-propose-import",
  /** A plugin with a website block declares personal data about the members. */
  "blocks-declare-member-data",
  /** A plugin with a device route offers an extension point accepting contact details. */
  "device-route-extension-point-contact",
] as const;

export type PluginManifestRule = (typeof PLUGIN_MANIFEST_RULES)[number];
