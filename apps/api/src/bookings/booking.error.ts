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
 *
 * `resource-in-use` is the one refusal that is not about the request at all.
 * The configuration is coherent and the board may set it; what refuses it is
 * the bookings that were made under the configuration it replaces.
 */
export class BookingError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "resource-not-found"
      | "resource-deactivated"
      | "resource-in-use"
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
        : reason === "resource-deactivated" || reason === "resource-in-use"
          ? /*
             * A conflict rather than a not-found: the resource exists and the
             * caller may see it, and the request describes a state it is
             * already in, or one it cannot be moved to while other rows stand.
             * The first is what a second board member clicking the same
             * withdraw button a moment later meets; the second is what a board
             * rewriting the laundry slots meets while somebody holds next
             * Tuesday under the old ones.
             */
            HttpStatus.CONFLICT
          : // The request was well formed and describes a resource that cannot
            // be booked by any rule the module has. That is unprocessable
            // rather than malformed: the shape was right.
            HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
