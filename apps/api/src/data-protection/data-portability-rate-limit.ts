import { HttpStatus, Injectable } from "@nestjs/common";

import { DomainError } from "../http/domain-error";
import {
  type RateLimitDecision,
  TokenBuckets,
} from "../http/public-rate-limit.guard";
import { ExportsBusyError } from "../retention/export-slots";

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
 * reports hold at once is bounded by the slots the report service gathers in
 * (`MAX_CONCURRENT_EXPORTS`), because a budget that starts full lets all twelve
 * begin in the same instant.
 */
export const EXPORTS_PER_MINUTE_OVERALL = 12;

/** Which of the limits turned the request away. */
export type DataPortabilityLimit = "person" | "overall";

/**
 * An export asked for too often, by this person or by everybody together.
 *
 * Two reasons rather than one because the person can act on only one of them:
 * their own budget is waited out by them, and the instance's is waited out by
 * the instance being less busy. The screen says which in its own words, so the
 * message here is for the log and for a developer reading the response. It
 * is a diagnostic and does not address the person.
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
        ? "Per-person export limit reached; retry after the retry-after delay."
        : "Instance export capacity reached; retry after the retry-after delay.",
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
 *
 * How many exports run at once is not counted here. The board's access report
 * gathers the same report in the same transaction, so the slots both are
 * gathered in belong to the report service, which is the one thing both routes
 * reach; this limiter only gives back what it charged when the service turns
 * the export away.
 */
@Injectable()
export class DataPortabilityRateLimiter {
  private readonly people = new TokenBuckets();
  private readonly overall = new TokenBuckets();

  /**
   * Runs `prepare` for `personId` within the budgets, or throws with the delay
   * to wait before anything is prepared.
   *
   * `prepare` may itself turn the export away as busy, when every slot the
   * report is gathered in is taken. Nothing was prepared for it, so it is
   * charged to neither budget: the instance being busy is not something the
   * person did, and their retry after the wait would otherwise find their own
   * budget spent too.
   */
  async run<T>(
    personId: string,
    prepare: () => Promise<T>,
    now: number = Date.now(),
  ): Promise<T> {
    this.admit(personId, now);
    try {
      return await prepare();
    } catch (cause) {
      if (cause instanceof ExportsBusyError) {
        this.people.refund(personId, EXPORTS_PER_PERSON_PER_MINUTE);
        this.overall.refund("overall", EXPORTS_PER_MINUTE_OVERALL);
      }
      throw cause;
    }
  }

  private admit(personId: string, now: number): void {
    /*
     * The person's own budget first. A person who is refused here takes nothing
     * from the overall one, so somebody hammering the button cannot spend the
     * budget everybody else exports from.
     */
    this.refuseUnless(
      this.people.take(personId, EXPORTS_PER_PERSON_PER_MINUTE, now),
      "person",
    );
    const decision = this.overall.take(
      "overall",
      EXPORTS_PER_MINUTE_OVERALL,
      now,
    );
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
