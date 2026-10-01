import { HttpStatus, Injectable } from "@nestjs/common";

import { DomainError } from "../http/domain-error";
import {
  type RateLimitDecision,
  TokenBuckets,
} from "../http/public-rate-limit.guard";

/**
 * Exports one person may ask for in a minute.
 *
 * An export is something a person does once in a while, so three is generous
 * for an honest caller - a second click, a retry after the connection dropped.
 */
export const EXPORTS_PER_PERSON_PER_MINUTE = 3;

/**
 * Exports the whole instance prepares in a minute, whoever asks.
 *
 * The per-person budget alone does not protect the rest of the API: a few
 * people, or one account that can mint sessions, still add up. This bounds how
 * often the database is asked for a whole report; how many connections the
 * reports hold at once is bounded by {@link MAX_CONCURRENT_EXPORTS}, because a
 * budget that starts full lets all twelve begin in the same instant.
 */
export const EXPORTS_PER_MINUTE_OVERALL = 12;

/**
 * Exports being prepared at the same time, whoever asks.
 *
 * Each export holds one pooled connection while it runs - the retention setting
 * is read before the report's transaction opens, not beside it - so this is the
 * most connections exports can hold, however long their transaction is allowed
 * to take. Three leaves seven of the pool's default ten for everything else the
 * instance does.
 */
export const MAX_CONCURRENT_EXPORTS = 3;

/**
 * The wait a request is told when every export slot is taken.
 *
 * There is no time a slot is known to come free, as there is for a token. An
 * export usually takes well under a second, and a request refused for want of a
 * slot costs nothing but the check, so a second is long enough to be worth the
 * retry and short enough not to keep somebody waiting for nothing.
 */
export const BUSY_RETRY_AFTER_SECONDS = 1;

/** Which of the limits turned the request away. */
export type DataPortabilityLimit = "person" | "overall";

/**
 * An export asked for too often, by this person or by everybody together.
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
      limit === "person"
        ? "Your data has been exported several times in the last minute. Try again shortly."
        : "Many exports are being prepared right now. Try again shortly.",
    );
    this.reason = limit === "person" ? "export-rate-limited" : "export-busy";
  }

  override headers(): Record<string, string> {
    return { "retry-after": String(this.retryAfterSeconds) };
  }
}

/**
 * The limits on the art. 20 export, in this process.
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
  private readonly people = new TokenBuckets();
  private readonly overall = new TokenBuckets();
  private running = 0;

  /**
   * Runs `prepare` for `personId` within the limits, or throws with the delay
   * to wait before anything is prepared.
   *
   * The slot is held until `prepare` settles either way, so an export that
   * fails - a transaction past its timeout, a database gone away - gives its
   * slot back rather than keeping it for good.
   */
  async run<T>(
    personId: string,
    prepare: () => Promise<T>,
    now: number = Date.now(),
  ): Promise<T> {
    // Admitted and counted before the first await, so nothing else can be
    // admitted between the check and the count.
    this.admit(personId, now);
    this.running += 1;
    try {
      return await prepare();
    } finally {
      this.running -= 1;
    }
  }

  private admit(personId: string, now: number): void {
    /*
     * The person's own budget first. A person who is refused here takes nothing
     * from the overall one, so somebody hammering the button cannot spend the
     * budget everybody else exports from.
     *
     * Then a slot, before the overall budget: a request turned away because
     * every slot is taken has prepared nothing, so it spends no token of the
     * instance's either.
     */
    this.refuseUnless(
      this.people.take(personId, EXPORTS_PER_PERSON_PER_MINUTE, now),
      "person",
    );
    const decision: RateLimitDecision =
      this.running < MAX_CONCURRENT_EXPORTS
        ? this.overall.take("overall", EXPORTS_PER_MINUTE_OVERALL, now)
        : { allowed: false, retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
    if (!decision.allowed) {
      /*
       * Nothing is prepared for a request turned away as busy, so it does not
       * count against the person either: the instance being busy is not
       * something they did, and their retry after the wait would otherwise
       * find their own budget spent too.
       */
      this.people.refund(personId, EXPORTS_PER_PERSON_PER_MINUTE);
    }
    this.refuseUnless(decision, "overall");
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
