import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the booking module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board member is a decision for the screen. The
 * exception filter catches {@link DomainError} once, so nothing has to be
 * registered for this class.
 *
 * The four schedule reasons are distinct on purpose. "The slot length does not
 * fit the opening hours" and "a whole-day resource has no slot length" are
 * different mistakes with different fixes, and a single invalid-schedule code
 * would leave the board member reading it to guess which one they made.
 */
export class BookingError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "resource-not-found"
      | "resource-deactivated"
      | "schedule-required"
      | "schedule-not-applicable"
      | "closes-before-opens"
      | "slot-does-not-fit"
      | "quota-not-positive",
  ) {
    super(message);
    this.status =
      reason === "resource-not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "resource-deactivated"
          ? // A conflict rather than a not-found: the resource exists and the
            // caller may see it, and the request describes a state it is
            // already in. This is what a second board member clicking the same
            // withdraw button a moment later meets.
            HttpStatus.CONFLICT
          : // The request was well formed and describes a resource that cannot
            // be booked by any rule the module has. That is unprocessable
            // rather than malformed: the shape was right.
            HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
