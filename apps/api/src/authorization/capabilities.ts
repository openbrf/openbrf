/**
 * The capability model (plan section 4.3 and 4.4).
 *
 * Capabilities exist rather than raw role checks because the same person can
 * hold several roles at once: a board member is also a resident, an external
 * admin is neither, and a property manager is deliberately none of the above.
 * Code asks "may this principal read the apartment register", never "is this
 * person on the board".
 */

export const CAPABILITIES = [
  /** Settings, plugins, themes, SMTP, retention policy. */
  "association:manage",
  /** Read the address book with contact details, i.e. the board's view. */
  "addressBook:read",
  /** Create and edit persons, apartments, residencies. */
  "addressBook:write",
  /** Read the statutory member register and produce its extract. */
  "memberRegister:read",
  /**
   * Read the confidential apartment register (liens, share capital, personal
   * identity numbers). A tenant-owner's access to their OWN entry is a separate
   * check, not this capability.
   */
  "apartmentRegister:read",
  /** Reveal masked fields on a person with protected personal data. */
  "protectedData:reveal",
  /** Invite a person to activate an account. */
  "invitation:send",
  /** Approve or reject a self-signup request. */
  "signupRequest:decide",
  /** Read and edit one's own person record and account settings. */
  "self:manage",
  /** The resident-facing contact list, honouring per-field visibility. */
  "residentDirectory:read",
  /** Handle issue reports. Granted to the property manager; unused in phase 1. */
  "issues:handle",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The roles a person can hold, derived rather than stored as one field. */
export interface PrincipalRoles {
  isAdmin: boolean;
  /** Holds an active board position (chair, member or deputy). */
  isBoardMember: boolean;
  isPropertyManager: boolean;
  /** Holds an active residency of any kind. */
  isResident: boolean;
  /** Holds an active residency with role MEMBER, i.e. is a member. */
  isMember: boolean;
}

const ADMIN_CAPABILITIES: readonly Capability[] = CAPABILITIES;

const BOARD_CAPABILITIES: readonly Capability[] = [
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
];

/**
 * The property manager is an external party with access to issue handling
 * only, and never to the address book (decision 11). The list is short on
 * purpose: widening it would breach that promise.
 */
const PROPERTY_MANAGER_CAPABILITIES: readonly Capability[] = [
  "issues:handle",
  "self:manage",
];

const RESIDENT_CAPABILITIES: readonly Capability[] = [
  "self:manage",
  "residentDirectory:read",
];

/**
 * Resolves the capabilities a set of roles grants.
 *
 * Board membership does NOT imply association:manage: changing settings,
 * installing plugins and switching themes stay with an admin, so a board seat
 * alone cannot reconfigure the instance.
 */
export function capabilitiesFor(roles: PrincipalRoles): Set<Capability> {
  const granted = new Set<Capability>();

  const add = (capabilities: readonly Capability[]): void => {
    for (const capability of capabilities) {
      granted.add(capability);
    }
  };

  if (roles.isAdmin) {
    add(ADMIN_CAPABILITIES);
  }
  if (roles.isBoardMember) {
    add(BOARD_CAPABILITIES);
  }
  if (roles.isPropertyManager) {
    add(PROPERTY_MANAGER_CAPABILITIES);
  }
  if (roles.isResident) {
    add(RESIDENT_CAPABILITIES);
  }
  // Someone with an account but no residency, board seat or grant (an external
  // person mid-onboarding) can still manage their own record.
  granted.add("self:manage");

  return granted;
}

export interface Principal extends PrincipalRoles {
  personId: string;
  capabilities: Set<Capability>;
}

export function principalCan(
  principal: Principal,
  capability: Capability,
): boolean {
  return principal.capabilities.has(capability);
}
