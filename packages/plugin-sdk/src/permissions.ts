import type { ActionPersonalData } from "./actions.ts";

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
   * Add blocks to the association's website.
   *
   * What such a block renders is published to anybody who reads the page,
   * account or not, which is why it is a permission the board consents to
   * rather than something a manifest may simply declare. The host prints what
   * the block renders through an allowlist of elements, so it is never a
   * script, a stylesheet or a resource from another host - but the words in it
   * are the plugin's to choose.
   */
  "site:blocks",
  /**
   * Install and update themes on the instance (ADR 0046).
   *
   * A theme is data and passes the same install lint however it arrives, so
   * this grants no way past the theme gate: what a board consents to is a
   * plugin putting themes on the instance's theme screen, for an
   * administrator to preview and activate there. Each install is made for a
   * person in the web interface who may install themes, never by the plugin on
   * its own.
   */
  "themes:install",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Categories of personal data a plugin declares it will process.
 *
 * Shown on the consent screen before an install, and stored with the
 * installation as the snapshot the board agreed to. Installing the plugin
 * writes them into the association's record of processing activities (GDPR
 * art. 30) as the categories that processing touches. It is a declaration, not
 * an enforcement point: what the plugin can actually reach follows from its
 * permissions above and from the actions it is allowed to call.
 *
 * Not only the register. A plugin that dispatches core actions handles
 * whatever those actions return: an assistant passing issue reports and
 * minutes to a model provider handles free text, and one reading charges
 * handles financial data. So the list is ACTION_PERSONAL_DATA, in its order,
 * without the two categories no plugin can reach. A personal identity number is
 * never returned to a plugin, and a person with protected personal data
 * (skyddade personuppgifter) never appears in one's reads at all, so a
 * declaration naming either would be describing something that cannot happen.
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
  /** A postal address of the person's own, not the apartment's. */
  "postalAddress",
  /** Sign-in credentials and sessions. */
  "account",
  /** Charges, debiting basis and what a person owes or has paid. */
  "financial",
  /**
   * Health, an art. 9 special category. Declared by a plugin that handles text
   * people wrote themselves, where it may be volunteered.
   */
  "health",
  /** A photograph, whether or not anybody is recognisable in it. */
  "photograph",
  /** Text a person wrote themselves, which may name anybody. */
  "freeText",
  /** The audit log's record of who did what to whose data. */
  "auditTrail",
] as const satisfies readonly ActionPersonalData[];

export type PluginPersonalDataCategory =
  (typeof PLUGIN_PERSONAL_DATA_CATEGORIES)[number];
