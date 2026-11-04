import { dateColumnOf, type LocalDay, localDayOf } from "@openbrf/shared";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { AuditChannel } from "../generated/prisma/enums";
import { residencyHeldOn } from "../registers/held-on";
import { lockHouseholdProtection } from "./issue-lock";
import { issuesReportedByProtectedPersons } from "./issue-reporter-protection";

/**
 * When a contractor's link opens its work order, asked in one place (ADR 0055).
 *
 * A link opens its work order while all of these hold, read together in one
 * query on the database's clock, on every request, with nothing cached. The
 * clock is `clock_timestamp()`, not `now()`, so a write that waited for a lock
 * judges the link at the moment it got it:
 *
 * - **the switch is on** (`OPENBRF_CONTRACTOR_LINKS_ENABLED`, decision 25). A
 *   parameter of the same statement rather than a check before it, so a link
 *   issued while the switch was on answers exactly as an unknown token does
 *   once it is off, from the same query.
 * - **it is not revoked.** A handler withdrew it, issued another in its place,
 *   or something it opens stopped being one a contractor may see.
 * - **it has not expired:** 30 days after it was issued, never moved
 *   (`WORK_ORDER_LINK_DAYS`).
 * - **the work order is not answered for good.** A decline or done ends the
 *   link (decision 24); an acceptance does not.
 * - **the work order still has its text and its recipient.** A text redacted
 *   or purged leaves nothing to show, and a contractor removed from the list
 *   is erased from their work orders (ADR 0055).
 * - **the issue is not ring-fenced** (decision 32): nothing about such an
 *   issue reaches a contractor, by a link issued before the type was
 *   ring-fenced either.
 * - **the issue is not closed.** A closed issue has no work left to answer.
 *   Closing it revokes its links as well, so reopening it brings none back.
 *
 * And one more, asked beside the query in the same transaction because it
 * reads the register: **nobody with protected personal data reported the
 * issue or lives in its apartment** (`showsProtectedHousehold`). The threat
 * review asked that such a work order fail closed until the owner answers
 * ADR 0055's question 4, since the photographs the board chose may show the
 * home.
 */

/** Days a contractor's link opens its work order, counted from its issue. */
export const WORK_ORDER_LINK_DAYS = 30;

