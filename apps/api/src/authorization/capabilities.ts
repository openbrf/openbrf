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
  /**
   * Supply the register onward to Lantmateriet: produce the initial supply to
   * the cooperative housing register (Lag (2026:485) 3 §).
   *
   * Its own capability rather than a route under `apartmentRegister:read`,
   * because it is a different act on the same data. Reading the register is
   * something the board does on a Tuesday; handing every holder's name and
   * personal identity number to a state authority is a disclosure with a
   * recipient outside the association, and the only other operation in the
   * product that decrypts one - the data subject access report - is gated on a
   * capability of its own for exactly that reason.
   *
   * It does not stand alone. The routes that carry it also require
   * `apartmentRegister:read`, because the content is that register's, and
   * `protectedData:reveal`, because the file carries a number the product
   * otherwise masks: without it the export would be a second, weaker path to a
   * disclosure the register's own reveal route refuses. Both are board and
   * administrator today, so no live request tells the three apart - which is why
   * the pairing is asserted in register-report.controller.spec.ts rather than
   * left to a request test that would pass without it. It matters the first time
   * a seat reads the register without being entitled to supply it, or is
   * entitled to supply it without being entitled to read a number: an economic
   * manager, a broker seat, an auditor.
   *
   * Deliberately NOT what gates the queue of outstanding duties. That screen
   * carries apartment designations and statutory dates and no personal data at
   * all, and a board that had to hold the disclosure capability to see which
   * deadlines are running would either see them too rarely or hold the
   * disclosure too widely.
   */
  "registerReport:export",
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
   * Write a comment on a news item, and read the thread on one.
   *
   * Residents and the board, because answering a notice about the house is part
   * of living in it, and a board member lives here too.
   *
   * Deliberately not granted to the property manager, on the issues:report
   * precedent and for the same reason: they handle the association's issues,
   * they do not live in the building, and the conversation under a notice about
   * the stairwell is the residents' own.
   *
   * There is no second capability for moderating a comment. Hiding one is
   * `site:manage`, which is already what the board holds for publishing in the
   * cooperative's name: a comment thread is part of what the association
   * publishes, and a capability with an identical grant list would only be
   * another name for the same job.
   */
  "news:comment",
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
   * Arrange what the association does, announce it, and call a date off.
   *
   * The board's, by the argument site:manage makes: putting a cleaning day or a
   * general meeting in the calendar and telling the members about it is
   * publishing in the cooperative's name, which is what a board does, while
   * association:manage is the administrator's and covers how the instance is
   * configured rather than what it says.
   *
   * One capability and not a pair, because arranging and announcing are one act
   * here. A series is entered, its dates are written out, and it is published to
   * the members or to the street - and there is no half of that a person could
   * sensibly hold on its own. Whether the calendar may be read is a separate
   * question with a separate answer: a published series needs no capability at
   * all to reach the people it was published to, which is what publishing means.
   *
   * Deliberately not granted to the property manager, on the issues:report
   * precedent: they handle the association's issues, they do not arrange its
   * cleaning days.
   */
  "events:manage",
  /**
   * Sign up (anmalan) to a date in the association's calendar, and stand down
   * again.
   *
   * Residents and the board, because putting your name down for the cleaning day
   * is part of living here rather than a board activity, and a board member lives
   * here too.
   *
   * A capability of its own rather than self:manage, although a sign-up is a row
   * about the person making it. A capability answers what a principal may do, and
   * "may take a place at something the association arranges" is a different
   * question from "may edit their own record and account settings": one is about
   * the house's activities, the other is a person's own data and would be wrong
   * to withhold from anybody who has an account at all. Folding the two together
   * would also mean the external person mid-onboarding who holds self:manage and
   * nothing else could put their name down for the general meeting.
   *
   * It does not carry reading the calendar as a whole. A published series reaches
   * the people it was published to without any capability, which is what
   * publishing means; what this name gates is the sign-up itself and the
   * occurrence list that carries the caller's own place. Who else is coming stays
   * behind events:manage.
   *
   * Deliberately not granted to the property manager, on the bookings:book
   * precedent and for the same reason: they handle the association's issues, they
   * do not live in the building, and a place taken by an external contractor is a
   * place taken from a household.
   */
  "events:attend",
  /**
   * Grant and revoke a system role: the administrator grant and the external
   * property manager grant.
   *
   * An administrator's, and see BOARD_CAPABILITIES below for why the board is
   * not given it.
   */
  "systemRole:manage",
  /**
   * Put an item to a general meeting (motion till stamman), and read one's own.
   *
   * The one capability in this list that is derived from membership rather than
   * from residency, a board seat or a grant, and the reason is the statute
   * rather than a product decision. EFL 6 kap. 15 § gives the right to have an
   * item taken up at a general meeting to "en medlem" - a member - and BRL
   * 9 kap. 14 § applies that chapter to a housing cooperative with six
   * exceptions of which this is not one. So a resident who is not a
   * tenant-owner does not hold it: a partner, an adult child, a tenant living
   * here on a second-hand contract. They live in the building; the item put to
   * the meeting is the member's.
   *
   * Nor does a board seat confer it. A board member who is also a member holds
   * it as a member, and one who is not holds nothing here, because the right
   * attaches to the membership and not to the office.
   *
   * The capability is what opens the route. Whether the caller is a member on
   * the day they submit is checked again by `MotionService.submit` against the
   * register, which is what closes the administrator path: an administrator
   * holds every capability in this list by definition, and holding a grant is
   * not being a member.
   */
  "motions:submit",
  /**
   * Work the motion queue: read what the members have put to the meeting, and
   * record that a motion has been received.
   *
   * The board's, because a motion is addressed to it. EFL 6 kap. 15 § has the
   * member ask the board in writing, and it is the board that decides what goes
   * into the notice (kallelse) for the meeting.
   *
   * Deliberately not the property manager's, on the issues:report precedent: a
   * motion is the members' business with their own association, and an external
   * contractor has nothing to do with it.
   */
  "motions:handle",
  /**
   * Arrange a general meeting (foreningsstamma) and run it: write its agenda
   * (dagordning), register a member's written authority for a proxy holder, record who
   * is present, read the voting register (rostlangd) and minute what the meeting
   * decided.
   *
   * The board's, because every one of those acts is the board's side of the
   * meeting. EFL 6 kap. 16 § has the board call the meeting; 6 kap. 26 § has the
   * board's chair, or whoever it appointed, open it; 6 kap. 27 § has the register
   * drawn up by whoever opened it or by the chair the meeting elected; and
   * 6 kap. 39 § has the chair see that a protokoll is kept. So this is one
   * capability and not one per act: a second would suggest an audience that does
   * not exist.
   *
   * Deliberately not derived from membership, which makes it the opposite of
   * `motions:submit` above. What a member holds at a general meeting is the right to
   * attend, speak and vote (EFL 6 kap. 2-3 §§), and none of that is something
   * this platform does - the meeting happens in a room or on a call. What the
   * platform does is the record-keeping, and the record is the board's to keep. A
   * member who is also on the board holds this as a board member, which is the
   * ordinary case.
   *
   * Not the external property manager's either, on the `motions:handle`
   * precedent: the members' decisions about their own association are no part of
   * a contractor's work, and the list of who was in the room is resident data
   * they have no business reading.
   */
  "meetings:manage",
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
  "registerReport:export",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "news:comment",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
  "events:manage",
  "motions:handle",
  "meetings:manage",
  "events:attend",
];

