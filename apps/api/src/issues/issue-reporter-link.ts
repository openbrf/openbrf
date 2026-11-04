import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";

/**
 * When a reporter's private link opens anything, asked in one place (ADR 0055).
 *
 * A link opens its issue while all of these hold, read together in one query on
 * the database's clock, on every request, with nothing cached. The clock is
 * `clock_timestamp()`, not `now()`: `now()` is the start of the transaction,
 * and a write that waited for the issue's lock must judge the link at the
 * moment it got it:
 *
 * - **it was mailed.** A link whose mail never reached the mail server is
 *   held by nobody.
 * - **it is not revoked.** A handler withdrew it, and that is final.
 * - **it has not expired.** `expiresAt` is 365 days after the latest issue
 *   message or the day the link was issued, whichever is later
 *   (`REPORTER_LINK_DAYS_AFTER_LAST_MESSAGE`), so an issue that stays open and
 *   quiet does not keep a bearer secret alive in a mailbox for ever. Closing
 *   does not extend it: the two ends are caps, and the first one reached ends
 *   the link (ADR 0055).
 * - **its issue was not closed more than 30 days ago**
 *   (`REPORTER_LINK_DAYS_AFTER_CLOSING`). A reply within those 30 days is what
 *   the reopening rule reads (ADR 0054); after them the link has nothing left
 *   to do, and a mailbox holding it is only a risk.
 * - **the issue still has a reporter without an account and an address.** The
 *   purge clears the contact details of a closed report on its clock (ADR
 *   0057), and a link to a report whose reporter is no longer known is a link
 *   to nobody's issue.
 *
 * The threat review asked for an expiry no later than 30 days after closing
 * and an absolute cap for an issue that stays open, because "until the contact
 * details are purged" can be years. Both are constants in code.
 *
 * Not the board-only rule, and not a ring-fence: those decide which handlers
 * read an issue, and the link is the reporter's own way to the conversation
 * they are part of, which they read whatever the board decides about its
 * handlers (ADR 0055).
 */

/** Days after an issue closes that its reporter's link still opens it. */
export const REPORTER_LINK_DAYS_AFTER_CLOSING = 30;

/**
 * Days after the latest issue message, or after the link was issued, that the
 * link still opens an open issue.
 */
export const REPORTER_LINK_DAYS_AFTER_LAST_MESSAGE = 365;

/** A link that opens its issue now: the link, and the issue it opens. */
export interface LiveReporterLink {
  linkId: string;
  issueId: string;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Everything a link has to be to open its issue, as one SQL condition. */
const LIVE = Prisma.sql`
  l."mailedAt" IS NOT NULL
  AND l."revokedAt" IS NULL
  AND l."expiresAt" > clock_timestamp()
  AND i."reporterPersonId" IS NULL
  AND i."reporterEmailCipher" IS NOT NULL
  AND (
    i."closedAt" IS NULL
    OR i."closedAt" > clock_timestamp() - make_interval(days => ${REPORTER_LINK_DAYS_AFTER_CLOSING})
  )`;

/**
 * The live link a token's digest names, or null.
 *
 * One query by the digest, with every condition of liveness in it, so an
 * unknown, an expired and a revoked token all come back as the same empty
 * answer from the same statement: there is no early return that skips the
 * query for one of them, and nothing is compared in a loop.
 */
export async function liveReporterLinkByDigest(
  db: Db,
  digest: string,
): Promise<LiveReporterLink | null> {
  const rows = await db.$queryRaw<LiveReporterLink[]>`
    SELECT l."id" AS "linkId", l."issueId" AS "issueId"
    FROM "issue_reporter_link" l
    JOIN "issue" i ON i."id" = l."issueId"
    WHERE l."tokenDigest" = ${digest} AND ${LIVE}`;
  return rows[0] ?? null;
}

/** The live link of one issue, or null: how a handler's write asks. */
export async function liveReporterLinkOfIssue(
  db: Db,
  issueId: string,
): Promise<LiveReporterLink | null> {
  const rows = await db.$queryRaw<LiveReporterLink[]>`
    SELECT l."id" AS "linkId", l."issueId" AS "issueId"
    FROM "issue_reporter_link" l
    JOIN "issue" i ON i."id" = l."issueId"
    WHERE l."issueId" = ${issueId} AND ${LIVE}`;
  return rows[0] ?? null;
}

/**
 * Pushes a link's end out to a year after now, on a new issue message.
 *
 * Never pulls it in, and never touches a revoked link. Called in the
 * transaction that writes the message.
 */
export async function extendReporterLink(
  tx: Prisma.TransactionClient,
  linkId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "issue_reporter_link"
    SET "expiresAt" = GREATEST(
      "expiresAt",
      clock_timestamp() + make_interval(days => ${REPORTER_LINK_DAYS_AFTER_LAST_MESSAGE})
    )
    WHERE "id" = ${linkId} AND "revokedAt" IS NULL`;
}

/**
 * Where a link stands, as the handlers are told: whether a handler's message
 * reaches the reporter, and whether there is a link to withdraw.
 *
 * `live` opens the issue now; `ended` was mailed and no longer does (revoked,
 * expired, or its issue closed long enough ago); `pending` has its row but the
 * mail server has not yet taken the mail (the send is queued or being retried),
 * so it is not a permanent failure; `none` has no row, because the reporter
 * left no address or the mail was refused and the row removed.
 * Read for the queue's screen only. Every write asks the database again.
 */
export type ReporterLinkState = "live" | "ended" | "pending" | "none";

/** The columns `reporterLinkState` reads. */
export const REPORTER_LINK_STATE_SELECT = {
  mailedAt: true,
  revokedAt: true,
  expiresAt: true,
} as const;

export function reporterLinkState(
  link: {
    mailedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  } | null,
  issue: { closedAt: Date | null; hasContact: boolean },
  now: Date,
): ReporterLinkState {
  if (link === null) {
    return "none";
  }
  if (link.mailedAt === null) {
    return "pending";
  }
  const closedLongAgo =
    issue.closedAt !== null &&
    now.getTime() - issue.closedAt.getTime() >=
      REPORTER_LINK_DAYS_AFTER_CLOSING * DAY_MS;
  return link.revokedAt === null &&
    link.expiresAt.getTime() > now.getTime() &&
    !closedLongAgo &&
    issue.hasContact
    ? "live"
    : "ended";
}

const DAY_MS = 24 * 60 * 60 * 1000;
