import type { Capability } from "../authorization/capabilities";

/**
 * What no action may do, as four constants a person can read in one sitting.
 *
 * This file is Beslutslogg 64 in code: no token and no prompt may delete from
 * the member register's archive tier, reveal protected personal data
 * (skyddade personuppgifter), or change who holds a system role, a position of
 * trust or a capability. The last of those is the one that needs spelling out,
 * because a capability moves in more ways than by being granted: a residency
 * write moves it, and so does installing or removing a plugin.
 *
 * Constants rather than a rule derived from something else, because a reviewer
 * has to be able to check the list against the decision without running the
 * program. The contract test reads the same four.
 */

/**
 * Capabilities no action of any kind may declare - core actions included.
 *
 * Each is a way authority moves, or the way protected personal data is
 * revealed. An action holding one of these would be a token able to widen what
 * the token itself may do.
 */
export const DENIED_ACTION_CAPABILITIES: readonly Capability[] = [
  "systemRole:manage",
  "boardPosition:manage",
  "association:manage",
  "protectedData:reveal",
  "addressBook:write",
];

/**
 * What a plugin's action may ask for at all.
 *
 * An explicit allowlist rather than a relation derived from the plugin's own
 * route capabilities: `routeCapabilityFloor` returns exactly two values, so an
 * equality rule would mean no plugin could ever declare a `site:manage` action,
 * which is the case the arming toggle exists to govern. There is also no
 * ordering on the capability names for "at or above" to mean anything.
 *
 * The separate question - never reachable by a caller the plugin's own routes
 * would refuse - is answered per call by the floor check inside invoke().
 */
export const PLUGIN_ELIGIBLE_CAPABILITIES: readonly Capability[] = [
  "self:manage",
  "addressBook:read",
  "site:manage",
];

/**
 * Services no handler may be bound to.
 *
 * The half a name pattern cannot do. An action called `update_household` walks
 * past any regex and into the member register; what stops it is which service
 * its handler calls.
 */
export const DENIED_ACTION_SERVICES: readonly string[] = [
  "MoveService",
  "SystemRoleService",
  "BoardPositionService",
  "PluginAdminService",
  "MemberRegisterService",
  /*
   * It writes three append-only statutory registers - the termination register,
   * the transfer reversal register and the reporting obligation ledger - each
   * held append-only by a database trigger rather than by the application. ADR
   * 0008 forbids binding a handler to a service that writes a statutory
   * register, and the rows this one writes cannot be corrected afterwards by
   * anybody at all, so a handler bound to it could put a fact into a register
   * the association is required to keep and nothing could take it back.
   */
  "ApartmentRegisterService",
];

/**
 * Property names a person-bearing output uses, and the category each implies.
 *
 * The cheap half of checking the declaration, in the spirit of
 * {@link DENIED_NAME_PATTERNS} and for the same reason. `personalData` is a
 * hand-written array on each definition and nothing compares it against what
 * the action's output can actually carry, so rule 1 is only as good as the
 * declaration it reads.
 *
 * What the contract test beside this does with it: it walks each action's
 * published output document and fails on a property whose implied category the
 * action did not declare. What it catches is the failure that actually happens,
 * which is a field added to a service's view and echoed by an action whose
 * declaration was written before the field existed.
 *
 * It cannot prove a declaration complete, and it is not meant to. A service
 * that begins returning a person's town under a property called `place` passes
 * every check here. The other direction - proving that a declared category is a
 * reachable one - would need the registry to know what every bound service can
 * return, which is the knowledge ADR 0008 keeps out of it. What stands behind
 * both gaps is the same thing that stands behind the denylist above: a
 * reviewable constant and a review.
 */
export const PERSON_FIELD_CATEGORIES: ReadonlyMap<string, string> = new Map([
  ["name", "name"],
  ["firstName", "name"],
  ["lastName", "name"],
  ["email", "email"],
  ["phone", "phone"],
  /*
   * An identifier for a person is a reference to one, which is what makes a row
   * about somebody rather than about a thing. The address book's masked contact
   * and the comment thread's withheld author both still carry it, deliberately,
   * so a caller can address the person without being told their name.
   */
  ["personId", "name"],
  ["apartment", "apartment"],
  ["apartmentId", "apartment"],
  ["postalAddress", "postalAddress"],
  ["personalIdentityNumber", "personalIdentityNumber"],
]);

/**
 * Names that describe an act no action may perform.
 *
 * The cheap half, and it is worth having despite the service check above: a
 * name is what a model reads and what a board member sees on a consent screen,
 * so an action that merely sounds like one of these is already misleading.
 */
export const DENIED_NAME_PATTERNS =
  /residency|move_in|move_out|plugin_install|plugin_remove|archive|reveal|system_role|board_position/;
