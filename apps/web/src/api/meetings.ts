import { apiRequest, type ApiResult } from "./client";

/**
 * The general meeting (foreningsstamma), as the board arranges and runs it.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * One base path and one capability, unlike the events module's three. The API
 * splits events by audience because a resident and the board reach different
 * halves of the same calendar; there is no such split here. Arranging a meeting,
 * writing its agenda, summoning the members, checking somebody in, registering
 * an authority and minuting a decision are one office doing one job, and
 * `meetings:manage` gates all of it. Nothing on this path is public and nothing
 * on it is a member's own view.
 *
 * Five properties of the contract are load-bearing and invisible in the types.
 *
 * **A read of one meeting answers with the whole of it.** The agenda, the list
 * of those present, the authorities, the association's bylaws and the voting
 * register arrive in one payload, because a board checking people in at the door
 * needs all of it at once - and a screen that fetched the parts separately would
 * show a state that never existed at any single moment.
 *
 * **Every write answers with the part it wrote and never with the meeting.** A
 * check-in answers with the attendance line, a decision with the agenda item.
 * The voting register is derived from the register, the residencies, the
 * attendance lines and the authorities together, so a screen that read a
 * check-in's answer into its own state would hold a list of who is present
 * beside a count of votes present that no longer follows from it. Which is why
 * every act on the meeting screens discards its return value and re-reads.
 *
 * **What a meeting may still be changed to is decided by two dates on it, in
 * this order.** Issuing the notice settles what the meeting deals with (EFL
 * 6 kap. 22 § with 25 §), so from that moment the agenda is fixed. Recording the
 * meeting as held settles the rest, and turns the decision routes on: a decision
 * is minuted after the meeting, not before it. Both facts are on the read -
 * `notice` and `concludedAt` - so a screen offers a form exactly when the server
 * would accept it.
 *
 * **Nothing here carries a name.** Every person is an identifier, including on
 * the voting register and on the notice's list of members it did not reach. The
 * meetings API deliberately holds no copy of the address book, so a screen that
 * wants to write a name beside an identifier reads the address book for it and
 * meets that module's own rules about protected personal data.
 *
 * **A day is "YYYY-MM-DD" on the association's own clock and never an instant.**
 * The day a meeting is held is what decides who has a vote at it, and the day a
 * member signed an authority is what EFL 6 kap. 4 § measures its year from.
 * Deriving either from an instant in the browser would put a meeting held at
 * half past midnight on the day before.
 */

/** Ordinary or extraordinary (EFL 6 kap. 11 § and 6 kap. 12 §). */
export type MeetingKind = "ORDINARY" | "EXTRAORDINARY";

export const MEETING_KINDS: readonly MeetingKind[] = [
  "ORDINARY",
  "EXTRAORDINARY",
];

/**
 * In what capacity somebody is on the list EFL 6 kap. 27 § has drawn up.
 *
 * Three, and only the first two carry a vote. An assistant (bitrade) is on the
 * list because that paragraph covers them and has the right to speak under
 * 6 kap. 7 §, and nothing more.
 */
export type AttendanceCapacity = "MEMBER" | "PROXY_HOLDER" | "ASSISTANT";

export const ATTENDANCE_CAPACITIES: readonly AttendanceCapacity[] = [
  "MEMBER",
  "PROXY_HOLDER",
  "ASSISTANT",
];

/** Whether they are in the room or taking part from elsewhere. */
export type AttendanceMode = "IN_PERSON" | "REMOTE";

export const ATTENDANCE_MODES: readonly AttendanceMode[] = [
  "IN_PERSON",
  "REMOTE",
];

/**
 * What entitles somebody to hold a member's proxy authorisation.
 *
 * The statute's own two grounds and the bylaws' one. BRL 9 kap. 14 § 4 lets the
 * member's spouse or cohabitant or another member be the proxy holder unless the
 * bylaws determine otherwise, so `BYLAWS` is the ground that is refused on an
 * association whose bylaws have not widened it - which is what
 * {@link MeetingBylaws.proxyHolderEligibilityWidened} says.
 */
export type RepresentativeGround = "MEMBER" | "SPOUSE_OR_COHABITANT" | "BYLAWS";

