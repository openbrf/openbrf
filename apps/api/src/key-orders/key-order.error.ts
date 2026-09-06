import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Where in a key order a refused value sits.
 *
 * Two fields, written by two different people. `note` is what the resident said
 * the key is for; `boardNote` is what the board wrote when it answered. Both are
 * scanned, because both travel: the board's note is quoted back to the resident
 * on their own screen, and both are printed on a data subject access report.
 *
 * The offset is where in that text the refused value starts, and the value
 * itself never travels - what the scan caught is exactly the thing that must not
 * reach a response body, a log line or a screen somebody else is looking at.
 */
export interface KeyOrderTextLocation {
  part: "note" | "boardNote";
  offset: number;
}

/**
 * A refusal from the key orders module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a resident is a decision for the screen. The exception
 * filter catches {@link DomainError} once, so nothing has to be registered for
 * this class.
 *
 * ## What a refusal does not say
 *
 * `order-not-found` answers an order that does not exist and one that belongs to
 * somebody else, on the judgement `issues/issue.error.ts` sets out and for the
 * same reason. A resident revising or withdrawing an order that is not theirs
 * gets the answer they would get for one that was never placed - otherwise the
 * endpoint reports, for any identifier, whether an order is there, and who has
 * asked for a key to which apartment is exactly what `keyOrders:handle` exists
 * to gate.
 *
 * `apartment-not-found` is the same judgement one table along, and the booking
 * module's `requireOwnApartment` states it: an apartment the caller does not live
 * in answers exactly as one that is not in the register, because a
 * distinguishable answer would let this endpoint enumerate the building. It is
 * also the refusal an administrator meets, which is correct rather than
 * incidental: they hold every capability in the model and no residency, so there
 * is no apartment here that is theirs to order a key for.
 *
 * There is deliberately no refusal about the resident's standing to match the
 * motions module's `not-a-member`. Nothing statutory decides who may ask the
 * association for a key, so there is no statement of law to make: what decides it
 * is whether the caller lives in the apartment they are naming, and that is the
 * apartment refusal above.
 */
export class KeyOrderError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "apartment-not-found"
      | "order-not-found"
      | "already-closed"
      | "personal-identity-number",
    private readonly locations: readonly KeyOrderTextLocation[] = [],
  ) {
    super(message);
    this.status = statusFor(reason);
  }

  /**
   * Where the refused value sits, and nothing more.
   *
   * A part name and an offset: both are positions rather than content, which is
   * what makes them safe to publish through {@link DomainError.details}. The
   * personal identity number the scan found is deliberately absent - a refusal
   * that echoed it would put it in a response body, and from there into whatever
   * logs that body.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.locations };
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: KeyOrderError["reason"]): number {
  switch (reason) {
    case "apartment-not-found":
    case "order-not-found":
      return HttpStatus.NOT_FOUND;

    case "already-closed":
      /*
       * A conflict: the request is well formed, the caller may see what it
       * names, and it describes a state the order is already in. This is what a
       * resident meets who withdraws an order the board handed over while the
       * page was open, and what a second board member meets answering the same
       * one - neither of which is fixed by sending a different request.
       */
      return HttpStatus.CONFLICT;

    case "personal-identity-number":
      // Understood and refused on its merits: this text may not be stored as it
      // stands, and whoever wrote it is told which field to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
