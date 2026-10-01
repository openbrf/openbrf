import { HttpStatus, Injectable } from "@nestjs/common";

import { DomainError } from "../http/domain-error";
import {
  type RateLimitDecision,
  TokenBuckets,
} from "../http/public-rate-limit.guard";

/**
 * Exports one member may ask for in a minute.
 *
 * An export is something a person does once in a while, so three is generous
 * for an honest caller - a second click, a retry after the connection dropped -
 * and it is also the most connections one account can hold at a time, since
 * the report is gathered in a single transaction.
 */
export const EXPORTS_PER_MEMBER_PER_MINUTE = 3;

/**
 * Exports the whole instance prepares in a minute, whoever asks.
 *
 * The per-member budget alone does not protect the rest of the API: a few
 * members, or one account that can mint sessions, still add up. The report may
 * hold its transaction for up to 30 seconds, so by Little's law twelve a minute
 * is six connections at the very worst, which leaves four of Prisma's default
 * ten for everything else the instance does.
 */
export const EXPORTS_PER_MINUTE_OVERALL = 12;

/** Which of the two budgets turned the request away. */
export type DataPortabilityLimit = "member" | "overall";

/**
 * An export asked for too often, by this member or by everybody together.
 *
 * Two reasons rather than one because the person can act on only one of them:
 * their own budget is waited out by them, and the instance's is waited out by
 * the instance being less busy. The screen says which in its own words, so the
 * message here is for the log and for a developer reading the response.
 */
export class DataPortabilityRateLimitedError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason: "export-rate-limited" | "export-busy";

  constructor(
    limit: DataPortabilityLimit,
    private readonly retryAfterSeconds: number,
  ) {
    super(
      limit === "member"
        ? "Your data has been exported several times in the last minute. Try again shortly."
        : "Many exports are being prepared right now. Try again shortly.",
    );
    this.reason = limit === "member" ? "export-rate-limited" : "export-busy";
  }

  override headers(): Record<string, string> {
    return { "retry-after": String(this.retryAfterSeconds) };
  }
}

/**
 * The budgets on the art. 20 export, in this process.
 *
 * The same token buckets the public forms use, for the same reason and with the
 * same limit: one process per instance, so what it counts is everything the
 * instance answers. They are held here and not in the public guard because that
 * guard keys on a client address and is for routes with no account behind them;
 * this route has one, and the account is the thing to count.
 *
 * Keyed on the person the principal names, which is also the only person the
 * route will export. A session minted again does not start a fresh budget.
 */
@Injectable()
export class DataPortabilityRateLimiter {
  private readonly members = new TokenBuckets();
  private readonly overall = new TokenBuckets();

  /** Spends a token for `personId`, or throws with the delay to wait. */
  take(personId: string, now: number = Date.now()): void {
    /*
     * The member's own budget first. A member who is refused here takes nothing
     * from the overall one, so a person hammering the button cannot spend the
     * budget everybody else exports from.
     */
    this.refuseUnless(
      this.members.take(personId, EXPORTS_PER_MEMBER_PER_MINUTE, now),
      "member",
    );
    this.refuseUnless(
      this.overall.take("overall", EXPORTS_PER_MINUTE_OVERALL, now),
      "overall",
    );
  }

  private refuseUnless(
    decision: RateLimitDecision,
    limit: DataPortabilityLimit,
  ): void {
    if (!decision.allowed) {
      throw new DataPortabilityRateLimitedError(
        limit,
        decision.retryAfterSeconds,
      );
    }
  }
}
