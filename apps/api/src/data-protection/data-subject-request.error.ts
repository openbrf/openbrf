import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A request about somebody's own data could not be recorded, decided or closed.
 *
 * Three kinds of refusal, and the status codes say which is which.
 *
 * A 404 is a request about somebody, or something, that is not there. A 400 is
 * a request that contradicts itself - an erasure with no art. 17(1) ground, a
 * grant that also names an art. 17(3) exception - and is the board being told
 * that the form does not describe a decision anybody could make.
 *
 * A 409 is the interesting one. Every code below it describes a person the
 * request cannot be granted for *yet*: they still live here, they are on the
 * board, a hold stands. These are not errors in the board's reasoning. They are
 * the platform refusing to record a grant the purge could not carry out, and
 * the screen turns each into a sentence the board can act on - because a
 * refusal a board has to write down under art. 12(4) is a decision, and a
 * decision needs a reason somebody can read.
 */
export class DataSubjectRequestError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      // Not there.
      | "person-not-found"
      | "issue-not-found"
      | "request-not-found"
      // Contradicts itself.
      | "erasure-ground-required"
      | "ground-not-applicable"
      | "issue-kind-inconsistent"
      | "erasure-exception-required"
      | "exception-inconsistent"
      | "exception-not-applicable"
      | "decision-ground-required"
      // Describes a state the person is in.
      | "already-open"
      | "already-decided"
      | "already-closed"
      | "currently-resident"
      | "on-legal-hold"
      | "board-position-current"
      | "system-role-current"
      | "processing-restricted",
  ) {
    super(message);
    this.status = NOT_FOUND.has(reason)
      ? HttpStatus.NOT_FOUND
      : CONFLICT.has(reason)
        ? HttpStatus.CONFLICT
        : HttpStatus.BAD_REQUEST;
  }
}

const NOT_FOUND = new Set([
  "person-not-found",
  "issue-not-found",
  "request-not-found",
]);

const CONFLICT = new Set([
  "already-open",
  "already-decided",
  "already-closed",
  "currently-resident",
  "on-legal-hold",
  "board-position-current",
  "system-role-current",
  "processing-restricted",
]);
