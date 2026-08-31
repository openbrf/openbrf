import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** The two limits a refusal can name, as the resource carries them. */
export type BookingQuota = "maxConcurrentBookings" | "maxBookingsPerWeek";

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
 *
 * ## What a refusal does not say
 *
 * Two reasons are deliberately vaguer than what happened, on the judgement
 * `issues/issue.error.ts` sets out and for the same reason.
 *
 * `apartment-not-found` answers an apartment that is not in the register and
 * one the caller does not hold, so a resident cannot walk the building's
 * identifiers one request at a time and learn which ones exist.
 *
 * `booking-not-found` answers a booking that does not exist and one belonging
 * to somebody else. A member cancelling a booking that is not theirs gets the
 * same answer as a member cancelling one that was never made - otherwise the
 * cancel endpoint reports, for any identifier, whether a booking is there, and
 * who holds which hour is exactly what bookings:manage exists to gate.
 *
 * `slot-taken` is the opposite case and says what it means, because the caller
 * was shown that slot on a calendar a moment earlier and learns nothing from
 * being told somebody has it. It never says who.
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
      | "quota-not-positive"
      | "booking-not-found"
      | "apartment-not-found"
      | "range-invalid"
      | "slot-not-bookable"
      | "slot-taken"
      | "quota-reached"
      | "already-cancelled",
    /**
     * Which limit was reached, for `quota-reached` and nothing else.
     *
     * Carried because the two limits are answered differently by whoever reads
     * the refusal: one is waited out and the other is fixed by cancelling
     * something. The field name and the number are configuration the caller is
     * subject to rather than anybody's data, which is what makes them safe to
     * publish through {@link DomainError.details}.
     */
    private readonly quota?: { limit: BookingQuota; allowed: number },
  ) {
    super(message);
    this.status = statusFor(reason);
  }

  override details(): Record<string, readonly unknown[]> {
    return this.quota === undefined
      ? {}
      : { quota: [this.quota.limit], allowed: [this.quota.allowed] };
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: BookingError["reason"]): number {
  switch (reason) {
    case "resource-not-found":
    case "booking-not-found":
    case "apartment-not-found":
      return HttpStatus.NOT_FOUND;

    case "resource-deactivated":
    case "resource-in-use":
    case "slot-taken":
    case "quota-reached":
    case "already-cancelled":
      /*
       * A conflict rather than a not-found or an unprocessable entity: the
       * request is well formed, the caller may see what it names, and it
       * describes a state the thing is already in, or one it cannot be moved
       * to while other rows stand. This is what a second board member clicking
       * the same withdraw button meets, what a board rewriting the laundry
       * slots meets while somebody holds next Tuesday under the old ones, what
       * the loser of a race for the same laundry hour meets, and what a
       * household that has spent its week's allowance meets - none of which
       * stays true for ever, and none of which the caller fixes by sending a
       * different request.
       */
      return HttpStatus.CONFLICT;

    case "schedule-required":
    case "schedule-not-applicable":
    case "closes-before-opens":
    case "slot-does-not-fit":
    case "quota-not-positive":
    case "range-invalid":
    case "slot-not-bookable":
      // The request was well formed and describes something no rule the module
      // has can act on. That is unprocessable rather than malformed: the shape
      // was right.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
