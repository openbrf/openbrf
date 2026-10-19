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
   * Apartments, names, who is a resident, who is a member, and when a person
   * moved in or out. Never contact details, never personal identity numbers,
   * and never a person flagged with protected personal data - those are
   * excluded from every plugin read regardless of permission (plan section
   * 4.4).
   *
   * Board positions are not in it. Who sits on the board is a core capability,
   * read nowhere in the host object a plugin is given.
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
  /**
   * Send text messages through the instance's configured SMS provider.
   *
   * Separate from mail:send because the two do not cost the association the
   * same thing. Mail leaves through a server the instance is already set up
   * for; a text message is billed per message against a provider contract the
   * board signed, and an instance that has bought none cannot send one at all.
   */
  "sms:send",
  /** Register background workers and enqueue or schedule jobs. */
  "jobs:schedule",
  /**
   * The fee notification runs and their notices, and the charges to members,
   * as the board's own documents state them, and the events that say one was
   * issued, recorded, corrected or removed.
   *
   * Masked as the files the board hands over are, and further: the names on a
   * notice whose household holds a person with protected personal data are
   * withheld, as on the fee notice file, and a charge on such a person withholds
   * who and where entirely, where the debiting list withholds only where. A
   * plugin is further from the board than the economic manager is, and the
   * address book's rule that a protected person never reaches a plugin holds
   * here too. A personal identity number is never returned, and there is no
   * payment state to return: core records none.
   */
  "finances:read",
  /**
   * Record that a fee notice or a charge was delivered: by which route, when,
   * and under which reference the receiving system knows it. A receipt and
   * never a paid flag. Separate from finances:read because it writes, and the
   * board consents to a plugin that only reads the books knowing that it cannot
   * add anything to them.
   */
  "finances:recordDelivery",
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
  /** Move-in and move-out dates, and whether the person is a member. */
  "residency",
  "email",
  "phone",
  /** What an apartment was billed or a person charged, and for what. */
  "financial",
] as const;

export type PluginPersonalDataCategory =
  (typeof PLUGIN_PERSONAL_DATA_CATEGORIES)[number];
