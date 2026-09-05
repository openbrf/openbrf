import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";

/**
 * Every refusal the meetings screen can meet, in one sentence each.
 *
 * The API answers with a code rather than a sentence, because the interface is
 * Swedish and the server's messages are English, and how a refusal is worded is
 * a decision for the screen. So this is where the module's refusals become
 * something a board member standing at the door with a queue behind them can act
 * on.
 *
 * Held in one module rather than in each panel because the panels meet the same
 * refusals: a meeting recorded as held refuses a check-in, a new authority and a
 * rewritten agenda alike, and a copy of the map per panel would drift into three
 * sentences for one fact.
 *
 * ## Five of these are 403s and none of them is about a permission
 *
 * `failureMessageKey` answers every 403 with one sentence before it consults a
 * map, which is right for the guard refusing an account that does not hold
 * `meetings:manage` and wrong for every refusal below that shares the status.
 * A board member told "your account is not allowed to change this" while
 * standing at a door with a queue behind them would go looking for somebody to
 * grant them something; what they have actually been told is what the statute
 * or their own bylaws say about who may act at this meeting.
 *
 * So this module's own map is consulted first and the shared branch is the
 * fallback - the same shape the motions module uses for `not-a-member`, and for
 * the same reason. See {@link meetingFailureKey}.
 */

/**
 * The reasons the meetings module refuses with.
 *
 * Mirrored from the API's own union rather than imported, like every other wire
 * shape in this client, and written out in full rather than left as `string`:
 * the map below is checked against it with `satisfies`, so a reason the server
 * gains and this client has no sentence for is a compile error here rather than
 * a wrong sentence on a board member's screen at a meeting.
 *
 * That check is the point of writing the union out. A map typed only as
 * `Record<string, TranslationKey>` compiles with a reason missing and falls
 * through to the unknown sentence at runtime, which is a defect nothing surfaces
 * until somebody meets it.
 */
export type MeetingReason =
  | "meeting-not-found"
  | "meeting-already-held"
  | "meeting-not-held"
  | "agenda-item-not-found"
  | "date-not-a-calendar-date"
  | "not-a-member-on-the-meeting-day"
  | "proxy-holder-not-a-member"
  | "proxy-holder-not-permitted-by-bylaws"
  | "proxy-holder-limit-reached"
  | "proxy-authority-not-yet-issued"
  | "proxy-authority-expired"
  | "proxy-authorisation-not-found"
  | "attendance-not-found"
  | "attendance-principal-not-applicable"
  | "assistant-principal-not-present"
  | "proxy-holder-holds-no-authority"
  | "notice-already-issued"
  | "meeting-has-no-agenda"
  | "notice-time-not-on-the-meeting-day";

/**
 * Every reason, and the sentence it becomes.
 *
 * Total over {@link MeetingReason} and checked as such. `invalid-body` is the
 * endpoint's own schema refusal and is the one key here that is not a domain
 * reason - for these forms it means a value the screen should not have been able
 * to send.
 *
 * The refusals about a proxy authorisation stay separate sentences, because they
 * are met by different people holding different pieces of paper and each has a
 * different answer. "The person you named is not a member", "your bylaws do not
 * let anybody else hold one", "this person is already carrying as many members
 * as your bylaws allow", "that authority is dated after the meeting" and "that
 * authority is more than a year old" send a board member to five different
 * places, and one sentence about an invalid authorisation would leave them
 * guessing which.
 *
 * `meeting-already-held` and `meeting-not-held` are likewise not one refusal.
 * One refuses changing a meeting that is over, the other refuses minuting a
 * decision at a meeting that is not - and they are met on opposite halves of the
 * same screen, in that order, over the life of one meeting.
 */
