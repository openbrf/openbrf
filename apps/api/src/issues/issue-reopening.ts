import type { AuditLogService } from "../audit/audit-log.service";
import type { Prisma } from "../generated/prisma/client";
import type { IssueMailer } from "./issue-mailer.service";

/** Who reopens an issue by replying: a signed-in reporter or a private link. */
export type ReopeningReply =
  | { channel: "WEB"; reporterPersonId: string }
  | { channel: "LINK"; linkId: string };

/**
 * Reopens a closed issue on its reporter's reply (ADR 0054): onto its type's
 * default in-progress status, with its outcome, closing date and waiting
 * reason cleared, as a handler's move out of DONE clears them. Shared by the
 * reply a signed-in reporter writes and the one written through a private
 * link (ADR 0055), so the two cannot reopen differently.
 *
 * Which status a reopened issue enters is open in ADR 0054 (question 2).
 * The in-progress one is taken here: the reply is to whoever has the issue,
 * who stays its assignee, and putting it back among the new would read as a
 * report nobody has looked at.
 *
 * Recorded as the status change it is, with `byReporter` in its facts so the
 * timeline says the reporter reopened it without naming them. A signed-in
 * reporter is its actor, so their own access report answers for it; a link has
 * no person behind it, so the entry is on the link's channel and names the
 * link, as its messages do.
 *
 * The caller holds the locks a status move takes (`lockIssueForHandling`) and
 * has decided that the reply may reopen the issue (`replyReopensIssue`). The
 * assignee, or every handler of an issue nobody has, is mailed that it is open
 * again, never what the reply says. The reply's own message is mailed after
 * this one.
 */
export async function reopenIssueByReply(
  deps: { audit: AuditLogService; mailer: IssueMailer },
  tx: Prisma.TransactionClient,
  issue: { id: string; typeId: string; status: { id: string } },
  reply: ReopeningReply,
): Promise<void> {
  const target = await tx.issueStatus.findFirst({
    where: { typeId: issue.typeId, meaning: "IN_PROGRESS", isDefault: true },
    select: { id: true },
  });
  if (target === null) {
    // Every type keeps a default status of each meaning (ADR 0054).
    throw new Error(`Type ${issue.typeId} has no default IN_PROGRESS status.`);
  }
  await tx.issue.update({
    where: { id: issue.id },
    data: {
      statusId: target.id,
      outcome: null,
      closedAt: null,
      waitingReason: null,
    },
  });
  await deps.audit.record(
    {
      action: "ISSUE_STATUS_CHANGED",
      channel: reply.channel,
      actorPersonId: reply.channel === "WEB" ? reply.reporterPersonId : null,
      targetKind: "issue",
      targetId: issue.id,
      context: {
        from: "DONE",
        to: "IN_PROGRESS",
        fromStatusId: issue.status.id,
        toStatusId: target.id,
        byReporter: true,
        ...(reply.channel === "LINK" ? { linkId: reply.linkId } : {}),
      },
    },
    tx,
  );
  await deps.mailer.reopenedInTransaction(
    tx,
    issue.id,
    reply.channel === "WEB" ? reply.reporterPersonId : null,
  );
}
