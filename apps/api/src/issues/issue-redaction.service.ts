import { Injectable, Logger } from "@nestjs/common";
import type { IssueRedactionTarget } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { MediaService } from "../media/media.service";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import { withheldAddressIndexes } from "../retention/withheld-addresses";
import {
  isAnyPersonWithheld,
  isPersonWithheld,
} from "../retention/withheld-persons";
import {
  concernedPersonIdsOf,
  concernsUnlockedPerson,
  lockPersonHolds,
  releaseConcernedSelectors,
} from "./issue-concerned-persons";
import { ISSUE_FREE_TEXT_STANDING_UNREDACTED } from "./issue-free-text";
import { requireHandledIssueForWrite } from "./issue-handlers";
import { lockIssueForHandling } from "./issue-lock";
import {
  detachErasedReporter,
  WORK_ORDER_TEXT_STANDING,
} from "./issue-retention";
import { eraseRecipientsLeft } from "./contractor.service";
import { IssueError } from "./issue.error";
import { revokeWorkOrderLinks } from "./work-order-link";

/**
 * What a handler redacts: the issue's description or location, or one of its
 * messages, notes, photographs, handler's files or work orders by its
 * identifier, a note or photograph a contractor sent through a work order's
 * link (ADR 0055), or the record of a person the issue concerns (ADR 0057).
 */
export type IssueRedaction =
  | { target: "description" | "location" }
  | {
      target:
        | "message"
        | "note"
        | "photo"
        | "attachment"
        | "workOrder"
        | "workOrderNote"
        | "workOrderFile"
        | "concernedPerson";
      id: string;
    };

/** Whether a legal hold stands on an issue, and since when. */
export interface IssueLegalHoldView {
  legalHoldAt: string | null;
}

/**
 * A handler's redaction of an issue's free text, and the legal hold on an
 * issue (ADR 0057, decision 33).
 *
 * ## Redaction
 *
 * A handler the issue lets in may at any time redact the description, the
 * location, an issue message, an internal note or the text of a work order,
 * and remove a photograph or a handler's file. A text is emptied and marked
 * with the date, so the issue and the conversation read as redacted rather
 * than as written blank; nothing keeps the earlier words, so a redaction is not
 * an edit with a history, and no replacement text is taken, because a field for
 * new words would be an edit. A file is removed from storage, not only from
 * the issue.
 *
 * A work order's text is erased as its clock erases it, and the work order
 * stays with whom it went to and when, which is the record of the disclosure.
 * Its contractor's link ends in the same transaction (ADR 0055): a link with no
 * text has nothing to show. A note or a photograph the contractor sent through
 * the link is redacted as a handler's note or file is. The record of a person
 * the issue concerns is deleted: it is part of the free-text layer, and a
 * record of who a case is about that a handler took back is not one to keep
 * marked as taken back.
 * One whose mail has not gone out yet is then not sent, and is recorded as not
 * sent (`WorkOrderMailerService`); one already on its way cannot be called
 * back. The redaction that leaves the issue with no text at all detaches a
 * reporter whose erasure request was carried out, as the clock does when it
 * erases the last text (`detachErasedReporter`).
 *
 * This is the board's own act that an art. 17 request naming an issue
 * promises (`DataSubjectRequest.issueId`): a person named in somebody else's
 * report has what the decision covers redacted here.
 *
 * Each act is one `ISSUE_REDACTED` entry against the issue, with the handler as
 * its actor, what was reached and the row's identifier, never the text and
 * never a file's name - the rule that an entry holds facts and never free text
 * (`audit-log.service.ts`), for a log no purge reaches.
 *
 * Refused while a legal hold stands on the issue: the hold is the record that
 * the association needs what it holds for a claim (art. 17(3)(e)), and a
 * redaction would destroy it as surely as the clock the hold stops. The hold is
 * released first, which is its own act in the log.
 *
 * Refused as well while the issue's reporter, or a person it concerns, is
 * under a legal hold or a restriction under art. 18, as the clock and the
 * erasure job refuse: the issue's text is what such a hold or restriction
 * keeps of that person, whichever of the three removes it. A signed-in reporter is read by their person, a
 * public-form reporter by the address on the report (`issue-text-purge.service.ts`).
 * The refusal is the one a hold on the issue gets, so it does not say whether
 * the reporter's is a hold or a restriction, nor why it was placed. A handler
 * who sees no hold on the issue can still tell that the reporter has one or the
 * other. Any refusal tells them that much, and it is what they need to know: a
 * hold keeps what they would remove, and a restriction is the marking of the
 * data so that whoever processes it sees that the processing is limited
 * (art. 4(3), recital 67). It is checked under the hold's locks, taken before
 * the issue's as the clock takes them.
 *
 * ## The legal hold
 *
 * A flag with the date it was placed (`legalHoldAt`). While it stands neither
 * the clock nor a granted erasure request removes the issue's free text. A
 * damage case and an inspection finding place one, and a handler the issue
 * lets in may place or release one. The log keeps each placing and release,
 * which is the history a person's hold keeps on its own row.
 */