const MEETING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // The two reads that go stale under a board working the screen in two tabs,
  // or two board members working it at once.
  "meeting-not-found": "meetings.errors.meetingNotFound",
  "agenda-item-not-found": "meetings.errors.agendaItemNotFound",

  /*
   * The state of the meeting itself, which is what decides which half of the
   * screen is a form and which half is a record.
   */
  "meeting-already-held": "meetings.errors.meetingAlreadyHeld",
  "meeting-not-held": "meetings.errors.meetingNotHeld",

  /*
   * The notice, and what issuing it settles. EFL 6 kap. 22 § has the notice
   * state clearly the matters to be dealt with, so a meeting with an empty
   * agenda has nothing to summon anybody for; and once it is out, 6 kap. 25 §
   * leaves the meeting unable to decide a matter the notice did not take up,
   * which is why the agenda is then fixed.
   */
  "notice-already-issued": "meetings.errors.noticeAlreadyIssued",
  "meeting-has-no-agenda": "meetings.errors.meetingHasNoAgenda",
  "notice-time-not-on-the-meeting-day":
    "meetings.errors.noticeTimeNotOnTheMeetingDay",

  /*
   * A date that is not one. "2027-02-30" is refused rather than read as the 2nd
   * of March, which is what the browser's own parser would make of it.
   */
  "date-not-a-calendar-date": "meetings.errors.dateNotACalendarDate",

  /*
   * Checking somebody in. Each of these names the line that cannot be written
   * and why, because the board member reading it is at the door: EFL 6 kap. 2-3
   * §§ give the right to attend and the vote to a member, and 6 kap. 7 § has an
   * assistant brought by a member or a proxy holder - so an assistant with
   * nobody on the list to have brought them has not been said to have come with
   * anybody.
   */
  "not-a-member-on-the-meeting-day":
    "meetings.errors.notAMemberOnTheMeetingDay",
  "proxy-holder-holds-no-authority":
    "meetings.errors.proxyHolderHoldsNoAuthority",
  "assistant-principal-not-present":
    "meetings.errors.assistantPrincipalNotPresent",
  "attendance-principal-not-applicable":
    "meetings.errors.attendancePrincipalNotApplicable",
  "attendance-not-found": "meetings.errors.attendanceNotFound",

  /*
   * Registering an authority, refused against the statute and against the
   * association's own bylaws. BRL 9 kap. 14 § 4 decides who may hold one and how
   * many they may carry; EFL 6 kap. 4 § holds one good for at most a year from
   * the day the member signed it, and a member cannot have signed on a day that
   * has not arrived.
   */
  "proxy-holder-not-a-member": "meetings.errors.proxyHolderNotAMember",
  "proxy-holder-not-permitted-by-bylaws":
    "meetings.errors.proxyHolderNotPermittedByBylaws",
  "proxy-holder-limit-reached": "meetings.errors.proxyHolderLimitReached",
  /*
   * The wire codes say "authority" and stay as they are - they are the API's
   * contract - while the sentences they become use the glossary's canonical
   * noun, which is "proxy authorisation".
   */
  "proxy-authority-not-yet-issued":
    "meetings.errors.proxyAuthorisationNotYetIssued",
  "proxy-authority-expired": "meetings.errors.proxyAuthorisationExpired",
  "proxy-authorisation-not-found": "meetings.errors.proxyAuthorisationNotFound",

  "invalid-body": "meetings.errors.invalidBody",
} satisfies Record<MeetingReason | "invalid-body", TranslationKey>;

/**
 * The sentence for a refusal from this module.
 *
 * This module's own reasons are resolved before the shared branches, which is
 * the whole reason this wrapper exists rather than the map being passed straight
 * to {@link failureMessageKey}. Five of the refusals below are 403s - a person
 * who is not a member on the meeting day, a proxy holder who is not another
 * member, one the bylaws do not permit, one already carrying as many members as
 * they allow, and one holding no authority at all - and the shared 403 branch
 * would answer all five with a sentence about permissions. Every one of them is
 * a statement about BRL 9 kap. 14 § or about the association's own stadgar, and
 * each names the rule so the board knows what to do next.
 *
 * Anything this module does not name still falls through, so the guard refusing
 * an account without `meetings:manage` keeps its own sentence.
 */
export function meetingFailureKey(failure: ApiFailure): TranslationKey {
  const own = MEETING_FAILURES[failure.reason];
  if (own !== undefined) {
    return own;
  }
  return failureMessageKey(
    failure,
    MEETING_FAILURES,
    "meetings.errors.unknown",
  );
}
