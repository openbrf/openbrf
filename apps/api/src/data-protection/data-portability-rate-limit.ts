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
 *
 * A person holds at most one of the three. Otherwise one account could ask for
 * its whole budget in the same instant and have everybody else refused as busy
 * until those exports finished, which on a slow database is the length of the
 * report's transaction.
 */
export const MAX_CONCURRENT_EXPORTS = 3;

/**
 * The shortest wait a request is told when it is refused as busy.
 *
 * A slot has no time it is known to come free, as a token has. The longest an
 * export can hold one is the report's transaction timeout, thirty seconds
 * (`REPORT_TRANSACTION_TIMEOUT_MS` in `retention/data-subject-report.service.ts`),
 * but that is the export that fails, not the usual one: an export takes well
 * under a second. Telling every refused request the worst case would keep
 * people waiting half a minute for a slot that was free a moment later, while a
 * retry refused again costs nothing but the check. So a second, and the
 * instance's own budget when that is the longer wait: a request the slots turn
 * away is not charged a token of it, but its retry needs one.
 */
export const BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * Which of the limits turned the request away: the person's budget, an export
 * of theirs already being prepared, or the instance's slots and budget.
 */
export type DataPortabilityLimit = "person" | "preparing" | "overall";

const DIAGNOSTICS: Record<DataPortabilityLimit, string> = {
  person: "Per-person export limit reached; retry after the retry-after delay.",
  preparing:
    "An export for this person is already being prepared; retry after the retry-after delay.",
  overall:
    "Instance export capacity reached; retry after the retry-after delay.",
};

/**
 * An export asked for too often, by this person or by everybody together.
 *
 * Two reasons rather than one because the person can act on only one of them:
 * their own budget is waited out by them, and the instance's is waited out by
 * the instance being less busy. An export of theirs already being prepared is
 * busy too: it is waited out by that export finishing, not by their budget, and
 * it spends none of it. The screen says which in its own words, so the message
 * here is for the log and for a developer reading the response. It is a
 * diagnostic and does not address the person.
 */
export class DataPortabilityRateLimitedError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason: "export-rate-limited" | "export-busy";

  constructor(
    limit: DataPortabilityLimit,
    private readonly retryAfterSeconds: number,
  ) {
    super(DIAGNOSTICS[limit]);
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
  /**
   * The people with an export being prepared. A set rather than a count,
   * because a person holds at most one slot: its size is the slots taken.
   */
  private readonly preparing = new Set<string>();

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
    this.preparing.add(personId);
    try {
      return await prepare();
    } finally {
      this.preparing.delete(personId);
    }
  }

  private admit(personId: string, now: number): void {
    /*
     * The person's own budget first. A person who is refused here takes nothing
     * from the overall one, so somebody hammering the button cannot spend the
     * budget everybody else exports from.
     *
     * Then a slot - none while an export of theirs is being prepared, and one of
     * the instance's otherwise - before the overall budget: a request turned
     * away for want of a slot has prepared nothing, so it spends no token of the
     * instance's either.
     */
    this.refuseUnless(
      this.people.take(personId, EXPORTS_PER_PERSON_PER_MINUTE, now),
      "person",
    );
    const [decision, limit] = this.slotFor(personId, now);
    if (!decision.allowed) {
      /*
       * Nothing is prepared for a request turned away as busy, so it does not
       * count against the person either: the instance being busy is not
       * something they did, a second click while their first export is still
       * being prepared asks for the same file, and their retry after the wait
       * would otherwise find their own budget spent too.
       */
      this.people.refund(personId, EXPORTS_PER_PERSON_PER_MINUTE);
    }
    this.refuseUnless(decision, limit);
  }

  /** A slot for `personId`, spending the instance's token when there is one. */
  private slotFor(
    personId: string,
    now: number,
  ): [RateLimitDecision, DataPortabilityLimit] {
    if (this.preparing.has(personId)) {
      return [this.busy(now), "preparing"];
    }
    if (this.preparing.size >= MAX_CONCURRENT_EXPORTS) {
      return [this.busy(now), "overall"];
    }
    return [
      this.overall.take("overall", EXPORTS_PER_MINUTE_OVERALL, now),
      "overall",
    ];
  }

  /**
   * A refusal for want of a slot, told to wait for the instance's budget too
   * when that is the longer wait, so the retry does not meet a refusal of its
   * own. Looked at and not spent: the request prepared nothing.
   */
  private busy(now: number): RateLimitDecision {
    const budget = this.overall.peek(
      "overall",
      EXPORTS_PER_MINUTE_OVERALL,
      now,
    );
    return {
      allowed: false,
      retryAfterSeconds: budget.allowed
        ? BUSY_RETRY_AFTER_SECONDS
        : Math.max(BUSY_RETRY_AFTER_SECONDS, budget.retryAfterSeconds),
    };
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