/**
 * What being a member grants, over and above living here.
 *
 * The only role-derived list on this page that comes from a statute naming the
 * role rather than from a decision about who should be able to do what. EFL
 * 6 kap. 15 §, applied to a housing cooperative by BRL 9 kap. 14 §, gives the
 * right to put an item to a general meeting to a member; every other resident
 * of the building has no such right, and the platform is not free to extend it.
 *
 * So this list is short and stays short. A capability belongs here only when
 * membership - the tenant-ownership - is what confers it, and not when it is
 * merely something residents happen to do. Booking the laundry room is part of
 * living here, which is why `bookings:book` is a resident's; putting a motion to
 * the meeting is part of owning a share in the association, which is why
 * `motions:submit` is a member's.
 *
 * Membership is derived on every request from an active residency with the
 * MEMBER role (`PrincipalService.forPerson`), so a household that has sold up
 * stops holding this the day the residency ends rather than when somebody
 * remembers to revoke something.
 */
const MEMBER_CAPABILITIES: readonly Capability[] = ["motions:submit"];

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
  "news:comment",
  "bookings:book",
  "events:attend",
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
  /*
   * Read on its own rather than as a refinement of isResident, even though
   * every member is a resident in the register today.
   *
   * `isMember` has been on PrincipalRoles since the principal was first built
   * and nothing here read it, so this is the first capability the platform
   * derives from membership. Stated as its own branch because the two roles
   * answer different questions and the statute cares which: living here is what
   * grants the resident list, and holding the tenant-ownership is what grants
   * the right in EFL 6 kap. 15 §. Nesting one inside the other would make the
   * member's right look like a resident's with an extra condition.
   */
  if (roles.isMember) {
    add(MEMBER_CAPABILITIES);
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
