/**
 * What the association's bylaws (stadgar) say about the general meeting, in the
 * four places BRL 9 kap. 14 § leaves the rule to them.
 *
 * ## Why these four and no others
 *
 * BRL 9 kap. 14 § applies EFL 6 kap. to a housing cooperative with six
 * exceptions, and four of the six turn on the bylaws:
 *
 *   A deviation from every member having one vote is permitted only where it
 *   limits the vote of a member who holds nothing but a garage, a store or
 *   another space used primarily for storage (§ 14 p. 1). Nothing else: no
 *   second vote for a second apartment, no weighting by participation share,
 *   no limitation on anybody else. Which is why {@link MeetingBylaws} carries
 *   one flag for that one case and no rule engine.
 *
 * Only the member's spouse or cohabitant or another member may be a proxy
 * holder, unless the bylaws determine otherwise (§ 14 p. 4, first sentence).
 *
 * Nobody may represent more than one member as proxy holder, unless the bylaws
 * determine otherwise (§ 14 p. 4, last sentence). This replaces EFL 6 kap. 5
 * §'s general three, which is why the default here is one.
 *
 *   A member may bring only their spouse or cohabitant or another member as a
 *   assistant, unless the bylaws determine otherwise (§ 14 p. 5).
 *
 * The other two exceptions are not settings at all: postal voting does not
 * apply to a housing cooperative (§ 14 p. 3, excepting EFL 6 kap. 6 §) and the
 * meeting's powers may not be delegated to fullmaktige (§ 14 p. 2). Neither is
 * a thing an association may switch on, so neither is a column, and nothing in
 * this platform builds either.
 *
 * ## Defaults are the statute, not blanks
 *
 * Unlike the motion deadline, which has no default because EFL 6 kap. 15 §
 * supplies no rule where the bylaws are silent, every clause here has a rule
 * that applies unless the bylaws displace it. So an association that has
 * recorded nothing is not half-configured: it is under the statute, and these
 * defaults say so. There is no null anywhere in this type, and that is the
 * point of it.
 *
 * ## Two are checked and two are stated
 *
 * The platform enforces a bylaws clause exactly when it holds the facts the
 * clause turns on, and states it otherwise.
 *
 * It holds membership, so it can decide whether a proxy holder is another
 * member and count how many members one proxy holder is carrying. Those two are
 * checked when a proxy is registered.
 *
 * It holds no record of who is anybody's spouse or cohabitant, and none of what
 * a space in the building is used for - an apartment carries a number, a floor,
 * a participation share and an initial share capital, and none of those tells a
 * garage from a flat. So the storage limitation and the assistant rule are
 * reported to the board and applied by the meeting. That is not a gap left for
 * later: an answer invented from a participation share would take somebody's
 * vote away on a guess, and EFL 6 kap. 27 § puts the decision at the meeting in
 * any case, which approves the voting register and may resolve to change it.
 */

/** The four clauses, each resolved to the rule that applies. */
export interface MeetingBylaws {
  /**
   * True where the bylaws let somebody other than the member's spouse or
   * cohabitant or another member act as proxy holder (BRL 9 kap. 14 § 4).
   *
   * The one thing it decides is whether an appointment resting on the bylaws is
   * accepted. The statute's own two grounds stand whatever it says.
   */
  proxyHolderEligibilityWidened: boolean;

  /**
   * How many members one proxy holder may represent at one meeting. One under
   * the statute (BRL 9 kap. 14 § 4), which is what an association that has
   * recorded nothing is under.
   */
  maxMembersPerProxyHolder: number;

  /**
   * True where the bylaws limit the vote of a member holding nothing but a
   * garage, a store or other storage space (BRL 9 kap. 14 § 1).
   *
   * Reported and never applied here. See the module comment.
   */
  storageOnlyVoteLimited: boolean;

  /**
   * True where the bylaws let somebody other than the member's spouse or
   * cohabitant or another member be an assistant (BRL 9 kap. 14 § 5).
   *
   * Reported and never applied here, for a reason about the statute rather than
   * this platform's reach: an assistant needs no written authority - EFL 6 kap.
   * 7 § simply lets a member or a proxy holder bring one, who may speak at the
   * meeting - so there is no document for the board to attest and nothing for a
   * check to key itself to.
   */
  assistantEligibilityWidened: boolean;
}

/**
 * The lowest limit a bylaws clause could sensibly name.
 *
 * Zero would refuse every proxy the statute permits, and a setting that refuses
 * what the law grants is worse than no setting at all.
 */
export const MIN_MEMBERS_PER_PROXY_HOLDER = 1;

/**
 * The highest.
 *
 * Not a statutory number - the statute names one and leaves the rest to the
 * bylaws - but a bound that keeps a mis-typed value out of a rule the meeting
 * relies on. A clause naming a figure above this is not a limit anybody is
 * applying, and a stray keystroke that turned 3 into 3000 would read as one.
 */
export const MAX_MEMBERS_PER_PROXY_HOLDER = 999;

/** The four columns, as the bylaws clauses they stand for. */
export function readMeetingBylaws(row: {
  bylawsWidenProxyHolderEligibility: boolean;
  bylawsMaxMembersPerProxyHolder: number;
  bylawsLimitStorageOnlyVote: boolean;
  bylawsWidenAssistantEligibility: boolean;
}): MeetingBylaws {
  return {
    proxyHolderEligibilityWidened: row.bylawsWidenProxyHolderEligibility,
    maxMembersPerProxyHolder: row.bylawsMaxMembersPerProxyHolder,
    storageOnlyVoteLimited: row.bylawsLimitStorageOnlyVote,
    assistantEligibilityWidened: row.bylawsWidenAssistantEligibility,
  };
}

/**
 * The rule an instance with no association row is under.
 *
 * The statute, exactly as a fresh instance's defaults are. A read that could
 * not find the association has not discovered a cooperative with different
 * bylaws; it has found one whose bylaws nobody has recorded, and the statute is
 * what governs it either way.
 */
export function statutoryMeetingBylaws(): MeetingBylaws {
  return {
    proxyHolderEligibilityWidened: false,
    maxMembersPerProxyHolder: MIN_MEMBERS_PER_PROXY_HOLDER,
    storageOnlyVoteLimited: false,
    assistantEligibilityWidened: false,
  };
}

/**
 * Whether a stated proxy limit is one a bylaws clause could name.
 *
 * An integer, because a clause names a whole number of members. The database
 * checks the same range, so a value refused here is refused twice; the reason
 * for refusing it in both places is that the API can say which setting was
 * wrong and SQLSTATE 23514 cannot.
 */
export function isWritableProxyLimit(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_MEMBERS_PER_PROXY_HOLDER &&
    value <= MAX_MEMBERS_PER_PROXY_HOLDER
  );
}
