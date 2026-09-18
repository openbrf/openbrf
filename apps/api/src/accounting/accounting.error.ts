import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

export type AccountingReason =
  "housing-cooperative-missing" | "date-not-a-calendar-date" | "range-invalid";

/**
 * A refusal from the accounting basis export.
 *
 * It travels as a code rather than as this message, like every other domain
 * error: the interface is Swedish and these sentences are English, and how a
 * refusal is worded for a board member is a decision for the screen. The
 * exception filter catches {@link DomainError} once, so nothing has to be
 * registered for this class.
 *
 * Three reasons and no more, because the export decides nothing. It reads a
 * period and writes what was billed and charged in it: there is no amount to
 * refuse, no date to place in the past and no state of the instance that makes
 * a period the wrong one to ask about. The two about the period are the
 * debiting list's own, spelled the same way, because the two exports are asked
 * the same question in the same words.
 */
export class AccountingError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: AccountingReason,
  ) {
    super(message);
    this.status = statusFor(reason);
  }
}

/**
 * The status a reason answers with.
 *
 * A switch over the whole union rather than a chain of ternaries, so a reason
 * added without a status is a compile error rather than a 500 in production.
 */
function statusFor(reason: AccountingReason): number {
  switch (reason) {
    case "housing-cooperative-missing":
      /*
       * The request was well formed and refused by the state of the instance
       * rather than by its own contents. The settings module and the fees
       * module answer a missing housing cooperative the same way.
       */
      return HttpStatus.CONFLICT;

    case "date-not-a-calendar-date":
    case "range-invalid":
      // Understood and refused on its merits: the shape was right, and the
      // board is told which part of what they stated to change.
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