@Injectable()
export class IssueRedactionService {
  private readonly logger = new Logger(IssueRedactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditLogService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /**
   * Redacts one text or removes one file, as the handler asks. A text already
   * redacted is answered as done, and nothing is written or logged.
   */
  async redact(
    handlerPersonId: string,
    issueId: string,
    redaction: IssueRedaction,
  ): Promise<void> {
    const changed =
      redaction.target === "photo" ||
      redaction.target === "attachment" ||
      redaction.target === "workOrderFile"
        ? await this.removeFile(handlerPersonId, issueId, redaction)
        : await this.redactText(handlerPersonId, issueId, redaction);
    // Only an act that changed something, as only that one is in the audit
    // log: a text already redacted is answered as done and says nothing.
    if (changed) {
      this.logger.log(`Issue ${issueId} had its ${redaction.target} redacted`);
    }
  }

  /**
   * Places or releases the legal hold on an issue, and answers whether one
   * stands. Asking for the state it is already in writes nothing.
   */
  async setLegalHold(
    handlerPersonId: string,
    issueId: string,
    held: boolean,
  ): Promise<IssueLegalHoldView> {
    let changed = false;
    const legalHoldAt = await this.prisma.$transaction(async (tx) => {
      changed = false;
      await lockIssueForHandling(tx, issueId);
      const issue = await requireHandledForWrite(tx, issueId, handlerPersonId);
      if ((issue.legalHoldAt !== null) === held) {
        return issue.legalHoldAt;
      }
      changed = true;
      const now = new Date();
      await tx.issue.update({
        where: { id: issueId },
        data: { legalHoldAt: held ? now : null },
      });
      // A work order whose text is already gone kept a copy of whom it went
      // to past its contractor's time on the list only for the hold's sake
      // (`retireContractor`), and loses it with the hold. One whose text
      // stands keeps it with the text.
      const recipientsErased = held
        ? 0
        : await eraseRecipientsLeft(tx, { issueId, body: null });
      await this.audit.record(
        {
          action: held
            ? "ISSUE_LEGAL_HOLD_PLACED"
            : "ISSUE_LEGAL_HOLD_RELEASED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // On a release, since when it stood: the span the log can answer
          // for, as a person's hold answers it on its own row.
          // And on a release, how many work orders lost a copy of whom they
          // went to with it, never whom.
          context: {
            ...(issue.legalHoldAt === null
              ? {}
              : { placedAt: issue.legalHoldAt.toISOString() }),
            ...(recipientsErased > 0
              ? { workOrderRecipients: recipientsErased }
              : {}),
          },
        },
        tx,
      );
      return held ? now : null;
    });

    if (changed) {
      this.logger.log(
        `Issue ${issueId} legal hold ${legalHoldAt === null ? "released" : "placed"}`,
      );
    }
    return { legalHoldAt: legalHoldAt?.toISOString() ?? null };
  }

  private async redactText(
    handlerPersonId: string,
    issueId: string,
    redaction: IssueRedaction,
  ): Promise<boolean> {
    // The reporter's legal hold key comes before the issue's own lock, the
    // order the person purge takes them in: the redaction of the last text may
    // detach the reporter, which a hold on them forbids.
    const reporterPersonId = await this.reporterOf(issueId);
    return this.prisma.$transaction(async (tx) => {
      const concerned = await this.lockForRedaction(
        tx,
        issueId,
        reporterPersonId,
      );
      await this.requireRedactable(tx, issueId, handlerPersonId, concerned);
      const now = new Date();

      let rowId: string | null = null;
      switch (redaction.target) {
        case "description": {
          // A description the purge already emptied has nothing left to
          // redact, and marking it would say that somebody had.
          const { count } = await tx.issue.updateMany({
            where: {
              id: issueId,
              descriptionRedactedAt: null,
              description: { not: "" },
            },
            data: { description: "", descriptionRedactedAt: now },
          });
          if (count === 0) {
            return false;
          }
          await dropAccessWeighings(tx, { issueId, part: "DESCRIPTION" });
          break;
        }
        case "location": {
          // A location nobody wrote, or the purge cleared, has nothing to
          // redact, and marking it would say that somebody had.
          const { count } = await tx.issue.updateMany({
            where: {
              id: issueId,
              locationRedactedAt: null,
              location: { not: null },
            },
            data: { location: null, locationRedactedAt: now },
          });
          if (count === 0) {
            return false;
          }
          await dropAccessWeighings(tx, { issueId, part: "LOCATION" });
          break;
        }
        case "message":
        case "note": {
          rowId = redaction.id;
          const where = { id: redaction.id, issueId };
          const row =
            redaction.target === "message"
              ? await tx.issueMessage.findFirst({
                  where,
                  select: { redactedAt: true },
                })
              : await tx.issueNote.findFirst({
                  where,
                  select: { redactedAt: true },
                });
          if (row === null) {
            throw targetNotFound();
          }
          if (row.redactedAt !== null) {
            return false;
          }
          const data = { body: "", redactedAt: now };
          if (redaction.target === "message") {
            await tx.issueMessage.update({ where: { id: redaction.id }, data });
            await dropAccessWeighings(tx, { messageId: redaction.id });
          } else {
            await tx.issueNote.update({ where: { id: redaction.id }, data });
            await dropAccessWeighings(tx, { noteId: redaction.id });
          }
          break;
        }
        case "workOrder": {
          rowId = redaction.id;
          const row = await tx.workOrder.findFirst({
            where: { id: redaction.id, issueId },
            select: { body: true },
          });
          if (row === null) {
            throw targetNotFound();
          }
          // A text the clock already erased has nothing to redact, and marking
          // it would say that a handler had.
          if (row.body === null) {
            return false;
          }
          await tx.workOrder.update({
            where: { id: redaction.id },
            data: { body: null, redactedAt: now },
          });
          await dropAccessWeighings(tx, { workOrderId: redaction.id });
          // A copy of whom it went to, kept past its contractor's time on the
          // list for this text's sake, goes with the text: no hold stands on
          // the issue, or the redaction would have been refused.
          await eraseRecipientsLeft(tx, { id: redaction.id });
          // Nothing is left for its link to show (control B5).
          await revokeWorkOrderLinks(tx, { id: redaction.id });
          // The last text gone, the selector kept for it goes too.
          await releaseConcernedSelectors(tx, issueId);
          break;
        }
        case "concernedPerson": {
          rowId = redaction.id;
          // Deleted rather than marked: nothing of it is text to blank.
          // Only a record that stands: the selector kept for a work order's
          // text is no handler's to name, or to take the hold off.
          const { count } = await tx.issueConcernedPerson.deleteMany({
            where: { id: redaction.id, issueId, recordRemovedAt: null },
          });
          if (count === 0) {
            throw targetNotFound();
          }
          break;
        }
        case "workOrderNote": {
          rowId = redaction.id;
          const row = await tx.workOrderNote.findFirst({
            where: { id: redaction.id, workOrder: { issueId } },
            select: { redactedAt: true },
          });
          if (row === null) {
            throw targetNotFound();
          }
          if (row.redactedAt !== null) {
            return false;
          }
          await tx.workOrderNote.update({
            where: { id: redaction.id },
            data: { body: "", redactedAt: now },
          });
          break;
        }
        default:
          throw targetNotFound();
      }

      const reporterDetached = await this.detachIfFinished(
        tx,
        issueId,
        reporterPersonId,
      );

      await this.record(
        tx,
        handlerPersonId,
        issueId,
        redaction.target,
        rowId,
        reporterDetached,
      );
      return true;
    });
  }

  /** The person an issue names as its reporter, read before any lock. */
  private async reporterOf(issueId: string): Promise<string | null> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { reporterPersonId: true },
    });
    return issue?.reporterPersonId ?? null;
  }

  /**
   * Detaches a reporter whose erasure was carried out from an issue that a
   * redaction has just left with no text at all (ADR 0057: the clock, the
   * issue erasure job or a handler's redaction of the last of it clears the
   * reporter column). Only the reporter whose key was taken before the issue's
   * lock: one the issue no longer names, or names since, is left to the person
   * purge. A legal hold or a restriction on that reporter needs no check here:
   * both callers ran {@link requireRedactable} earlier in this transaction,
   * under the reporter's hold key and the registry lock (`lockForRedaction`),
   * which a legal hold and the granting of a restriction take as well, and it
   * refused the redaction.
   */
  private async detachIfFinished(
    tx: Prisma.TransactionClient,
    issueId: string,
    lockedReporterId: string | null,
  ): Promise<boolean> {
    if (lockedReporterId === null) {
      return false;
    }
    const finished = await tx.issue.count({
      where: {
        id: issueId,
        reporterPersonId: lockedReporterId,
        NOT: [ISSUE_FREE_TEXT_STANDING_UNREDACTED, WORK_ORDER_TEXT_STANDING],
      },
    });
    if (finished === 0) {
      return false;
    }
    return detachErasedReporter(tx, issueId, lockedReporterId);
  }

  /**
   * Removes a photograph or a handler's file, from storage.
   *
   * Read and checked first, and checked again on the transaction that deletes
   * the row, under the locks a handling write takes: an issue the board took
   * to itself, or put under a hold, while the handler was clicking keeps the
   * file. The entry is written there too, so it stands only if the file went.
   */
  private async removeFile(
    handlerPersonId: string,
    issueId: string,
    redaction: Extract<IssueRedaction, { id: string }>,
  ): Promise<boolean> {
    const fileId = await this.fileOf(this.prisma, issueId, redaction);
    if (fileId === null) {
      throw targetNotFound();
    }
    refuseHeld(
      await requireHandledForWrite(this.prisma, issueId, handlerPersonId),
    );
    // Read before any lock, as `redactText` reads it: the file may be the last
    // free text standing, and removing it then detaches the reporter.
    const reporterPersonId = await this.reporterOf(issueId);

    // Whether the file was removed: false for one already gone and for one
    // the lock above found no longer the redaction's to take.
    return this.media.remove(fileId, handlerPersonId, "WEB", {
      // A name somebody gave a photograph of their home is free text too.
      recordFileName: false,
      // A storage failure fails the redaction, and the file stays to retry.
      bytesFirst: true,
      keep: async (tx) => {
        const concerned = await this.lockForRedaction(
          tx,
          issueId,
          reporterPersonId,
        );
        await this.requireRedactable(tx, issueId, handlerPersonId, concerned);
        return (await this.fileOf(tx, issueId, redaction)) !== fileId;
      },
      onRemoved: async (tx) => {
        // The last free text on the issue may be this file: the reporter of an
        // erased request is then detached, as a text redaction does.
        const reporterDetached = await this.detachIfFinished(
          tx,
          issueId,
          reporterPersonId,
        );
        await this.record(
          tx,
          handlerPersonId,
          issueId,
          redaction.target,
          redaction.id,
          reporterDetached,
        );
      },
    });
  }

  /**
   * The locks a redaction takes: the holds of the reporter and of every person
   * the issue concerns, then the issue's own, the order the clock and the
   * person purge take them in, so neither waits on the other the other way
   * round. The reporter's key is the one of the reporter read before any lock,
   * which is the one {@link detachIfFinished} may detach. A hold placed or a
   * restriction granted while the handler was clicking has to win, and the
   * placing takes the same keys. Answers whose keys of the people concerned
   * were taken.
   */
  private async lockForRedaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    reporterPersonId: string | null,
  ): Promise<string[]> {
    const concerned = await concernedPersonIdsOf(tx, issueId);
    await lockPersonHolds(tx, [reporterPersonId, ...concerned]);
    const reporter = await tx.issue.findUnique({
      where: { id: issueId },
      select: { reporterEmailIndex: true },
    });
    if (reporter?.reporterEmailIndex) {
      await lockLegalHoldRegistry(tx);
    }
    await lockIssueForHandling(tx, issueId);
    return concerned;
  }

  /**
   * Refuses a redaction of an issue this person does not handle, one under a
   * legal hold of its own, and one whose reporter or a person it concerns is
   * under a hold or a restriction. Read under the locks of
   * {@link lockForRedaction}, whose keys of the people concerned are
   * `concerned`: somebody recorded since they were read is refused as held,
   * since their hold cannot be read without their key, and the handler's
   * screen reads the issue again on that refusal.
   */
  private async requireRedactable(
    tx: Prisma.TransactionClient,
    issueId: string,
    handlerPersonId: string,
    concerned: readonly string[],
  ): Promise<void> {
    refuseHeld(await requireHandledForWrite(tx, issueId, handlerPersonId));
    if (
      (await concernsUnlockedPerson(tx, issueId, concerned)) ||
      (await isAnyPersonWithheld(tx, concerned))
    ) {
      throw heldError();
    }
    const reporter = await tx.issue.findUnique({
      where: { id: issueId },
      select: { reporterPersonId: true, reporterEmailIndex: true },
    });
    if (reporter === null) {
      return;
    }
    if (
      reporter.reporterPersonId !== null &&
      (await isPersonWithheld(tx, reporter.reporterPersonId))
    ) {
      throw heldError();
    }
    if (
      reporter.reporterEmailIndex !== null &&
      (
        await withheldAddressIndexes(tx, this.encryption, "issue.reporterEmail")
      ).has(reporter.reporterEmailIndex)
    ) {
      throw heldError();
    }
  }

  /** The file a photograph or a handler's file on this issue points at. */
  private async fileOf(
    client: PrismaService | Prisma.TransactionClient,
    issueId: string,
    redaction: Extract<IssueRedaction, { id: string }>,
  ): Promise<string | null> {
    const where = { id: redaction.id, issueId };
    const row =
      redaction.target === "photo"
        ? await client.issuePhoto.findFirst({ where, select: { fileId: true } })
        : redaction.target === "attachment"
          ? await client.issueAttachment.findFirst({
              where,
              select: { fileId: true },
            })
          : redaction.target === "workOrderFile"
            ? await client.workOrderFile.findFirst({
                where: { id: redaction.id, workOrder: { issueId } },
                select: { fileId: true },
              })
            : null;
    return row?.fileId ?? null;
  }

  private async record(
    tx: Prisma.TransactionClient,
    handlerPersonId: string,
    issueId: string,
    target: IssueRedactionTarget,
    rowId: string | null,
    reporterDetached = false,
  ): Promise<void> {
    await this.audit.record(
      {
        action: "ISSUE_REDACTED",
        channel: "WEB",
        actorPersonId: handlerPersonId,
        targetKind: "issue",
        targetId: issueId,
        // What was reached and which row, never a word of it nor a file's
        // name. No target person: on a reporter's own access report, the
        // entry would name the handler to them.
        context: {
          target,
          ...(rowId === null ? {} : { id: rowId }),
          ...(reporterDetached ? { reporterDetached: true } : {}),
        },
      },
      tx,
    );
  }
}