export const REPRESENTATIVE_GROUNDS: readonly RepresentativeGround[] = [
  "MEMBER",
  "SPOUSE_OR_COHABITANT",
  "BYLAWS",
];

/**
 * What the meeting resolved on one item.
 *
 * Two, because this is the platform's copy of what the protokoll states about an
 * omrostning (EFL 6 kap. 39 §) rather than a tally it computed. An item nobody
 * put to a vote simply has no decision.
 */
export type MeetingDecisionOutcome = "CARRIED" | "REJECTED";

export const MEETING_DECISION_OUTCOMES: readonly MeetingDecisionOutcome[] = [
  "CARRIED",
  "REJECTED",
];

/**
 * The bounds the API states, mirrored rather than imported like every other wire
 * constant here.
 *
 * They are the values the server refuses beyond, so a form can hold a board
 * inside them instead of letting the refusal be the first thing that says so.
 * The agenda's hundred is not a rule anybody has - it is what stops one request
 * writing an unbounded number of rows - and the vote count's hundred thousand is
 * what keeps a mis-keyed figure out of the association's copy of the protokoll's
 * own counts.
 */
export const MEETING_AGENDA_MAX_ITEMS = 100;
export const MEETING_AGENDA_TITLE_MAX = 300;
export const MEETING_PLACE_MAX = 300;
export const MEETING_DIGITAL_PARTICIPATION_MAX = 2000;
export const MEETING_VOTE_COUNT_MAX = 100_000;

/**
 * How many members one proxy holder may represent, as the bylaws may state it.
 *
 * One is the statutory position for a housing cooperative (BRL 9 kap. 14 § 4),
 * which replaces EFL 6 kap. 5 §'s general three - so an association that has
 * recorded nothing is under one rather than under three. The upper bound is not
 * a statutory number but what keeps a stray keystroke that turned 3 into 3000
 * out of a rule the meeting relies on.
 */
export const MIN_MEMBERS_PER_PROXY_HOLDER = 1;
export const MAX_MEMBERS_PER_PROXY_HOLDER = 999;

/** What the meeting decided on one item, as the chair recorded it. */
export interface MeetingDecision {
  outcome: MeetingDecisionOutcome;
  votesFor: number;
  votesAgainst: number;
  votesAbstaining: number;
  /**
   * Whether the vote was taken by closed ballot (sluten omrostning).
   *
   * Recorded and never required. The word does not occur in EFL at all: a closed
   * ballot at a general meeting is the meeting's own procedure rather than a
   * right anybody may demand, so this is a fact the chair minuted and not a
   * condition the platform checks.
   */
  closedBallot: boolean;
  recordedByPersonId: string;
  /** ISO instant. */
  recordedAt: string;
}

/** One agenda item as it is written and read back. */
export interface AgendaItem {
  id: string;
  /** One-based, decided by the server from the order the agenda was sent in. */
  position: number;
  title: string;
  /** What the meeting resolved, or null while it has resolved nothing. */
  decision: MeetingDecision | null;
}

/** One line of the list EFL 6 kap. 27 § has drawn up at the meeting. */
export interface Attendance {
  id: string;
  personId: string;
  capacity: AttendanceCapacity;
  mode: AttendanceMode;
  /** The member or proxy holder an assistant came with. Null on every other line. */
  onBehalfOfPersonId: string | null;
  /** ISO instant, or null while the person stands on the list. */
  withdrawnAt: string | null;
}

/** One member's proxy authorisation (fullmakt). */
export interface ProxyAuthorisation {
  id: string;
  memberPersonId: string;
  proxyHolderPersonId: string;
  ground: RepresentativeGround;
  /** "YYYY-MM-DD": the day the member signed it. */
  authorisedOn: string;
  /** ISO instant, or null while the authority stands. */
  withdrawnAt: string | null;
  recordedByPersonId: string;
}

/**
 * The four bylaws clauses BRL 9 kap. 14 § leaves to the association.
 *
 * No field is nullable, and that is the point of the type rather than an
 * omission: every one of these clauses has a rule that applies unless the
 * bylaws displace it, so an association that has recorded nothing is under the
 * statute rather than half-configured.
 *
 * Two are checked by the server and two are reported for the meeting to apply.
 * The platform holds no record of who is anybody's spouse or cohabitant and none
 * of what a space in the building is used for, so answering either from what it
 * does hold would take a vote away on a guess - and EFL 6 kap. 27 § puts the
 * decision at the meeting in any case, which approves the voting register and
 * may resolve to change it.
 */