/** A link that opens its work order now: the link and what it opens. */
export interface LiveWorkOrderLink {
  linkId: string;
  workOrderId: string;
  issueId: string;
  typeId: string;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Everything a link has to be to open its work order, as one condition. */
function live(enabled: boolean): Prisma.Sql {
  return Prisma.sql`
    ${enabled}::boolean
    AND l."revokedAt" IS NULL
    AND l."expiresAt" > clock_timestamp()
    AND (w."answer" IS NULL OR w."answer" = 'ACCEPTED')
    AND w."body" IS NOT NULL
    AND w."recipientName" IS NOT NULL
    AND t."ringFenced" = false
    AND s."meaning" <> 'DONE'`;
}

const FROM = Prisma.sql`
  FROM "work_order_link" l
  JOIN "work_order" w ON w."id" = l."workOrderId"
  JOIN "issue" i ON i."id" = w."issueId"
  JOIN "issue_type" t ON t."id" = i."typeId"
  JOIN "issue_status" s ON s."id" = i."statusId"`;

const COLUMNS = Prisma.sql`
  l."id" AS "linkId", l."workOrderId" AS "workOrderId",
  w."issueId" AS "issueId", i."typeId" AS "typeId"`;

/**
 * The live link a token's digest names, or null.
 *
 * One query by the digest, with every condition of liveness in it, so an
 * unknown, an expired, a revoked, an answered and a switched-off token all
 * come back as the same empty answer from the same statement: no early return
 * skips the query for one of them, and nothing is compared in a loop.
 */
export async function liveWorkOrderLinkByDigest(
  db: Db,
  digest: string,
  enabled: boolean,
): Promise<LiveWorkOrderLink | null> {
  const rows = await db.$queryRaw<LiveWorkOrderLink[]>`
    SELECT ${COLUMNS} ${FROM}
    WHERE l."tokenDigest" = ${digest} AND ${live(enabled)}`;
  return rows[0] ?? null;
}

/**
 * The links of an issue's work orders that the lookup would open, with when
 * each ends. Not the protected household, which is asked of the issue once
 * (`showsProtectedHousehold`): the handlers' record asks both, as `resolve`
 * does on every request.
 */
export async function liveWorkOrderLinksOfIssue(
  db: Db,
  issueId: string,
  enabled: boolean,
): Promise<Map<string, Date>> {
  const rows = await db.$queryRaw<{ workOrderId: string; expiresAt: Date }[]>`
    SELECT l."workOrderId" AS "workOrderId", l."expiresAt" AS "expiresAt" ${FROM}
    WHERE w."issueId" = ${issueId} AND ${live(enabled)}`;
  return new Map(rows.map((row) => [row.workOrderId, row.expiresAt]));
}

/**
 * Revokes every link not yet revoked on the work orders a condition names, in
 * the caller's transaction, and answers how many.
 *
 * What makes a work order one a contractor may no longer see revokes its links
 * in the same transaction (control B5 of the threat review): a redaction or the
 * purge of its text, its type ring-fenced, its contractor removed, its issue
 * closed. The lookup would refuse such a link anyway; the revocation makes the
 * end a fact on the row, so a later change back (a ring-fence lifted, the
 * issue reopened) does not bring the link back to life.
 */
export async function revokeWorkOrderLinks(
  tx: Prisma.TransactionClient,
  workOrders: Prisma.WorkOrderWhereInput,
): Promise<number> {
  const { count } = await tx.workOrderLink.updateMany({
    where: { revokedAt: null, workOrder: workOrders },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * Whether a person with protected personal data reported the issue, or lives
 * today in the apartment it is about.
 *
 * Asked when a link is issued and on every request through one, so a
 * protection recorded after the link was issued ends it from the next request.
 */
export async function showsProtectedHousehold(
  db: Db,
  issueId: string,
  today: LocalDay,
): Promise<boolean> {
  if ((await issuesReportedByProtectedPersons(db, [issueId])).has(issueId)) {
    return true;
  }
  const issue = await db.issue.findUnique({
    where: { id: issueId },
    select: { apartmentId: true },
  });
  if (issue?.apartmentId == null) {
    return false;
  }
  const protectedResident = await db.residency.findFirst({
    where: {
      apartmentId: issue.apartmentId,
      ...residencyHeldOn(today),
      person: { protectedPersonalData: true },
    },
    select: { id: true },
  });
  return protectedResident !== null;
}

/**
 * Ends the links of the issues a person with protected personal data is
 * concerned in, as a fact on each row: the issues they reported, and the
 * issues about an apartment they live in or are to live in.
 *
 * `showsProtectedHousehold` refuses such a link on every request, but a refusal
 * that lifts with the protection would let the same address open the work order
 * again, and the glossary has such a link end, not wait. So the writes that
 * make a household protected end the links in their own transaction: a person
 * being marked as protected, and a protected person's residency being
 * recorded. A residency is counted from the day it is recorded, not the day it
 * begins, so a household moving in ahead of its date is covered before the
 * date arrives, which no write marks. Clearing the protection restores
 * nothing. The reads still write nothing (ADR 0055).
 *
 * Called after the write that protects (the person's flag, or the residency),
 * by a caller that took the household protection's lock before that write
 * (`lockHouseholdProtection` gives the order); it takes the lock again here
 * before it reads anything, which costs nothing then. It is the lock issuing a
 * link takes too: a link issued at the same moment is either found here and
 * ended, or finds this protection and is refused. It also puts a residency
 * recorded and a person marked protected at the same moment one after the
 * other, so the second reads what the first wrote.
 *
 * Each ended link is audited on the channel of the write that ended it, never
 * with who the person is: the entry names the issue and the link only.
 * Answers how many links it ended.
 */
export async function revokeLinksOfProtectedHousehold(
  tx: Prisma.TransactionClient,
  audit: AuditLogService,
  input: {
    personId: string;
    /**
     * Given when a residency is recorded: this apartment's issues and the
     * person's own, and only if the person is protected. Left out when the
     * person is marked protected: every apartment they hold.
     */
    apartmentId?: string;
    actorPersonId: string | null;
    channel: AuditChannel;
  },
): Promise<number> {
  await lockHouseholdProtection(tx);
  if (input.apartmentId !== undefined) {
    // A residency recorded for a person who is not protected ends nothing.
    const person = await tx.person.findUnique({
      where: { id: input.personId },
      select: { protectedPersonalData: true },
    });
    if (person?.protectedPersonalData !== true) {
      return 0;
    }
  }
  const apartmentIds =
    input.apartmentId !== undefined
      ? [input.apartmentId]
      : (
          await tx.residency.findMany({
            where: {
              personId: input.personId,
              OR: [
                { movedOutOn: null },
                { movedOutOn: { gt: dateColumnOf(localDayOf(new Date())) } },
              ],
            },
            select: { apartmentId: true },
          })
        ).map((residency) => residency.apartmentId);

  const links = await tx.workOrderLink.findMany({
    where: {
      revokedAt: null,
      workOrder: {
        issue: {
          OR: [
            { reporterPersonId: input.personId },
            { apartmentId: { in: apartmentIds } },
          ],
        },
      },
    },
    orderBy: { id: "asc" },
    select: { id: true, workOrder: { select: { id: true, issueId: true } } },
  });
  let ended = 0;
  for (const link of links) {
    // One update per link, so each entry stands for a row this write ended: a
    // link a handler withdrew in between wrote its own entry.
    const { count } = await tx.workOrderLink.updateMany({
      where: { id: link.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      continue;
    }
    ended += 1;
    await audit.record(
      {
        action: "ISSUE_WORK_ORDER_LINK_REVOKED",
        channel: input.channel,
        actorPersonId: input.actorPersonId,
        targetKind: "issue",
        targetId: link.workOrder.issueId,
        context: { workOrderId: link.workOrder.id, linkId: link.id },
      },
      tx,
    );
  }
  return ended;
}

/**
 * The link's state as the handlers read it: `live` opens the work order (now,
 * or once the instance's switch is on again while it is off), `ended` was
 * issued and no longer does, `none` was never issued.
 */
export type WorkOrderLinkState = "live" | "ended" | "none";
