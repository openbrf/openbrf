import type {
  Capability,
  GrantableCapability,
} from "../authorization/capabilities";

/**
 * What a support session may reach (ADR 0028): what an administrator uses to
 * run the instance, and nothing that discloses more than a name, is the
 * association's casework, or is a person's own act.
 *
 * Written out by name rather than derived from the administrator's grant, so a
 * capability added to CAPABILITIES later is not a supporter's until somebody
 * decides it should be. Typed as GrantableCapability, so a seat-bound
 * capability cannot appear here and a supporter never reads a household's
 * binder (ADR 0017), whoever opened the access.
 *
 * Not the administrator's capabilities narrowed at the moment of the request,
 * but this list: whoever opened the access holds ADMIN, which is every one of
 * these, and the guard checks that they still do on every request.
 *
 * Read-only is enforced by the guard on the method, before any of these is
 * checked, so a capability here that names a write - `association:manage`,
 * `invitation:send` - opens the screens that capability opens and none of the
 * changes.
 */
export const SUPPORT_CAPABILITIES = [
  "association:manage",
  "association:read",
  "addressBook:read",
  "memberRegister:read",
  "invitation:send",
  "signupRequest:decide",
  "systemRole:manage",
  "boardPosition:manage",
  "issues:configure",
  "bookings:configure",
  "documents:manage",
  "site:manage",
  "events:manage",
] as const satisfies readonly GrantableCapability[];

/** Why a capability is not a supporter's. */
export type SupportWithholding =
  /** It discloses more than a name. */
  | "discloses"
  /** It is the association's casework or correspondence with its members. */
  | "casework"
  /** It is a person's own act, and a supporter has no self. */
  | "ownAct"
  /** It exists only to change something, and a supporter changes nothing. */
  | "writeOnly"
  /** A board seat confers it and no grant carries it (ADR 0017). */
  | "seatBound";

/**
 * Every capability a support session is refused, and why.
 *
 * The other half of the decision. Together with {@link SUPPORT_CAPABILITIES}
 * it names every capability there is, which the spec beside this file asserts:
 * a capability added later fails the build until it is put on one side or the
 * other, by somebody deciding which.
 */
export const WITHHELD_FROM_SUPPORT: Readonly<
  Record<
    Exclude<Capability, (typeof SUPPORT_CAPABILITIES)[number]>,
    SupportWithholding
  >
> = {
  // A personal identity number, a lien, a protected person's details.
  "apartmentRegister:read": "discloses",
  "protectedData:reveal": "discloses",
  "registerReport:export": "discloses",

  "issues:handle": "casework",
  "bookings:manage": "casework",
  "motions:handle": "casework",
  "meetings:manage": "casework",
  "memberCharges:manage": "casework",
  "fees:manage": "casework",
  "dataProtection:manage": "casework",
  "boardMailbox:handle": "casework",
  "sublets:handle": "casework",
  "keyOrders:handle": "casework",
  "chat:moderate": "casework",

  "self:manage": "ownAct",
  "residentDirectory:read": "ownAct",
  "issues:report": "ownAct",
  "news:comment": "ownAct",
  "bookings:book": "ownAct",
  "events:attend": "ownAct",
  "motions:submit": "ownAct",
  "sublets:apply": "ownAct",
  "keyOrders:place": "ownAct",
  "chat:participate": "ownAct",

  /*
   * Gates the register's writes, and no screen reads by it that
   * addressBook:read does not already open. Withheld so that the support list
   * holds no capability whose only purpose is a change.
   */
  "addressBook:write": "writeOnly",

  "apartmentBinder:manage": "seatBound",
};

/** The capabilities a support session's principal holds: a fresh set each time. */
export function supportCapabilities(): Set<Capability> {
  return new Set<Capability>(SUPPORT_CAPABILITIES);
}