export interface MeetingBylaws {
  /** Whether somebody outside the statute's two grounds may be a proxy holder. */
  proxyHolderEligibilityWidened: boolean;
  /** How many members one proxy holder may represent at one meeting. */
  maxMembersPerProxyHolder: number;
  /**
   * Whether the bylaws limit the vote of a member holding nothing but a garage,
   * a store or other storage space. Reported, never applied.
   */
  storageOnlyVoteLimited: boolean;
  /**
   * Whether somebody outside the statute's two grounds may be an assistant.
   * Reported, never applied.
   */
  assistantEligibilityWidened: boolean;
}

/** A proxy holder present and holding one member's authority. */
export interface VotingRegisterProxyHolder {
  personId: string;
  /** The member on this line whose authority they hold. */
  memberPersonId: string;
}

/** One vote, and who holds and exercises it. */
export interface VotingRegisterLine {
  /** The members who share this one vote, sorted. */
  memberPersonIds: string[];
  /**
   * The tenant-ownerships the vote is held through, sorted.
   *
   * Empty where no MEMBER residency covers the meeting day for this membership.
   * The vote stands either way: EFL 6 kap. 3 § gives it to the member and not to
   * the holding.
   */
  apartmentIds: string[];
  /** More than one member shares this vote (BRL 9 kap. 14 § 1). */
  jointlyHeld: boolean;
  /** Members on this line present themselves, sorted. */
  presentMemberPersonIds: string[];
  /**
   * The proxy holders present who hold a current authority from a member on this
   * line.
   *
   * Plural, and not one chosen for the meeting. Joint holders are separate
   * members, so two of them may each have appointed a different proxy holder
   * while both stay away - and the one vote they share cannot be split between
   * them. Which of them exercises it is for the meeting to settle when it
   * approves the register.
   */
  proxyHolders: VotingRegisterProxyHolder[];
  /** Whether the one vote this line carries is present at the meeting. */
  votePresent: boolean;
}

/**
 * The voting register (rostlangd), derived when it is read and never stored.
 *
 * One vote per membership, joint holdings merged: a member holding two
 * apartments has one vote, and joint holders of one bostadsratt have one between
 * them. A stored count would go stale the moment somebody moved or a transfer
 * completed, and it would go stale silently.
 */
export interface VotingRegister {
  /** One line per vote, ordered by the sorted member ids for stability. */
  lines: VotingRegisterLine[];
  /** Every vote the association has on the meeting day, present or not. */
  votesTotal: number;
  /**
   * How many of them are in the room.
   *
   * The size of the register and deliberately not a majority basis: EFL measures
   * an ordinary majority against the votes cast, and somebody present who does
   * not vote has cast none. What a decision needed is the chair's to state,
   * which is why {@link MeetingDecision} carries counts rather than deriving
   * them from this.
   */
  votesPresent: number;
  /** Bitraden on the list, and not one of them a vote. */
  assistantsPresent: number;
  /**
   * People present as members whom the register does not show as members on the
   * meeting day, sorted.
   *
   * Reported rather than dropped: check-in happens before the meeting and the
   * register keeps moving until the day itself, so this is what a transfer
   * completed in between looks like.
   */
  presentWithoutMembership: string[];
  /**
   * People present as proxy holder who are exercising no vote, sorted.
   *
   * Four things look like this and all four are answers the chair needs at the
   * door: the authority was withdrawn, it has run out under EFL 6 kap. 4 §, the
   * member who gave it is no longer a member, or that member turned up and is
   * exercising their own right - which is the one case where nothing is wrong.
   */
  proxyHoldersWithoutVote: string[];
  /** Whether the storage-only clause stands. Reported, never applied. */
  storageOnlyVoteLimited: boolean;
}

