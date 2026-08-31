import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";

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
