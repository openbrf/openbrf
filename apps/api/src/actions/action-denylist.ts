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
];

/**
 * Names that describe an act no action may perform.
 *
 * The cheap half, and it is worth having despite the service check above: a
 * name is what a model reads and what a board member sees on a consent screen,
 * so an action that merely sounds like one of these is already misleading.
 */
export const DENIED_NAME_PATTERNS =
  /residency|move_in|move_out|plugin_install|plugin_remove|archive|reveal|system_role|board_position/;