/** How the sending of one notice is going. */
export interface NoticeDeliveryReport {
  /** Claimed when the notice was issued and not yet handed to a mail server. */
  pending: number;
  sent: number;
  failed: number;
  /** That at least one copy failed because this instance has no mail server. */
  mailNotConfigured: boolean;
  /**
   * The members the notice did not reach, by identifier and never by name.
   *
   * On the report because a notice is a summons rather than an announcement:
   * EFL 6 kap. 21 § has the members called, so a member this platform could not
   * reach is one the board still has to call another way - and a count alone
   * would leave it unable to say which of them.
   */
  unreachedPersonIds: string[];
}

/** The notice (kallelse) that summons a meeting. */
export interface MeetingNotice {
  id: string;
  /** ISO instant: when the meeting begins, on the meeting's own day. */
  startsAt: string;
  place: string;
  /** How the members take part and vote where it is held digitally, or null. */
  digitalParticipation: string | null;
  /** ISO instant. */
  issuedAt: string;
  issuedByPersonId: string;
  deliveries: NoticeDeliveryReport;
}

/** A meeting in the board's list. */
export interface MeetingSummary {
  id: string;
  kind: MeetingKind;
  /** "YYYY-MM-DD": the day that decides who has a vote. */
  heldOn: string;
  /** ISO instant, or null while the meeting is being arranged. */
  concludedAt: string | null;
  /**
   * Whether the notice has been issued.
   *
   * What decides whether anything may still be attached to this meeting: EFL
   * 6 kap. 25 § leaves it unable to decide a matter its notice did not take up,
   * so from that moment no motion may be put to it or taken off it. On the
   * summary because a screen choosing among meetings has to know which of them
   * can still take an item - offering one that cannot is offering a control
   * that can only be refused.
   */
  summoned: boolean;
  agendaItemCount: number;
}

/** One meeting with everything the board's screen reads in one answer. */
export interface Meeting extends MeetingSummary {
  agenda: AgendaItem[];
  attendances: Attendance[];
  proxyAuthorisations: ProxyAuthorisation[];
  bylaws: MeetingBylaws;
  votingRegister: VotingRegister;
  /**
   * The notice, or null while none has been issued.
   *
   * On this answer rather than fetched on its own, because it decides whether
   * the rest of the screen may still be edited at all: once it has been issued
   * the agenda is the record of what the meeting was summoned to deal with, and
   * a board offered a form the server will refuse has been told the wrong thing.
   */
  notice: MeetingNotice | null;
}

export interface ArrangeMeetingInput {
  kind: MeetingKind;
  /** "YYYY-MM-DD". */
  heldOn: string;
}

/**
 * The agenda as the board states it: the running order, as a list.
 *
 * The caller states the order and never the numbers. A caller that stated its
 * own could state a gap or a repeat, which is not a running order.
 */
export interface SetAgendaInput {
  items: { title: string }[];
}

/**
 * The notice, in the terms EFL 6 kap. 22 § has it state itself.
 *
 * A time of day and never a date. The day a meeting is held is the meeting's own
 * and is the day the register is read against, so a notice carrying a second
 * date could summon the members to a different day.
 */
export interface IssueNoticeInput {
  /** "HH:MM" on the meeting's own day, on the association's clock. */
  startsAt: string;
  place: string;
  /** Null for a meeting held in a room; non-empty for one held digitally. */
  digitalParticipation: string | null;
}

export interface RecordAttendanceInput {
  personId: string;
  capacity: AttendanceCapacity;
  mode: AttendanceMode;
  /**
   * The member or proxy holder an assistant came with.
   *
   * Required on that capacity and refused on the other two. Refused rather than
   * dropped: a field a request set and the server silently ignored is a defect
   * nothing surfaces.
   */
  onBehalfOfPersonId: string | null;
}

export interface RegisterProxyInput {
  memberPersonId: string;
  proxyHolderPersonId: string;
  ground: RepresentativeGround;
  /** "YYYY-MM-DD": the day the member signed the authorisation. */
  authorisedOn: string;
}

export interface RecordDecisionInput {
  outcome: MeetingDecisionOutcome;
  votesFor: number;
  votesAgainst: number;
  votesAbstaining: number;
  closedBallot: boolean;
}

// --- the meetings the board arranges ----------------------------------------

