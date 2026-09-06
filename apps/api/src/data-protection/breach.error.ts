import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A personal data breach could not be recorded, corrected, decided or closed.
 *
 * The 400s are a record that would contradict itself: a decision saying IMY
 * need not be told about something the board also called a risk, a
 * notification made after the bound with no reasons for the delay. GDPR
 * art. 33 requires the record to be able to demonstrate compliance, and a
 * record that says two things at once demonstrates nothing.
 *
 * The 409s are a breach that is already in the state being asked for, which is
 * what a second board member clicking the same button a moment later meets.
 */
export class BreachError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "breach-not-found"
      | "person-not-found"
      | "personal-identity-number"
      | "discovered-in-future"
      | "risk-inconsistent"
      | "subjects-ground-required"
      | "delay-reasons-required"
      | "already-decided"
      | "not-decided"
      | "already-closed"
      | "already-subject",
  ) {
    super(message);
    this.status =
      reason === "breach-not-found" || reason === "person-not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "already-decided" ||
            reason === "not-decided" ||
            reason === "already-closed" ||
            reason === "already-subject"
          ? HttpStatus.CONFLICT
          : HttpStatus.BAD_REQUEST;
  }
}
