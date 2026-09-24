import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * What a granted erasure request still owes one person, domain by domain.
 *
 * A granted request (GDPR art. 17) is carried out by six jobs rather than one.
 * Five of them erase a person's rows in the domain they belong to - bookings,
 * chat messages, event sign-ups, motions and news comments - and the sixth
 * erases the contact details and the account and then marks the request
 * executed and closed. The sixth only ever finds the request while it is open,
 * and so does every other job, so closing it is the act that ends the erasure
 * for good: rows still standing afterwards fall back to their ordinary
 * retention window instead of the date the board granted.
 *
 * Running the five first is therefore necessary and not sufficient.
 * `erasure-request-order.spec.ts` keeps them in front of the closing job, and
 * that settles how quickly a granted erasure finishes. It cannot settle whether
 * it finished: a run that caught a failure for one person and carried on, a run
 * that stopped at its per-run bound, and a night the instance was down all
 * leave the order intact and the rows in place.
 *
 * So the closing job asks instead. Each domain states what a granted request
 * erases there as a where-input, the domain's own job deletes exactly that, and
 * the closing job counts exactly that before it writes `executedAt`. One
 * expression, used by the act and by the evidence, so the two cannot drift into
 * disagreeing about what "nothing left" means.
 *
 * ## What is owed and what is kept
 *
 * A domain can hold rows for a person that a granted erasure does not reach. A
 * motion that is still open is the one case in the product: it is a matter the
 * association is still dealing with and the member who put it has a right to
 * have it dealt with, so the motion purge leaves it standing however the board
 * decided the erasure. Those rows are counted apart, because the record has to
 * say which of two very different things happened - a job that has not got
 * through this person yet, or a row that is deliberately staying. Neither
 * closes the request, and a request left open says which it was.
 *
 * ## Adding a domain
 *
 * A job that erases a person's rows on a granted request belongs in
 * {@link ERASURE_DOMAINS}. `erasure-domains.spec.ts` finds every such job by
 * walking the source for the ones that read granted requests on a schedule, and
 * fails for one that is not registered here - which is the same walk that keeps
 * them in order, so a domain added later is held to both rules without anybody
 * remembering either.
 *
 * ADR 0016 is the decision and the whole of the reasoning.
 */

/**
 * A client the counts can be taken on.
 *
 * Either the connection or a transaction, the way the audit log takes one: the
 * closing job counts inside the transaction that erases and closes, so the
 * answer is the one that is true there, and a run reporting on requests it left
 * open counts outside any.
 */
export type ErasureDbClient = PrismaService | Prisma.TransactionClient;

/**
 * Who a where-input below is about: one person, or the people a scan is asking
 * after at once.
 *
 * The same expression serves both, which is the point of writing it once. The
 * job's scan asks it of everybody a granted request names, the job's delete
 * asks it of the one person it has in a transaction, and the closing job counts
 * what it matches for that person before it calls the erasure done.
 */
export type ErasurePersonFilter = string | { in: string[] };

/** The bookings a granted erasure request erases. */
export function bookingsErasedOnRequest(
  personId: ErasurePersonFilter,
): Prisma.BookingWhereInput {
  /*
   * Every one of them, with no date on it. A granted request drops the bound
   * rather than moving it to now: a booking of the laundry for next month is
   * the ordinary content of this table, and leaving it would leave the person
   * on a list the caretaker reads.
   */
  return { bookedByPersonId: personId };
}

/** The chat messages a granted erasure request erases. */
export function chatMessagesErasedOnRequest(
  personId: ErasurePersonFilter,
  now: Date,
): Prisma.ChatMessageWhereInput {
  // Everything written up to the moment being judged. A message cannot be
  // written after it, so this is every message of theirs - said as a date
  // because the job judges a clock it is handed rather than the wall clock.
  return { authorPersonId: personId, createdAt: { lte: now } };
}

