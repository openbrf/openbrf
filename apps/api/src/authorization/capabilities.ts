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
  /**
   * Read the instance's settings without being able to change them.
   *
   * Separate from association:manage because the board is answerable for how
   * the instance is configured - the retention policy and the self-signup
   * toggle are board decisions - while changing it stays with an admin
   * (plan section 4.3).
   */
  "association:read",
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
  /**
   * The resident-facing address book: names, apartments and roles only.
   *
   * Contact details are never included. Residents do not see each other's
   * email or phone at all, and persons with protected personal data are
   * excluded from this view entirely.
   */
  "residentDirectory:read",
  /** Handle issue reports. Granted to the property manager and to the board. */
  "issues:handle",
  /**
   * Report an issue from inside the application, and read one's own reports.
   *
   * Deliberately not granted to the property manager: they handle the
   * association's issues, they do not live in the building.
   */
  "issues:report",
  /**
   * Configure the issue types and the audience each one is offered to.
   *
   * A board decision rather than an administrator's, like the retention policy
   * and the self-signup toggle: which problems residents are asked to sort
   * their reports into is the board's own vocabulary for its building.
   */
  "issues:configure",
  /**
   * Put documents into the association's archive, and decide who each one is
   * for.
   *
   * A board activity no existing capability describes: association:manage is
   * the admin's, and addressBook:write is the register's. There is no
   * separate capability for reading - a document's audience is its whole
   * access rule - but this name is what identifies the board within that
   * rule, so it decides the board's shelf as well as the writing, and it is
   * what opens a file kept to the members for whoever manages the archive
   * without holding a residency of their own.
   */
  "documents:manage",
  /**
   * Write the association's own website: its pages, what they contain, and
   * whether each one is public or for the members.
   *
   * The board's, by the same argument as the document archive: publishing in
   * the cooperative's name is what a board does, while association:manage is
   * the administrator's and covers how the instance is configured rather than
   * what it says. Reading the website needs no capability at all - that is what
   * a public website is - so this name only ever appears on a write.
   */
  "site:manage",
  /**
   * Record an election to a position of trust on the board, and end a term.
   *
   * The board's own, because who sits on it is not an administrator's decision
   * to make: a board is elected by the general meeting (foreningsstamma), and
   * what the application holds is the minute of that election written down by
   * the people who were there. An instance whose board could only be recorded
   * by whoever holds the ADMIN grant would make the administrator the gatekeeper
   * of the association's own constitution.
   *
   * The seat this confers carries no more than the conferrer already holds -
   * BOARD_CAPABILITIES is exactly what a board member has - so it cannot be
   * used to climb.
   */
  "boardPosition:manage",
  /**
   * Book a resource in the house, and cancel one's own booking.
   *
   * Residents and the board, because booking the laundry room is part of
   * living here rather than a board activity, and a board member lives here
   * too.
   *
   * Deliberately not granted to the property manager, on the issues:report
   * precedent and for the same reason: they handle the association's issues,
   * they do not live in the building. An external contractor holding a laundry
   * hour would be an hour taken from a household.
   */
  "bookings:book",
  /**
   * See who has booked what, and cancel anyone's booking.
   *
   * The board's. A booking says which apartment holds which hour, which is
   * personal data no other resident is shown, and cancelling on somebody's
   * behalf is an act only the association can answer for: a guest apartment
   * held by a household that has moved out, a laundry room closed for repair.
   */
  "bookings:manage",
  /**
   * Create and edit the catalogue of bookable resources: what exists, how it is
   * booked, and how much of it one apartment may hold.
   *
   * A board decision rather than an administrator's, by the argument
   * issues:configure makes: what the house offers, and how much of it one
   * household may take, is the board's own policy for its building - the way
   * the retention policy is the board's decision about its data.
   *
   * Separate from bookings:manage because the two answer different questions.
   * Cancelling a resident's booking is running the calendar; deciding that the
   * sauna exists at all and that nobody may hold more than two bookings a week
   * is writing the rules the calendar runs by.
   */
  "bookings:configure",
  /**
   * Grant and revoke a system role: the administrator grant and the external
   * property manager grant.
   *
   * An administrator's, and see BOARD_CAPABILITIES below for why the board is
   * not given it.
   */
  "systemRole:manage",
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

/**
 * What a board seat grants - and the one thing it deliberately does not.
 *
 * `systemRole:manage` is absent, and the absence is the rule rather than an
 * oversight: it is what stops a board seat from being a way to grant oneself
 * administrator rights. A board member who could write a `system_role` row
 * could write themselves an ADMIN one, and every line above about settings,
 * plugins and themes staying with an administrator would then be a convention
 * rather than a boundary.
 *
 * That decision is enforced by the board holding no capability that reaches the
 * table, rather than by a service inspecting which role is being granted. There
 * is no route on which a principal without `systemRole:manage` can write a
 * system role at all, so the guarantee is the absence of a path and not the
 * correctness of a branch inside one.
 *
 * The external property manager grant sits on the administrator's side of that
 * line with the ADMIN grant, although the capabilities it carries are a subset
 * of the board's own and conferring it could not be an escalation. It is there
 * because of what it is rather than what it carries: a standing grant that lets
 * somebody who neither lives in the building nor was elected to anything act on
 * this instance. Who holds an account-level grant is the same question as who
 * may install a plugin or change the retention policy, and it is answered by
 * `association:manage`'s holder. Splitting the two grants across two
 * capabilities would also put the board back in front of that table, which is
 * what the paragraph above exists to prevent.
 *
 * Recording the board's own election is the board's (`boardPosition:manage`),
 * because a board is elected by the general meeting and not appointed by an
 * administrator.
 */
const BOARD_CAPABILITIES: readonly Capability[] = [
  "association:read",
  "boardPosition:manage",
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
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
  "issues:report",
  "bookings:book",
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
