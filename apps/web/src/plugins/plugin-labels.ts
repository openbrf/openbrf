import {
  ACTION_EFFECTS,
  type ActionEffect,
  type ActionPersonalData,
  type ActionSurface,
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
 * What an action does to the records, in one word.
 *
 * The word is the whole of what separates an action that reads the register
 * from one that deletes out of it, so it is stated wherever a declaration is:
 * on the consent screen before an install, and beside the arming toggle
 * afterwards. Keyed by the contract's own union, so an effect added there
 * fails to compile here until the word exists.
 */
export const ACTION_EFFECT_LABELS: Readonly<
  Record<ActionEffect, TranslationKey>
> = {
  read: "plugins.actions.effect.read",
  write: "plugins.actions.effect.write",
  delete: "plugins.actions.effect.delete",
};

/**
 * The word an effect is read as, or null when this build has none for it.
 *
 * Walked rather than indexed, so an effect arriving as a string is narrowed to
 * the union without a cast. Null rather than the code itself: an effect this
 * version does not recognise has no sentence to put on a board member's
 * screen, and the row still names the action and its capability.
 */
export function actionEffectLabel(effect: string): TranslationKey | null {
  for (const known of ACTION_EFFECTS) {
    if (effect === known) {
      return ACTION_EFFECT_LABELS[known];
    }
  }
  return null;
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
  "actions-widened": "plugins.findings.reasons.actionsWidened",
  "action-refused": "plugins.findings.reasons.actionRefused",
  "forbidden-injection": "plugins.findings.reasons.forbiddenInjection",
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

/**
 * The personal data an action can touch, in the association's own words.
 *
 * The platform's own category names rather than a set written for this screen.
 * The thirteen are the ones the record of processing already states, and
 * `dataProtection.categories.personalData` is where those sentences live; a
 * second set here would be a second thing to keep true, and the first time the
 * two disagreed a board would read one word on the consent screen and another
 * on the document it answers with.
 *
 * `protected` is the action list's own fourteenth value. It marks an action
 * that can return a field of a person carrying protected personal data, which
 * is the one category that may never be offered beyond this instance at all.
 *
 * Keyed by the SDK's union, so a category added there fails to compile here
 * until the word a board reads before consenting to it exists.
 */
export const ACTION_PERSONAL_DATA_LABELS: Readonly<
  Record<ActionPersonalData, TranslationKey>
> = {
  name: "dataProtection.categories.personalData.name",
  apartment: "dataProtection.categories.personalData.apartment",
  residency: "dataProtection.categories.personalData.residency",
  email: "dataProtection.categories.personalData.email",
  phone: "dataProtection.categories.personalData.phone",
  postalAddress: "dataProtection.categories.personalData.postalAddress",
  personalIdentityNumber:
    "dataProtection.categories.personalData.personalIdentityNumber",
  account: "dataProtection.categories.personalData.account",
  financial: "dataProtection.categories.personalData.financial",
  health: "dataProtection.categories.personalData.health",
  photograph: "dataProtection.categories.personalData.photograph",
  freeText: "dataProtection.categories.personalData.freeText",
  auditTrail: "dataProtection.categories.personalData.auditTrail",
  protected: "dataProtection.categories.personalData.protected",
};

/**
 * Where an action may be offered, in one phrase.
 *
 * The distinction the board is actually deciding on. "ui" is inside this
 * instance and needs no arming; the other two are the ones an administrator
 * switches on, and they are what carries an action beyond the association's own
 * screens.
 */
export const ACTION_SURFACE_LABELS: Readonly<
  Record<ActionSurface, TranslationKey>
> = {
  ui: "plugins.actions.surface.ui",
  mcp: "plugins.actions.surface.mcp",
  ai: "plugins.actions.surface.ai",
};

/**
 * The words for a declared category, however it arrives.
 *
 * Total at runtime for the reason `permissionLabel` is: the value comes from a
 * stored consent row or a catalog written for another version, and a
 * declaration a board is reading must not quietly lose an entry this build has
 * no word for.
 */
export function actionPersonalDataLabel(category: string): TranslationKey {
  return (
    ACTION_PERSONAL_DATA_LABELS[category as ActionPersonalData] ??
    "plugins.personalData.unknown"
  );
}

export function actionSurfaceLabel(surface: string): TranslationKey {
  return (
    ACTION_SURFACE_LABELS[surface as ActionSurface] ??
    "plugins.actions.surface.unknown"
  );
}
