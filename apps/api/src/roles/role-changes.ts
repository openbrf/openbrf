import { HttpStatus } from "@nestjs/common";

import type {
  BoardPositionType,
  SystemRoleType,
} from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";

/**
 * The rules behind conferring and revoking a role, with no database in them.
 *
 * Kept apart from the services for the reason the board roster's are: the
 * decisions that matter here are about combinations of dated facts and counted
 * rows, and a rule that needs a database to exercise is a rule nobody tests
 * exhaustively. What the services add is the transaction, the lock and the
 * audit entry; what is decided is decided here.
 */

export type RoleChangeReason =
  | "person-not-found"
  | "board-position-not-found"
  | "position-already-held"
  | "term-already-ended"
  | "ended-before-elected"
  | "ended-too-far-ahead"
  | "last-administrator";

/**
 * The status each refusal answers with.
 *
 * A map rather than a chain of comparisons, so a reason added to the union and
 * not given a status fails the build instead of defaulting to a conflict.
 */
const ROLE_CHANGE_STATUS: Record<RoleChangeReason, number> = {
  "person-not-found": HttpStatus.NOT_FOUND,
  "board-position-not-found": HttpStatus.NOT_FOUND,
  // Conflicts rather than bad requests: each describes a well-formed request
  // the row it names cannot take - either a state the row is not in, which is
  // what a second board member pressing the same button a moment later meets,
  // or a date that is well formed and impossible against the row's own dates.
  "position-already-held": HttpStatus.CONFLICT,
  "term-already-ended": HttpStatus.CONFLICT,
  "ended-before-elected": HttpStatus.CONFLICT,
  "ended-too-far-ahead": HttpStatus.CONFLICT,
  "last-administrator": HttpStatus.CONFLICT,
};

export class RoleChangeError extends DomainError {
  override readonly status: number;
  override readonly reason: RoleChangeReason;

  constructor(message: string, reason: RoleChangeReason) {
    super(message);
    this.reason = reason;
    this.status = ROLE_CHANGE_STATUS[reason];
  }
}

/** One position of trust, as a screen reads it. */
export interface BoardPositionView {
  boardPositionId: string;
  personId: string;
  position: BoardPositionType;
  /** ISO calendar date. An election always has one. */
  electedOn: string;
  /** ISO calendar date, or null while the seat is held. */
  endedOn: string | null;
}

/** Every system role one person holds, after a grant or a revoke. */
export interface SystemRoleGrantsView {
  personId: string;
  roles: SystemRoleType[];
}

/**
 * Whether a seat is held at a given moment.
 *
 * The same rule the principal applies, and it has to be: a seat with an end
 * date in the future is still held, which is how a board records at its April
 * meeting that a term runs until the annual one. A second spelling of this here
 * would let the register refuse an election for a seat the principal no longer
 * grants anything for, or accept a duplicate of one it does.
 *
 * @see apps/api/src/authorization/principal.service.ts
 */
export function isHeldOn(seat: { endedOn: Date | null }, now: Date): boolean {
  return seat.endedOn === null || seat.endedOn.getTime() > now.getTime();
}

/**
 * How far past today a term may be recorded as running.
 *
 * A board is elected at the general meeting for the period the bylaws set,
 * which in a housing cooperative is a year or two, so five is generous rather
 * than tight. The number is not a rule about mandates and must not be read as
 * one: it is the distance past which a date is a mistyped year far more often
 * than a decision, and the reason it has to be bounded at all is that the seat
 * keeps granting the board's capabilities until its end date arrives. A term
 * typed as ending in 2206 rather than 2026 would confer them for the rest of
 * the instance's life.
 */
const TERM_HORIZON_YEARS = 5;

/** The last day a term may be recorded as ending on. */
export function latestTermEnd(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear() + TERM_HORIZON_YEARS,
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
}

/** What stops an end date being written onto a seat, if anything does. */
export type TermEndRefusal =
  "term-already-ended" | "ended-before-elected" | "ended-too-far-ahead";

/**
 * Whether this seat can be recorded as ending on this date.
 *
 * Three refusals, and the first is what makes a mistyped date correctable. A
 * term is amendable for as long as it is still held - which is exactly the
 * rule the principal grants access by, so the window in which the end date can
 * be changed is the window in which it still confers anything. Once the date
 * has passed, the row is the record of a period that has run and it stands:
 * the seat stopped granting on that day, and nothing is gained by rewriting
 * when it did.
 *
 * That is why the horizon and the amendment belong together. A bound alone
 * would still leave a plausible-but-wrong date - next year instead of this one
 * - uncorrectable through the API, and an amendment alone would leave the
 * 180-year typo granting the board's capabilities until somebody edited the
 * database by hand.
 *
 * @param currentEndedOn the end date the seat carries now: null while the term
 * is open, a date once one has been written.
 */
export function refuseTermEnd(input: {
  electedOn: Date;
  currentEndedOn: Date | null;
  endedOn: Date;
  now: Date;
}): TermEndRefusal | null {
  if (!isHeldOn({ endedOn: input.currentEndedOn }, input.now)) {
    return "term-already-ended";
  }
  if (input.endedOn.getTime() < input.electedOn.getTime()) {
    return "ended-before-elected";
  }
  if (input.endedOn.getTime() > latestTermEnd(input.now).getTime()) {
    return "ended-too-far-ahead";
  }
  return null;
}

/**
 * Whether revoking this grant would leave the instance with no administrator.
 *
 * The lockout guard. An instance with no ADMIN grant has no way back in: the
 * setup wizard closes as soon as an account exists, every settings screen is
 * behind `association:manage`, and this endpoint is behind
 * `systemRole:manage` - so the last administrator revoking the grant would
 * shut the door from the inside with the key still in it.
 *
 * The case that matters most is an administrator revoking their own grant,
 * which is why this takes the ids rather than a count: "am I the last one" and
 * "is this person the last one" are the same question, and answering it from a
 * count alone would refuse a revoke on somebody who does not hold the grant at
 * all merely because exactly one administrator exists.
 *
 * Revoking from somebody who is not an administrator is not a lockout: it
 * changes nothing, and the service answers with the state as it is.
 *
 * @param administratorPersonIds every person holding ADMIN, read in the same
 * transaction as the write this guards.
 */
export function revokingWouldLeaveNoAdministrator(input: {
  role: SystemRoleType;
  administratorPersonIds: readonly string[];
  targetPersonId: string;
}): boolean {
  if (input.role !== "ADMIN") {
    return false;
  }
  if (!input.administratorPersonIds.includes(input.targetPersonId)) {
    return false;
  }
  return input.administratorPersonIds.every(
    (personId) => personId === input.targetPersonId,
  );
}

/** An ISO calendar date as the day it names, in UTC. */
export function parseCalendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The day out of a date. Register dates are days, never instants. */
export function toCalendarDate(value: Date): string {
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
