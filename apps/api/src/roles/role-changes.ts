import { HttpStatus } from "@nestjs/common";

import type {
  BoardPositionType,
  SystemRoleType,
} from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";

/**
 * The rules behind conferring and revoking a role, with no database in them.
 *
 * Kept apart from the services for the reason the board roster's are: the two
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
  // against a state the register is not in, which is what a second board member
  // pressing the same button a moment later meets.
  "position-already-held": HttpStatus.CONFLICT,
  "term-already-ended": HttpStatus.CONFLICT,
  "ended-before-elected": HttpStatus.CONFLICT,
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