/** Every meeting, as the board's list reads them. */
export function fetchMeetings(): Promise<ApiResult<MeetingSummary[]>> {
  return apiRequest("GET", "/api/meetings");
}

/** One meeting with its agenda, its list, its authorities and the register. */
export function fetchMeeting(id: string): Promise<ApiResult<Meeting>> {
  return apiRequest("GET", `/api/meetings/${encodeURIComponent(id)}`);
}

export function arrangeMeeting(
  input: ArrangeMeetingInput,
): Promise<ApiResult<MeetingSummary>> {
  return apiRequest("POST", "/api/meetings", input);
}

/**
 * Records that the meeting has been held.
 *
 * The one act that turns the agenda from a plan into a record of what the
 * meeting dealt with, and the register from a projection of the member register
 * into a fact about a day that has passed. It is also what turns the decision
 * route on: a decision is minuted once the meeting has been held.
 *
 * A post to a named sub-resource rather than a field somebody set, because it is
 * an act with its own entry in the audit log and its own refusal.
 */
export function concludeMeeting(
  id: string,
): Promise<ApiResult<MeetingSummary>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(id)}/conclusion`,
  );
}

/**
 * Replaces the agenda with the items given, in the order given.
 *
 * A put, because it is the whole running order and not an addition: moving an
 * item is the same act as adding one, and an interface offering both would have
 * to reconcile two orderings. Refused once the notice has been issued and once
 * the meeting has been held.
 */
export function setMeetingAgenda(input: {
  id: string;
  values: SetAgendaInput;
}): Promise<ApiResult<AgendaItem[]>> {
  return apiRequest(
    "PUT",
    `/api/meetings/${encodeURIComponent(input.id)}/agenda`,
    input.values,
  );
}

/**
 * Issues the notice that summons the meeting, and sends it.
 *
 * There is deliberately no route that edits or withdraws one: EFL 6 kap. 25 §
 * gives the remedy for a notice that went wrong and it is an extra general
 * meeting, not a second notice.
 */
export function issueMeetingNotice(input: {
  id: string;
  values: IssueNoticeInput;
}): Promise<ApiResult<MeetingNotice>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(input.id)}/notice`,
    input.values,
  );
}

// --- who is present ---------------------------------------------------------

export function recordAttendance(input: {
  id: string;
  values: RecordAttendanceInput;
}): Promise<ApiResult<Attendance>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(input.id)}/attendances`,
    input.values,
  );
}

/**
 * Strikes a line off the list of those present.
 *
 * A post and not a delete: the line stays and takes a date, so "was recorded as
 * present and struck off again" is answerable afterwards.
 */
export function withdrawAttendance(input: {
  id: string;
  attendanceId: string;
}): Promise<ApiResult<Attendance>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(input.id)}/attendances/` +
      `${encodeURIComponent(input.attendanceId)}/withdrawal`,
  );
}

// --- the authorities registered against the meeting -------------------------

export function registerProxy(input: {
  id: string;
  values: RegisterProxyInput;
}): Promise<ApiResult<ProxyAuthorisation>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(input.id)}/proxy-authorisations`,
    input.values,
  );
}

/** Takes an authority back. A date on the row, never a delete. */
export function withdrawProxy(input: {
  id: string;
  authorisationId: string;
}): Promise<ApiResult<ProxyAuthorisation>> {
  return apiRequest(
    "POST",
    `/api/meetings/${encodeURIComponent(input.id)}/proxy-authorisations/` +
      `${encodeURIComponent(input.authorisationId)}/withdrawal`,
  );
}

// --- what the meeting decided -----------------------------------------------

/**
 * Records what the meeting decided on one agenda item.
 *
 * A put, because there is exactly one decision per item and correcting a
 * mis-keyed count writes the same row again. What stands is the signed
 * protokoll; this is the platform's copy of the figure, and the audit log
 * carries what it moved to.
 */
export function recordDecision(input: {
  id: string;
  agendaItemId: string;
  values: RecordDecisionInput;
}): Promise<ApiResult<AgendaItem>> {
  return apiRequest(
    "PUT",
    `/api/meetings/${encodeURIComponent(input.id)}/agenda/` +
      `${encodeURIComponent(input.agendaItemId)}/decision`,
    input.values,
  );
}
