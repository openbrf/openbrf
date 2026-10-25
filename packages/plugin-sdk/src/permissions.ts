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
 *
 * A new value here is a new member of the catalog's permission list, and an
 * instance that does not know it refuses the whole catalog index that carries
 * it. The catalog therefore lists an entry asking for one of the content
 * permissions below only in an index that older instances do not read: the
 * version 2 index (ADR 0032).
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
   * The association's published news items: the title, the body's text, when
   * each was published and whether it is for the members or for anyone.
   *
   * Not a register permission. It reads what the board has already
   * published, and never who wrote an item, a comment on it or who read it
   * (ADR 0032). The text is the board's and may name somebody, which is why a
   * plugin holding it declares `freeText`.
   */
  "news:read",
  /**
   * The published events and their occurrences, and the notice of every
   * general meeting that has been called and not yet held.
   *
   * Never a sign-up, a roll-call, an attendance or a proxy: how many places
   * are left at an occurrence is the most it says about who is coming. Like
   * news:read, it reads the board's text and declares `freeText`.
   */
  "calendar:read",
  /**
   * The bookable resources the house offers, and when each is taken. Never by
   * whom: no booker, no apartment, no booking's identifier, and two bookings
   * that touch are one interval (ADR 0032).
   */
  "bookings:readAvailability",
  /**
   * A stored picture, by its id: one held for anyone or for the members, whose
   * upload declared that it shows no identifiable person (ADR 0032).
   *
   * Never a document, never a household's or the board's file, and never a
   * picture of people: a photograph of a person needs a publication consent,
   * and the consent the core records is for the website, not for wherever a
   * plugin puts the picture. A picture is still a photograph, which is why a
   * plugin holding it declares `photograph`.
   */
  "media:read",
  /**
   * The association's addresses: the street and number of each entrance, and
   * nothing about who lives at them. Not addressBook:read, which reads the
   * apartments and the people in them.
   */
  "addresses:read",
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
  /**
   * Hand a member list to the core for the board to review (ADR 0043).
   *
   * The one way a plugin brings data towards the register, and it writes
   * nothing: the core holds the file as an import proposal on its own import
   * screen, and a board member previews, decides and applies it there, or
   * rejects it. It grants no read of the register and raises no route's
   * capability floor, so the plugin learns nothing about what the file would
   * do. It does hold the file, though, which can carry every personal identity
   * number in the cooperative and rows about persons with protected personal
   * data, so a manifest declaring it declares those categories too.
   */
  "addressBook:proposeImport",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export function isPluginPermission(value: string): value is PluginPermission {
  return (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Whether a permission lets a plugin read the register, or the finances that
 * carry the names of the people in it.
 *
 * Every permission is classified, and the record is typed against
 * `PluginPermission`, so a permission added to the list above fails to compile
 * until somebody has said which it is. That is the point of a classification
 * over a list of the refused: the rules that keep a plugin with a device route
 * or a website block away from the register (ADR 0006, ADR 0031) hold a new
 * permission that reads it out unless somebody remembers to add it to each.
 * `finances:recordDelivery` writes a receipt and returns no one's details, so
 * it is not a read. The content permissions (`news:read`, `calendar:read`,
 * `bookings:readAvailability`, `media:read`, `addresses:read`) read what the
 * website publishes, never the register, so a plugin with a device route may
 * hold them; the host withholds text that names a resident from such a plugin.
 */
export const PERMISSION_REGISTER_ACCESS = {
  "addressBook:read": "reads",
  "addressBook:readContact": "reads",
  "mail:send": "none",
  "sms:send": "none",
  "jobs:schedule": "none",
  "finances:read": "reads",
  "finances:recordDelivery": "none",
  "site:blocks": "none",
  "themes:install": "none",
  "news:read": "none",
  "calendar:read": "none",
  "bookings:readAvailability": "none",
  "media:read": "none",
  "addresses:read": "none",
  // Reads nothing from the register, but holds the member list it proposes.
  // The rules that keep a device route or a website block away from it name
  // this permission alongside `readsRegister` (ADR 0043).
  "addressBook:proposeImport": "none",
} as const satisfies Record<PluginPermission, "reads" | "none">;

/** The permissions that read the register, in the order of the list above. */
export const REGISTER_READING_PERMISSIONS: readonly PluginPermission[] =
  PLUGIN_PERMISSIONS.filter(
    (permission) => PERMISSION_REGISTER_ACCESS[permission] === "reads",
  );

/** Whether any of the permissions a manifest asks for reads the register. */
export function readsRegister(permissions: readonly string[]): boolean {
  return permissions.some((permission) =>
    (REGISTER_READING_PERMISSIONS as readonly string[]).includes(permission),
  );
}

/**
 * Categories of personal data a plugin declares it will process.
 *
 * Shown on the consent screen before an install, and stored with the
 * installation as the snapshot the board agreed to. Installing the plugin
 * writes them into the association's record of processing activities (GDPR
 * art. 30) as the categories that processing touches. What the plugin reads
 * follows from its permissions above, not from this list.
 *
 * Not only the register. A plugin that dispatches core actions handles
 * whatever those actions return: an assistant passing issue reports and
 * minutes to a model provider handles free text, and one reading charges
 * handles financial data. So the list is ACTION_PERSONAL_DATA, in its order,
 * and the host holds dispatch to it: a plugin is offered and may call only the
 * actions whose own `personalData` this list covers.
 *
 * Two of them only one kind of plugin may declare. A personal identity number
 * is never returned to a plugin, and a person with protected personal data
 * (skyddade personuppgifter) never appears in one's reads at all, so for any
 * other plugin a declaration naming either would describe something that
 * cannot happen. A plugin that proposes an import carries the member list the
 * other way, and that list can hold both (ADR 0043): the manifest refuses
 * either category without `addressBook:proposeImport`, and requires both with
 * it.
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
  /**
   * Personal identity number (personnummer). Only with
   * `addressBook:proposeImport`.
   */
  "personalIdentityNumber",
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
  /**
   * Rows about a person with protected personal data (skyddade
   * personuppgifter). Only with `addressBook:proposeImport`.
   */
  "protected",
] as const satisfies readonly ActionPersonalData[];

/**
 * The personal data categories a plugin that proposes an import must declare,
 * and the two no other plugin may.
 */
export const PROPOSE_IMPORT_PERSONAL_DATA = [
  "name",
  "apartment",
  "residency",
  "email",
  "phone",
  "personalIdentityNumber",
  "protected",
] as const satisfies readonly PluginPersonalDataCategory[];

export const PROPOSE_IMPORT_ONLY_PERSONAL_DATA = [
  "personalIdentityNumber",
  "protected",
] as const satisfies readonly PluginPersonalDataCategory[];

/**
 * The personal data categories a plugin that asks for `site:blocks` may
 * declare (ADR 0006): the published text `news:read` and `calendar:read`
 * hand it, and the pictures `media:read` does.
 *
 * Every other category describes the members, and a plugin that declares one
 * may dispatch the actions that return it (`motion_queue_list` and the news
 * comment actions return names), so declaring one is a path to the register
 * as a register permission is. Listed as what is allowed rather than what is
 * refused, so a category added later is refused beside `site:blocks` until
 * somebody has said it is safe on the website.
 */
export const WEBSITE_PERSONAL_DATA = [
  "freeText",
  "photograph",
] as const satisfies readonly PluginPersonalDataCategory[];

/**
 * The categories in a list that describe the members, which a plugin that
 * asks for `site:blocks` may not declare: those outside
 * `WEBSITE_PERSONAL_DATA`.
 */
export function memberPersonalData(categories: readonly string[]): string[] {
  return categories.filter(
    (category) =>
      !(WEBSITE_PERSONAL_DATA as readonly string[]).includes(category),
  );
}

export type PluginPersonalDataCategory =
  (typeof PLUGIN_PERSONAL_DATA_CATEGORIES)[number];
