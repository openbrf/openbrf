/**
 * What a plugin may ask the host for.
 *
 * The list is deliberately short and read-only. A backend plugin runs at full
 * process privilege (ADR 0003 - there is no sandbox in v1), so these
 * permissions are not a security boundary against hostile code; they are the
 * declaration the board consents to before an install, and the boundary the
 * SDK enforces against an honest plugin reaching further than it said it
 * would. Curation of the catalog is what stands between an instance and
 * hostile code, and the revisit trigger in ADR 0003 records when that changes.
 *
 * No permission grants write access to the register in v0. A plugin that
 * needs to change resident data is a core feature request, not a plugin.
 */
export const PLUGIN_PERMISSIONS = [
  /**
   * Apartments, names, who is a resident, who is a member and who holds a
   * board position. Never contact
   * details, never personal identity numbers, and never a person flagged with
   * protected personal data - those are excluded from every plugin read
   * regardless of permission (plan section 4.4).
   */
  "addressBook:read",
  /**
   * Additionally email and phone. Separate from addressBook:read because
   * contact data is board-only in the core product, so a plugin asking for it
   * is asking for markedly more than one that only needs to know who lives
   * where.
   */
  "addressBook:readContact",
  /** Send mail through the instance's configured SMTP server. */
  "mail:send",
  /** Register background workers and enqueue or schedule jobs. */
  "jobs:schedule",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Categories of personal data a plugin declares it will process.
 *
 * Shown on the consent screen before an install, and stored with the
 * installation as the snapshot the board agreed to. It is a declaration, not
 * an enforcement point: what the plugin can actually reach follows from its
 * permissions above.
 */
export const PLUGIN_PERSONAL_DATA_CATEGORIES = [
  /** Given and family name. */
  "name",
  /** Which apartment and address a person is connected to. */
  "apartment",
  /** Move-in and move-out dates, membership role. */
  "residency",
  "email",
  "phone",
] as const;

export type PluginPersonalDataCategory =
  (typeof PLUGIN_PERSONAL_DATA_CATEGORIES)[number];
