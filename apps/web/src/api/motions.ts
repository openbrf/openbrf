import { apiRequest, type ApiResult } from "./client";
import type { MeetingKind } from "./meetings";

/**
 * The motion endpoints (motioner till stamman).
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * One property of the contract is load-bearing and invisible in the types.
 * Submitting is a member's right under EFL 6 kap. 15 § and not a resident's, so
 * `motions:submit` is derived from membership on the server - and the server asks
 * the register again before it writes, because an administrator holds every
 * capability and no membership. A screen that hid the form from a non-member
 * would be a courtesy; the refusal is the rule.
 *
 * The deadline travels with the intake rather than being read from the settings.
 * It is the association's own bylaws clause and the form is unusable without it,
 * so it is part of the answer rather than something the screen goes and looks up.
 */

export type MotionStatus = "SUBMITTED" | "ACKNOWLEDGED" | "WITHDRAWN";

/** The deadline the bylaws set, and the date it next falls on. */
export interface MotionDeadline {
  /** 1 to 12, as the clause writes it. */
  month: number;
  /** 1 to 31, as the clause writes it. */
  day: number;
  /** "YYYY-MM-DD": the next occurrence, today included. */
  nextOn: string;
}

/**
 * The general meeting a motion has been put to.
 *
 * Named rather than given as a bare identifier, and it is the member's own view
 * that decides that: EFL 6 kap. 15 § gives the member the right to have their
 * item taken up at a general meeting, so "which meeting, and when" is the answer
 * the right is about - and an identifier a member holds no capability to resolve
 * would not be an answer at all.
 */
export interface MotionMeeting {
  id: string;
  kind: MeetingKind;
  /** "YYYY-MM-DD": the day the meeting is held. */
  heldOn: string;
  /**
   * Whether the notice has been issued, which is what settles the agenda: once
   * it has, the item cannot be moved to another meeting or taken off this one.
   */
  summoned: boolean;
}

/** A motion as the member who submitted it reads it back. */
export interface OwnMotion {
  id: string;
  title: string;
  body: string;
  status: MotionStatus;
  submittedAt: string;
  closedAt: string | null;
  /** The meeting the board has put it to, or null while none has. */
  meeting: MotionMeeting | null;
}

/**
 * Who submitted a motion, as the board is told.
 *
 * `protected` is a member with protected personal data, whose name the queue
 * withholds even though the board's own address book prints it. `unknown` is a
 * reference that no longer resolves to a person, which a service-tier table has
 * to be able to say rather than break.
 */
export type MotionSubmitter =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** A motion as the board reads it in the queue. */
export interface QueuedMotion extends OwnMotion {
  submitter: MotionSubmitter;
  closedByPersonId: string | null;
}

export interface MotionIntake {
  deadline: MotionDeadline | null;
  motions: OwnMotion[];
}

export interface MotionQueue {
  deadline: MotionDeadline | null;
  motions: QueuedMotion[];
}

// --- a member's own intake ---------------------------------------------------

export function fetchMotionIntake(): Promise<ApiResult<MotionIntake>> {
  return apiRequest("GET", "/api/motions/mine");
}

export function submitMotion(input: {
  title: string;
  body: string;
}): Promise<ApiResult<{ id: string }>> {
  return apiRequest("POST", "/api/motions", input);
}

export function withdrawMotion(input: {
  motionId: string;
}): Promise<ApiResult<OwnMotion>> {
  return apiRequest(
    "POST",
    `/api/motions/${encodeURIComponent(input.motionId)}/withdrawal`,
  );
}

// --- the queue the board works ----------------------------------------------

export function fetchMotionQueue(): Promise<ApiResult<MotionQueue>> {
  return apiRequest("GET", "/api/motion-queue");
}

/**
 * Records that the board has received a motion and will put it to a meeting.
 *
 * Not an approval, and there is deliberately no endpoint that rejects one:
 * refusing to take up a member's item is not the board's to decide under
 * EFL 6 kap. 15 §, and whether the meeting adopts the proposal is minuted at the
 * meeting.
 */
export function acknowledgeMotion(input: {
  motionId: string;
}): Promise<ApiResult<QueuedMotion>> {
  return apiRequest(
    "POST",
    `/api/motion-queue/${encodeURIComponent(input.motionId)}/acknowledgement`,
  );
}

/**
 * Records which general meeting takes this item up, or takes that answer back.
 *
 * EFL 6 kap. 15 § gives the member the right to have an item taken up at a
 * general meeting if the written request reaches the board in time for it to be
 * taken up in the notice to that meeting, and 6 kap. 22 § has that notice state
 * the matters to be dealt with. So the board is answering "which meeting", and
 * the notice is what settles the answer: the link is writable while the meeting
 * is still being arranged and refused once its notice has been issued - which is
 * why the meeting being left is checked as well as the one being joined.
 *
 * Null takes the answer back, which is the same act rather than a second route:
 * moving an item from one meeting to another and taking it off one altogether
 * are the same decision about the same field.
 */
export function setMotionMeeting(input: {
  motionId: string;
  meetingId: string | null;
}): Promise<ApiResult<QueuedMotion>> {
  return apiRequest(
    "PUT",
    `/api/motion-queue/${encodeURIComponent(input.motionId)}/meeting`,
    { meetingId: input.meetingId },
  );
}

// --- the bylaws clause, on the settings singleton ---------------------------

/**
 * Records the deadline the bylaws set, or clears it.
 *
 * On the write half of the settings singleton, so it takes association:manage
 * while the board reads it with association:read - the split the retention
 * policy already follows.
 */
export function saveMotionDeadline(input: {
  motionDeadline: { month: number; day: number } | null;
}): Promise<
  ApiResult<{ motionDeadline: { month: number; day: number } | null }>
> {
  return apiRequest("PUT", "/api/settings/motion-deadline", input);
}
