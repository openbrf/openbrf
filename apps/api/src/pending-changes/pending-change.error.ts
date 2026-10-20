import { HttpStatus } from "@nestjs/common";
import type { PendingChangeReason } from "@openbrf/shared";

import { DomainError } from "../http/domain-error";

/**
 * A refusal from the pending-change queue, about the pending change itself.
 *
 * `pending-change-not-found` answers a change that never existed, one somebody
 * else proposed, one already confirmed or rejected, and one past its expiry, all
 * alike. A distinguishable answer would tell anybody holding an identifier
 * whether somebody had a change waiting, and what a person was about to do is
 * theirs until they do it. For the person it is addressed to the remedy is the
 * same in every case: the change is not there to act on any more.
 *
 * A refusal raised by the held action when it is confirmed is not this class.
 * It is the action's own, raised by its own service with its own reason, and
 * travels to the screen untouched.
 */
export class PendingChangeError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: PendingChangeReason,
  ) {
    super(message);
    this.status = statusFor(reason);
  }
}

/**
 * The status a reason answers with, as a switch over the whole union so a
 * reason added without one is a compile error.
 */
function statusFor(reason: PendingChangeReason): number {
  switch (reason) {
    case "pending-change-not-found":
      return HttpStatus.NOT_FOUND;
  }
}
