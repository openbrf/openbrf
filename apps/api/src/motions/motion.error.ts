import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Where in a motion a refused value sits.
 *
 * Two fields and no block list, unlike a page or a news item: a motion is a
 * title and a body, and there is nothing else in it to point at. The offset is
 * where in that text the refused value starts, and the value itself never
 * travels - what the scan caught is exactly the thing that must not reach a
 * response body, a log line or a screen somebody else is looking at.
 */
export interface MotionTextLocation {
  part: "title" | "body";
  offset: number;
}

/**
 * A refusal from the motions module.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a member is a decision for the screen. The exception
 * filter catches {@link DomainError} once, so nothing has to be registered for
 * this class.
 *
 * ## What a refusal does not say
 *
 * `motion-not-found` answers a motion that does not exist and one that belongs
 * to somebody else, on the judgement `issues/issue.error.ts` sets out and for
 * the same reason. A member withdrawing a motion that is not theirs gets the
 * answer they would get for one that was never submitted - otherwise the
 * withdraw endpoint reports, for any identifier, whether a motion is there, and
 * who has put what to the meeting is exactly what `motions:handle` exists to
 * gate. It never says whose.
 *
 * `not-a-member` is the opposite case and says what it means, because it is
 * about the caller rather than about anybody else's data: they are being told
 * their own standing in their own association, which they already know and can
 * do something about. Being vague here would leave somebody unable to work out
 * why a form refuses them.
 */
export class MotionError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "not-a-member"
      | "motion-not-found"
      | "already-closed"
      | "motion-withdrawn"
      | "meeting-not-found"
      | "meeting-already-held"
      | "meeting-notice-issued"
      | "personal-identity-number",
    private readonly locations: readonly MotionTextLocation[] = [],
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
   * that echoed it would put it in a response body, and from there into
   * whatever logs that body.
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
function statusFor(reason: MotionError["reason"]): number {
  switch (reason) {
    case "not-a-member":
      /*
       * Forbidden, and the one refusal in this module that is a statement about
       * the statute rather than about a request.
       *
       * EFL 6 kap. 15 § gives the right to put an item to a general meeting to a
       * member. Somebody who lives here without holding a tenant-ownership is
       * understood perfectly well and is refused on the merits, so this is
       * neither a bad request nor a missing thing.
       */
      return HttpStatus.FORBIDDEN;

    case "motion-not-found":
      return HttpStatus.NOT_FOUND;

    case "meeting-not-found":
      /*
       * Says what it means, unlike `motion-not-found` above it. This refusal is
       * reached only from the board's own queue, and a general meeting is the
       * association's own act rather than anybody's data - so there is nothing
       * here for a vague answer to protect, and a board that had put an item to
       * a meeting somebody else had meanwhile removed needs to be told which
       * half of the request was wrong.
       */
      return HttpStatus.NOT_FOUND;

    case "motion-withdrawn":
    case "meeting-already-held":
    case "meeting-notice-issued":
      /*
       * A conflict in each case: the request is well formed and describes a
       * state that has already been settled, and sending it again differently
       * fixes none of them.
       *
       * A motion the member took back is not an item for a meeting. The right in
       * EFL 6 kap. 15 § is the member's to exercise, and taking it back is
       * theirs too, so the board putting it to a meeting anyway would be
       * exercising somebody else's right.
       *
       * A meeting that has been held has dealt with what it was summoned to deal
       * with, and one whose notice has gone out has had that settled: EFL 6 kap.
       * 25 § leaves a meeting unable to decide a matter its notice did not take
       * up without the consent of every member the failure affects, so an item
       * attached after the notice would claim the meeting could deal with
       * something the members were never called to.
       */
      return HttpStatus.CONFLICT;

    case "already-closed":
      /*
       * A conflict: the request is well formed, the caller may see what it
       * names, and it describes a state the motion is already in. This is what a
       * member meets who withdraws a motion the board acknowledged while the
       * page was open, and what a second board member meets clicking the same
       * button - neither of which is fixed by sending a different request.
       */
      return HttpStatus.CONFLICT;

    case "personal-identity-number":
      // Understood and refused on its merits: this motion may not be stored as
      // it stands, and the member is told which part to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