/** The event sign-ups a granted erasure request erases. */
export function eventSignupsErasedOnRequest(
  personId: ErasurePersonFilter,
): Prisma.EventSignupWhereInput {
  // Every one, for the reason the bookings give: a sign-up to a date that has
  // not come yet is the ordinary content of this table.
  return { personId };
}

/** The motions a granted erasure request erases. */
export function motionsErasedOnRequest(
  personId: ErasurePersonFilter,
  now: Date,
): Prisma.MotionWhereInput {
  // Closed ones. An open motion is a matter the association is still dealing
  // with, and EFL 6 kap. 15 § gives the member who put it the right to have it
  // treated at the meeting; erasing it would take that from them and from every
  // other member who is entitled to see the item on the notice.
  return { submittedByPersonId: personId, closedAt: { not: null, lte: now } };
}

/**
 * The motions a granted erasure request leaves standing, and the reason.
 *
 * Counted rather than ignored. The request stays open while one of these
 * stands, because an erasure that has not reached everything is not one the
 * record may call executed - and the board reading the open request is told it
 * is waiting on a matter it can close itself rather than on a job that failed.
 */
export function motionsKeptFromErasure(
  personId: ErasurePersonFilter,
  now: Date,
): Prisma.MotionWhereInput {
  return {
    submittedByPersonId: personId,
    OR: [{ closedAt: null }, { closedAt: { gt: now } }],
  };
}

/** The news comments a granted erasure request erases. */
export function newsCommentsErasedOnRequest(
  personId: ErasurePersonFilter,
  now: Date,
): Prisma.NewsCommentWhereInput {
  return { authorPersonId: personId, createdAt: { lte: now } };
}

/** One domain a granted erasure request reaches, and how to ask it. */
export interface ErasureDomain {
  /**
   * The source file of the job that erases this domain, relative to `src` and
   * with forward slashes.
   *
   * The handle the guard joins on: it walks the source for the jobs that read
   * granted requests on a schedule and matches them against these paths, in
   * both directions, so neither a job nobody registered nor an entry whose job
   * is gone survives a test run.
   */
  readonly job: string;
  /** What a log line and a summary call the domain. */
  readonly name: string;
  /** Rows the domain's own job has not erased yet. */
  countOwed(
    client: ErasureDbClient,
    personId: string,
    now: Date,
  ): Promise<number>;
  /** Rows the domain keeps whatever the board granted, and why. */
  readonly kept?: {
    readonly because: string;
    count(
      client: ErasureDbClient,
      personId: string,
      now: Date,
    ): Promise<number>;
  };
}

/**
 * Every domain a granted erasure request reaches, and nothing else.
 *
 * Kept in one order so two runs report the same list in the same order, and a
 * summary read against yesterday's says what changed.
 */
export const ERASURE_DOMAINS: readonly ErasureDomain[] = [
  {
    job: "bookings/booking-purge.service.ts",
    name: "bookings",
    countOwed: async (client, personId) =>
      client.booking.count({ where: bookingsErasedOnRequest(personId) }),
  },
  {
    job: "chat/chat-purge.service.ts",
    name: "chat messages",
    countOwed: async (client, personId, now) =>
      client.chatMessage.count({
        where: chatMessagesErasedOnRequest(personId, now),
      }),
  },
  {
    job: "events/event-signup-purge.service.ts",
    name: "event sign-ups",
    countOwed: async (client, personId) =>
      client.eventSignup.count({
        where: eventSignupsErasedOnRequest(personId),
      }),
  },
  {
    job: "motions/motion-purge.service.ts",
    name: "motions",
    countOwed: async (client, personId, now) =>
      client.motion.count({ where: motionsErasedOnRequest(personId, now) }),
    kept: {
      because:
        "an open motion is a matter the association is still dealing with",
      count: async (client, personId, now) =>
        client.motion.count({ where: motionsKeptFromErasure(personId, now) }),
    },
  },
  {
    job: "news/news-comment-purge.service.ts",
    name: "news comments",
    countOwed: async (client, personId, now) =>
      client.newsComment.count({
        where: newsCommentsErasedOnRequest(personId, now),
      }),
  },
];

