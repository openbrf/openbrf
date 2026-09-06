import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Where in a subletting application a refused value sits.
 *
 * Two fields, and they are written by two different people. `reason` is the
 * applicant's own account of why they want to let; `decisionNote` is what the
 * board wrote when it answered. Both are scanned, because both travel: the note
 * is quoted back to the applicant and both are printed on a data subject access
 * report, so a personal identity number in either is a disclosure the
 * association cannot take back.
 *
 * The offset is where in that text the refused value starts, and the value
 * itself never travels - what the scan caught is exactly the thing that must not
 * reach a response body, a log line or a screen somebody else is looking at.
 */
export interface SubletTextLocation {
  part: "reason" | "decisionNote";
  offset: number;
}

/**
 * A refusal from the sublets module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a member is a decision for the screen. The exception
 * filter catches {@link DomainError} once, so nothing has to be registered for
 * this class.
 *
 * ## What a refusal does not say
 *
 * `application-not-found` answers an application that does not exist and one
 * that belongs to somebody else, on the judgement `issues/issue.error.ts` sets
 * out and for the same reason. A member revising or withdrawing an application
 * that is not theirs gets the answer they would get for one that was never made
 * - otherwise the endpoint reports, for any identifier, whether an application is
 * there, and who has asked to let what is exactly what `sublets:handle` exists
 * to gate.
 *
 * `apartment-not-found` is the same judgement one table along, and the booking
 * module's `requireOwnApartment` states it: an apartment the caller holds no
 * tenant-ownership in answers exactly as one that is not in the register,
 * because a distinguishable answer would let this endpoint enumerate the
 * building.
 *
 * `not-a-member` is the opposite case and says what it means, because it is
 * about the caller rather than about anybody else's data: they are being told
 * their own standing in their own association, which they already know and can
 * do something about.
 */
export class SubletError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "not-a-member"
      | "apartment-not-found"
      | "application-not-found"
      | "already-closed"
      | "not-refused"
      | "invalid-period"
      | "personal-identity-number",
    private readonly locations: readonly SubletTextLocation[] = [],
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
function statusFor(reason: SubletError["reason"]): number {
  switch (reason) {
    case "not-a-member":
      /*
       * Forbidden, and the one refusal in this module that is a statement about
       * the statute rather than about a request.
       *
       * BRL 7 kap. 10 § gives the act to a bostadsrattshavare: it is their
       * apartment they are letting, and the consent is about the tenant-ownership
       * rather than about living in the building. Somebody who lives here without
       * holding one is understood perfectly well and is refused on the merits, so
       * this is neither a bad request nor a missing thing.
       */
      return HttpStatus.FORBIDDEN;

    case "apartment-not-found":
    case "application-not-found":
      return HttpStatus.NOT_FOUND;

    case "already-closed":
      /*
       * A conflict: the request is well formed, the caller may see what it
       * names, and it describes a state the application is already in. This is
       * what an applicant meets who withdraws a request the board answered while
       * the page was open, and what a second board member meets answering the
       * same one - neither of which is fixed by sending a different request.
       */
      return HttpStatus.CONFLICT;

    case "not-refused":
      /*
       * A conflict of the same kind, one paragraph further on. BRL 7 kap. 11 §
       * opens the rent tribunal route on the board having refused consent -
       * "Vagrar styrelsen att ge sitt samtycke" - so a permission recorded
       * against an application that was consented to, withdrawn or not yet
       * answered describes a proceeding that had no ground to be brought.
       * Sending it again differently does not fix that; what changes it is the
       * board's own answer.
       */
      return HttpStatus.CONFLICT;

    case "invalid-period":
      // Understood and refused on its merits: a period whose last day is before
      // its first is not a period, and the applicant is told which end to move.
      return HttpStatus.UNPROCESSABLE_ENTITY;

    case "personal-identity-number":
      // Understood and refused on its merits: this text may not be stored as it
      // stands, and whoever wrote it is told which field to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