/**
 * An issue this person may write to, or the refusal that answers one that does
 * not exist: the writer's `issues:handle` role is asked with their scope, at
 * the instant read here (`requireHandledIssueForWrite`). Read under a
 * redaction's locks, and by `removeFile` before them as well.
 */
async function requireHandledForWrite(
  db: PrismaService | Prisma.TransactionClient,
  issueId: string,
  handlerPersonId: string,
): Promise<{ legalHoldAt: Date | null }> {
  return requireHandledIssueForWrite(
    db,
    issueId,
    handlerPersonId,
    { legalHoldAt: true },
    new Date(),
  );
}

function refuseHeld(issue: { legalHoldAt: Date | null }): void {
  if (issue.legalHoldAt !== null) {
    throw heldError();
  }
}

/**
 * The refusal for a hold on the issue and for a hold or a restriction on its
 * reporter or on a person it concerns, worded the same for all of them so it
 * does not say which stands.
 */
function heldError(): IssueError {
  return new IssueError(
    "A legal hold stands on this issue, or a legal hold or a restriction on its reporter or on a person it concerns; nothing can be redacted until it ends.",
    "legal-hold",
  );
}

function targetNotFound(): IssueError {
  return new IssueError(
    "Nothing on this issue to redact by that identifier.",
    "redaction-target-not-found",
  );
}

/**
 * The board's weighing of a text for an access report goes with a redaction
 * of the text (ADR 0057): there is nothing left of it to give, and a copy the
 * board gave in part holds some of its words.
 */
async function dropAccessWeighings(
  tx: Prisma.TransactionClient,
  where: Prisma.IssueAccessWeighingWhereInput,
): Promise<void> {
  await tx.issueAccessWeighing.deleteMany({ where });
}
