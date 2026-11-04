import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { MediaService } from "../media/media.service";
import { detachErasedReporter } from "./issue-retention";

/**
 * Why one issue's free-text layer is being removed, and the test that decides,
 * under the locks the caller takes, that it still may be.
 */
export interface FreeTextRemoval {
  /**
   * Takes the caller's locks and answers whether the layer may still go.
   *
   * Asked on the transaction that deletes, before anything goes, once for each
   * file and once for the text: a legal hold placed, a restriction recorded or
   * the issue reopened while the run was in flight has to win, and a file
   * cannot be put back. The locks are the caller's because what may refuse is
   * the caller's: the clock is refused by a hold on the reporter, the erasure
   * job by the request no longer being in force.
   */
  stillDue(tx: Prisma.TransactionClient): Promise<boolean>;
  /**
   * Whom the entry names as its subject: the person whose granted request the
   * removal carries out, or nobody, for the clock, which is keyed to the issue.
   */
  targetPersonId: string | null;
  /** Facts about the ground, never a word of what was removed. */
  context: Record<string, string | number | boolean>;
}

/** What one removal did. */
export type FreeTextRemovalOutcome =
  /** The layer is gone: the text, the conversation, the notes and the files. */
  | "removed"
  /**
   * Something refused it under the locks, and nothing more went. Files taken
   * before the refusal stay taken, each with its own `MEDIA_DELETED` entry, and
   * the run says so in the log.
   */
  | "kept"
  /**
   * The text went, and a file attached while the run was in flight stands. The
   * issue is selected again on the next run.
   */
  | "unfinished";

/**
 * Removes the free-text layer of one issue (ADR 0057): what the clock and the
 * issue erasure job both do, written once so the two cannot disagree about
 * what goes.
 *
 * The files first, one transaction each, through `MediaService.remove` with
 * `bytesFirst`: the row, its entry and the removal of the bytes from storage
 * stand or fall together. A storage failure rolls the file back onto the issue
 * and throws, so the text stays and the issue is selected again on the next
 * run, rather than the erasure being recorded while the bytes remain with
 * nothing left to name them. The join rows go with the file by their cascade. Then
 * the text, in one transaction with the entry that records it: the description
 * emptied, the location cleared, every issue message and internal note deleted,
 * and `freeTextRemovedAt` written.
 *
 * Each file's entry is `MEDIA_DELETED` with no file name, because a name
 * somebody gave a photograph of their bathroom is free text too and the log is
 * exempt from every purge. The text's entry is `SERVICE_DATA_PURGED` against
 * the issue, with how many of each went.
 *
 * The building record is not touched: not the type, the status, the outcome,
 * the apartment, the dates or the priority. Nor is the reporter column. What
 * ties the issue to its reporter is cleared by the person purge, which runs
 * after both jobs on the same night and detaches a reporter only from an issue
 * whose free text is gone (`retention/purge.service.ts`): an issue whose text
 * still stands has to keep the one reference that lets a later erasure request
 * find it. The exception is a reporter whose erasure request has already been
 * carried out, whom no run of the person purge selects again: the removal
 * detaches them itself once no work order's text stands either
 * (`detachErasedReporter`).
 */
@Injectable()
export class IssueFreeTextService {
  private readonly logger = new Logger(IssueFreeTextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditLogService,
  ) {}

  async remove(
    issueId: string,
    now: Date,
    removal: FreeTextRemoval,
  ): Promise<FreeTextRemovalOutcome> {
    const files = await this.filesOf(this.prisma, issueId);
    let filesRemoved = 0;
    // The refusal can come after files had gone, and those cannot be put back:
    // say so, since the outcome reads as if the run took nothing.
    const kept = (): "kept" => {
      if (filesRemoved > 0) {
        this.logger.log(
          `Issue ${issueId} kept its free text after ${String(filesRemoved)} files were removed`,
        );
      }
      return "kept";
    };
    for (const fileId of files) {
      let refused = false;
      const removed = await this.media.remove(fileId, null, "SYSTEM", {
        recordFileName: false,
        // A file whose object could not be removed stays on the issue, and so
        // does the erasure: the issue is selected again tomorrow.
        bytesFirst: true,
        keep: async (tx) => {
          refused = !(await removal.stillDue(tx));
          return refused;
        },
      });
      if (refused) {
        return kept();
      }
      if (removed) {
        filesRemoved += 1;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (!(await removal.stillDue(tx))) {
        return kept();
      }

      const current = await tx.issue.findUnique({
        where: { id: issueId },
        select: { description: true, location: true, reporterPersonId: true },
      });
      if (current === null) {
        return kept();
      }
      const { count: messages } = await tx.issueMessage.deleteMany({
        where: { issueId },
      });
      const { count: notes } = await tx.issueNote.deleteMany({
        where: { issueId },
      });
      // A file attached since the files were read stands, and the issue is
      // found again tomorrow: the text goes tonight whatever.
      const standing = (await this.filesOf(tx, issueId)).length;

      // Nothing for this run to take: another run, the clock or the erasure
      // job, took the layer between the scan and the lock. Written anyway it
      // would move `freeTextRemovedAt` and add a second entry with every count
      // at nought. The files this run removed count as taken, so a layer that
      // was only files is still recorded.
      const nothingTaken =
        filesRemoved === 0 &&
        messages === 0 &&
        notes === 0 &&
        current.description === "" &&
        current.location === null;
      if (nothingTaken) {
        return standing === 0 ? "kept" : "unfinished";
      }

      await tx.issue.update({
        where: { id: issueId },
        data: {
          description: "",
          location: null,
          // The marks of a handler's redaction go with what they marked: the
          // whole layer is gone, and the issue now says that instead.
          descriptionRedactedAt: null,
          locationRedactedAt: null,
          ...(standing === 0 ? { freeTextRemovedAt: now } : {}),
        },
      });
      // The reporter of a request already carried out, whom no run of the
      // person purge selects again, once no work order's text stands either.
      const reporterDetached = await detachErasedReporter(
        tx,
        issueId,
        current.reporterPersonId,
      );

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          // No actor: nobody clicked this. A date arrived, or a request the
          // board granted came due.
          actorPersonId: null,
          targetPersonId: removal.targetPersonId,
          targetKind: "issue",
          targetId: issueId,
          // How many of each, and the ground. Never a word of what went, nor a
          // file's name: the retention rule on AuditLogService.
          context: {
            layer: "freeText",
            issueMessages: messages,
            internalNotes: notes,
            files: filesRemoved,
            ...(reporterDetached ? { reporterDetached: true } : {}),
            ...removal.context,
          },
        },
        tx,
      );

      return standing === 0 ? "removed" : "unfinished";
    });
  }

  /** Every file on the issue: the reporter's photographs and the handlers'. */
  private async filesOf(
    client: PrismaService | Prisma.TransactionClient,
    issueId: string,
  ): Promise<string[]> {
    // One after the other: on a transaction, queries share one connection.
    const photos = await client.issuePhoto.findMany({
      where: { issueId },
      select: { fileId: true },
      orderBy: { fileId: "asc" },
    });
    const attachments = await client.issueAttachment.findMany({
      where: { issueId },
      select: { fileId: true },
      orderBy: { fileId: "asc" },
    });
    return [...photos, ...attachments].map((file) => file.fileId);
  }
}
