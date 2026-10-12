import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import {
  type PluginInstallFailureReason,
  pluginInstallFailureReason,
} from "@openbrf/shared";

/**
 * Translation keys for the declaration shown before an install.
 *
 * The same sentences the consent screen renders, so what an operator reads in
 * a terminal before running `openbrf plugin add` and what a board reads in the
 * browser before pressing Install are one statement rather than two. A
 * permission identifier is a contract token, not a description: nothing in
 * `addressBook:readContact` says that agreeing to it means handing over every
 * resident's email address and telephone number.
 *
 * A lookup rather than a computed key, because the identifiers contain a colon
 * and i18next reads that as a namespace separator. Keyed by the SDK's unions,
 * so adding a permission without writing the sentence that explains it fails
 * the build.
 */
export const PERMISSION_LABEL_KEYS: Readonly<Record<PluginPermission, string>> =
  {
    "addressBook:read": "plugins.permissions.addressBookRead",
    "addressBook:readContact": "plugins.permissions.addressBookReadContact",
    "mail:send": "plugins.permissions.mailSend",
    "sms:send": "plugins.permissions.smsSend",
    "jobs:schedule": "plugins.permissions.jobsSchedule",
  };

export const PERSONAL_DATA_LABEL_KEYS: Readonly<
  Record<PluginPersonalDataCategory, string>
> = {
  name: "plugins.personalData.name",
  apartment: "plugins.personalData.apartment",
  residency: "plugins.personalData.residency",
  email: "plugins.personalData.email",
  phone: "plugins.personalData.phone",
};

export function permissionLabelKey(permission: string): string {
  return (
    PERMISSION_LABEL_KEYS[permission as PluginPermission] ??
    "plugins.permissions.unknown"
  );
}

export function personalDataLabelKey(category: string): string {
  return (
    PERSONAL_DATA_LABEL_KEYS[category as PluginPersonalDataCategory] ??
    "plugins.personalData.unknown"
  );
}

/**
 * Translation keys for why an install failed.
 *
 * The same sentences the admin screen shows, so an operator listing plugins in
 * a terminal reads the reason a board reads in the browser rather than a
 * second wording of it. Keyed by the shared union, so a reason added there
 * without its sentence fails the build here as well as in the browser.
 */
export const INSTALL_FAILURE_LABEL_KEYS: Readonly<
  Record<PluginInstallFailureReason, string>
> = {
  "download-budget-spent": "plugins.installed.failure.downloadBudgetSpent",
  "download-timed-out": "plugins.installed.failure.downloadTimedOut",
  "source-not-allowed": "plugins.installed.failure.sourceNotAllowed",
  "source-unreachable": "plugins.installed.failure.sourceUnreachable",
  "source-answered-error": "plugins.installed.failure.sourceAnsweredError",
  "archive-too-large": "plugins.installed.failure.archiveTooLarge",
  "checksum-malformed": "plugins.installed.failure.checksumMalformed",
  "checksum-mismatch": "plugins.installed.failure.checksumMismatch",
  "download-failed": "plugins.installed.failure.downloadFailed",
  "archive-unreadable": "plugins.installed.failure.archiveUnreadable",
  "archive-not-a-plugin": "plugins.installed.failure.archiveNotAPlugin",
  "archive-package-mismatch":
    "plugins.installed.failure.archivePackageMismatch",
  "npm-install-failed": "plugins.installed.failure.npmInstallFailed",
  "package-not-installed": "plugins.installed.failure.packageNotInstalled",
  "unconsented-packages": "plugins.installed.failure.unconsentedPackages",
  "installation-claim-lost": "plugins.installed.failure.installationClaimLost",
  "build-failed": "plugins.installed.failure.buildFailed",
};

/**
 * The key for a stored reason. Total, for the reason the stored row may carry
 * a code a later version wrote: that is still a failure, and the sentence for
 * it names the code.
 */
export function installFailureLabelKey(reason: string): string {
  const known = pluginInstallFailureReason(reason);
  return known === null
    ? "plugins.installed.failure.unknown"
    : INSTALL_FAILURE_LABEL_KEYS[known];
}
