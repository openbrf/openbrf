import {
  PLUGIN_FINDING_REASONS,
  type PluginFindingReason,
  type PluginPermission,
  type PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * Translation keys for the permission set and the personal data categories.
 *
 * A lookup rather than a computed key, for two reasons. The values contain a
 * colon, which i18next reads as a namespace separator, so they cannot be keys.
 * And the compiler checks this table against en.json, so adding a permission to
 * the SDK without writing the sentence a board reads before consenting to it
 * fails the build rather than shipping an untranslated code.
 *
 * Keyed by the SDK's own unions, so the check runs in both directions: a
 * member added there without a label here is a missing property rather than a
 * board reading "something this version does not recognise" in place of the
 * capability it is being asked to approve.
 */
export const PERMISSION_LABELS: Readonly<
  Record<PluginPermission, TranslationKey>
> = {
  "addressBook:read": "plugins.permissions.addressBookRead",
  "addressBook:readContact": "plugins.permissions.addressBookReadContact",
  "mail:send": "plugins.permissions.mailSend",
  "sms:send": "plugins.permissions.smsSend",
  "jobs:schedule": "plugins.permissions.jobsSchedule",
};

export const PERSONAL_DATA_LABELS: Readonly<
  Record<PluginPersonalDataCategory, TranslationKey>
> = {
  name: "plugins.personalData.name",
  apartment: "plugins.personalData.apartment",
  residency: "plugins.personalData.residency",
  email: "plugins.personalData.email",
  phone: "plugins.personalData.phone",
};

/**
 * The label for a declared permission, however it arrives.
 *
 * The table is exhaustive over what this build knows, but the value on the
 * wire comes from a stored consent row or a catalog written for a different
 * version, so the lookup stays total at runtime: an unrecognised code is shown
 * as unrecognised rather than dropped from a declaration a board is reading.
 */
export function permissionLabel(permission: string): TranslationKey {
  return (
    PERMISSION_LABELS[permission as PluginPermission] ??
    "plugins.permissions.unknown"
  );
}

export function personalDataLabel(category: string): TranslationKey {
  return (
    PERSONAL_DATA_LABELS[category as PluginPersonalDataCategory] ??
    "plugins.personalData.unknown"
  );
}

/**
 * Why a plugin on the data volume is not running.
 *
 * The server reports a code; the board reads a sentence. Typed against the
 * contract's own union rather than against string, so a reason added to the
 * plugin contract fails to compile here until somebody has written the
 * sentence for it - the difference between a board member always getting a
 * sentence and usually getting one. The values are checked too: a key that
 * does not exist in the resources is not a TranslationKey.
 */
export const FINDING_LABELS: Readonly<
  Record<PluginFindingReason, TranslationKey>
> = {
  disabled: "plugins.findings.reasons.disabled",
  "not-consented": "plugins.findings.reasons.notConsented",
  "permissions-widened": "plugins.findings.reasons.permissionsWidened",
  "personal-data-widened": "plugins.findings.reasons.personalDataWidened",
  "module-identity": "plugins.findings.reasons.moduleIdentity",
  "manifest-invalid": "plugins.findings.reasons.manifestInvalid",
  "api-version-unsupported": "plugins.findings.reasons.apiVersion",
  "entry-missing": "plugins.findings.reasons.entryMissing",
  "load-failed": "plugins.findings.reasons.loadFailed",
  "entry-invalid": "plugins.findings.reasons.entryInvalid",
  "module-invalid": "plugins.findings.reasons.moduleInvalid",
  "module-refused": "plugins.findings.reasons.moduleRefused",
  "module-failed": "plugins.findings.reasons.moduleFailed",
  "not-on-volume": "plugins.findings.reasons.notOnVolume",
};

/**
 * The sentence a reason is read as.
 *
 * Walked rather than indexed, so the code arriving as a string is narrowed to
 * the union without a cast. An unrecognised code falls back to a general
 * sentence rather than being hidden: a plugin that is not running for a reason
 * this version has no words for is still a plugin that is not running, and the
 * fallback names the code so it can be looked up.
 */
export function findingLabel(reason: string): TranslationKey {
  for (const code of PLUGIN_FINDING_REASONS) {
    if (reason === code) {
      return FINDING_LABELS[code];
    }
  }
  return "plugins.findings.reasons.unknown";
}