/** What one domain still holds for one person. */
export interface ErasureRemainder {
  /** The domain's name, as {@link ERASURE_DOMAINS} spells it. */
  readonly domain: string;
  /** Rows the domain's job owes this erasure and has not erased. */
  readonly owed: number;
  /** Rows the domain keeps whatever the board granted. */
  readonly kept: number;
  /** Why the kept rows stay. Absent where the domain keeps none. */
  readonly keptBecause?: string;
}

/**
 * What every erasure-aware domain still holds for one person.
 *
 * Answers only the domains that hold something, in registry order, so an empty
 * array is the evidence the closing job needs and a full one is the reason it
 * has to leave the request open.
 *
 * Counts rather than rows: this answer is written into a log line and into a
 * run summary, and what somebody wrote in a room or proposed to a meeting is
 * not something either may carry - ADR 0007.
 */
export async function erasureRemainder(
  client: ErasureDbClient,
  personId: string,
  now: Date,
): Promise<ErasureRemainder[]> {
  const remainders: ErasureRemainder[] = [];
  for (const domain of ERASURE_DOMAINS) {
    const owed = await domain.countOwed(client, personId, now);
    const kept =
      domain.kept === undefined
        ? 0
        : await domain.kept.count(client, personId, now);
    if (owed === 0 && kept === 0) {
      continue;
    }
    remainders.push({
      domain: domain.name,
      owed,
      kept,
      // Only where there are kept rows to explain. A reason attached to a
      // count of none would read as a domain holding something back when what
      // it is holding is nothing.
      ...(kept > 0 && domain.kept !== undefined
        ? { keptBecause: domain.kept.because }
        : {}),
    });
  }
  return remainders;
}

/**
 * Says in one line what a domain is still holding.
 *
 * Names and counts and nothing else, for the reason {@link erasureRemainder}
 * counts rather than reads.
 */
export function describeRemainder(remainder: ErasureRemainder): string {
  const parts: string[] = [];
  if (remainder.owed > 0) {
    parts.push(`${String(remainder.owed)} not erased yet`);
  }
  if (remainder.kept > 0) {
    parts.push(
      remainder.keptBecause === undefined
        ? `${String(remainder.kept)} kept`
        : `${String(remainder.kept)} kept because ${remainder.keptBecause}`,
    );
  }
  return `${remainder.domain}: ${parts.join(", ")}`;
}

/**
 * How many people a run may still take off its own retention window, once the
 * people a granted erasure request names have been taken.
 *
 * Every one of these jobs bounds a run at five hundred people, so that the
 * first run on an instance with years of data behind it cannot erase all of it
 * in one transaction-per-person loop. Nothing is lost by stopping, as long
 * as what was left is selected again: eligibility is computed from the data
 * rather than marked on it, so the next night's run finds the rest.
 *
 * That argument holds for the retention window and fails for a granted erasure
 * request. The request is a flag, the closing job clears it the same night, and
 * a person pushed off the end of a bounded run would be one the flag no longer
 * names. So the people a request names are taken first, and what is left of the
 * bound is what the window may take - which is what this answers, and never
 * less than nothing. So a run is five hundred people, or as many as there are
 * open granted requests where that is more. What the bound still does is stop a
 * run erasing years of retention-window work in one loop; what it no longer
 * does is cut somebody the board granted an erasure to.
 *
 * The closing job's verification is what makes the tail safe rather than this
 * arithmetic: a person it did not reach keeps their request open. This is what
 * keeps the erasure to one night instead of as many nights as it takes.
 */
export function remainingRunBound(taken: number, bound: number): number {
  return Math.max(0, bound - taken);
}
