import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MediaService } from "../media/media.service";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  BOARD_MAILBOX_RETENTION_DAYS,
  boardMailboxPurgeCutoff,
} from "./board-mailbox-retention";

/** Queue the nightly board mailbox purge runs on. */
export const BOARD_MAILBOX_PURGE_QUEUE = "board-mailbox-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own. The news comment and event sign-up
 * purges take 03:11, the import session purge 03:23, the motion purge 03:29, the
 * service data purge 03:41 and the booking purge 03:53, so this one takes 03:05 -
 * six minutes clear of the nearest of them. Jobs waking together on one small
 * connection pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "5 3 * * *";

/**
 * The most threads one run erases.
 *
 * A cooperative's board is written to a few times a week, so a night's worth of
 * expiries is a handful and this is never reached in ordinary running. It exists
 * for the first run on an instance that has been collecting for years, and for
 * the day the retention window is shortened. Nothing is lost by stopping -
 * eligibility is computed from the data rather than marked on it, so the next
 * night's run finds the rest.
 */
const MAX_THREADS_PER_RUN = 500;

export interface BoardMailboxPurgeRunSummary {
  /** Threads the eligibility scan found erasable. */
  considered: number;
  /** Threads erased. */
  purged: number;
  /**
   * Threads whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later thread for good.
   */
  failed: number;
}

/**
 * The board mailbox purge (gallring av styrelsens korrespondens).
 *
 * A thread is service-tier personal data - what somebody wrote to their
 * association and what it answered - and it is erased two years after the last
 * thing said in it. The arithmetic and the reasoning are in
 * `board-mailbox-retention.ts`.
 *
 * ## The unit of work is a thread, not a person
 *
 * Every other purge in this product groups by the person whose data it is
 * erasing, because every other purge is erasing a person's data. This one cannot
 * be: a correspondent is an address an envelope asserted, most of them are
 * nobody in the register - a bank, an authority, a contractor, a neighbour in the
 * next building - and the ones who are are deliberately never resolved. So the
 * scan asks the whole table one question, "which conversations have been quiet
 * for longer than the window", and answers it a thread at a time.
 *
 * One thread per transaction, like the other purges and for the same reasons. A
 * crash halfway through leaves what it finished finished and the rest for
 * tomorrow, because eligibility is computed from the thread's own clock rather
 * than from a flag somebody has to keep in step; and a thread that is gone is
 * not selected, so nothing collects an entry a night for ever in a table that
 * cannot be tidied.
 *
 * Deleting the thread is the whole erasure. The messages and the attachment rows
 * go with it by the cascades, and there is nothing on a thread to blank down to:
 * strip the correspondent and what is left is an unattributed exchange about
 * nothing in particular, which is of no use to anybody and is still a record
 * somebody has to keep.
 *
 * ## Legal hold
 *
 * A hold standing against a person stops the purge of threads whose
 * correspondent address is that person's, the way it stops the residency, the
 * booking and the news comment purges. The ground under GDPR art. 17.3 is about
 * the person's data rather than about one table, and a letter to the board is
 * exactly the record a dispute is likely to be about.
 *
 * Reaching those threads is the one place in this module that goes from a person
 * to their correspondence, and it is worth being precise about why that is not
 * the attribution the rest of the module refuses. Attribution would be showing a
 * board a name against a letter, on the strength of a header anybody can write;
 * this is the association answering for data it holds, starting from its own
 * record of a person and asking which rows must be preserved. It reads the
 * person's own address out of the register, computes this table's blind index
 * from it, and excludes what matches - and it never runs the other way. The
 * data subject access report reaches the same rows by the same route and for the
 * same reason.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes, under the advisory lock in `retention/legal-hold-lock.ts`. The
 * second one is the one that counts, because a hold placed while the run was in
 * flight has to win and the board member who placed it is entitled to assume it
 * did. Held addresses are excluded by the query rather than dropped from its
 * answer, so they cannot spend a run's bound without anything being erased.
 */
@Injectable()
export class BoardMailboxPurgeService implements OnModuleInit {
  private readonly logger = new Logger(BoardMailboxPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
    private readonly media: MediaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a worker
      // must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(BOARD_MAILBOX_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(BOARD_MAILBOX_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every thread past its purge date.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting two years.
   * @param retentionDays How long a thread is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = BOARD_MAILBOX_RETENTION_DAYS,
  ): Promise<BoardMailboxPurgeRunSummary> {
    const threadIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let failed = 0;
    for (const threadId of threadIds) {
      try {
        if (await this.purgeThread(threadId, now, retentionDays)) {
          purged += 1;
        }
      } catch (error) {
        // The class of the failure and the thread id, and nothing the failure was
        // holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Board mailbox purge failed for thread ${threadId}: ${failureName(error)}`,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(purged)} of ${String(threadIds.length)} eligible board mailbox threads`,
      );
    }
    if (threadIds.length === MAX_THREADS_PER_RUN) {
      this.logger.log(
        `Board mailbox purge stopped at its per-run bound of ${String(
          MAX_THREADS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: threadIds.length, purged, failed };
  }

  /**
   * The threads whose retention has run out and against which no hold stands.
   *
   * Held addresses are excluded by the query rather than filtered out of its
   * answer, and that ordering is the whole reason for the extra round trip: the
   * per-run bound is applied by the database, so held threads removed afterwards
   * would still have spent it, and five hundred of them sorting ahead of
   * everything else would fill every run for as long as the holds stood, with the
   * threads behind them outliving their window and nothing reporting a fault.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = boardMailboxPurgeCutoff(now, retentionDays);
    const held = await this.heldAddressIndexes();

    const threads = await this.prisma.boardMailboxThread.findMany({
      where: {
        lastMessageAt: { lte: cutoff },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0
          ? { correspondentEmailIndex: { notIn: held } }
          : {}),
      },
      orderBy: [{ lastMessageAt: "asc" }],
      take: MAX_THREADS_PER_RUN,
      select: { id: true },
    });

    return threads.map((thread) => thread.id);
  }

  /**
   * Erases one thread, and answers whether it went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgeThread(
    threadId: string,
    now: Date = new Date(),
    retentionDays: number = BOARD_MAILBOX_RETENTION_DAYS,
  ): Promise<boolean> {
    const cutoff = boardMailboxPurgeCutoff(now, retentionDays);

    const thread = await this.prisma.boardMailboxThread.findUnique({
      where: { id: threadId },
      select: { id: true, correspondentEmailIndex: true },
    });
    if (thread === null) {
      return false;
    }

    /*
     * The files that arrived on this thread, read before it goes.
     *
     * Deleting the thread cascades to the messages and to the attachment rows,
     * and stops there: an attachment row points at a media file, and that
     * direction cascades the other way - remove the file and the row that
     * indexes it goes with it, not the reverse. So the bytes would outlive the
     * letter that carried them, which is the retention window not being kept
     * for the part of a letter somebody outside the association chose to send.
     *
     * Collected here rather than after the delete, because after it there is
     * nothing left to read them from.
     */
    const attachments = await this.prisma.boardMailboxAttachment.findMany({
      where: { message: { threadId } },
      select: { fileId: true },
    });

    /*
     * Who this thread's correspondent turns out to be in the register, if
     * anybody, read before the transaction opens.
     *
     * Read here rather than inside it because it is a scan of the held people
     * rather than a lookup - `Person.emailIndex` is computed under a different
     * field label, so the two stored indexes are not comparable and the match
     * has to be made by computing this table's index from each held person's own
     * address. The list is a handful in a cooperative that has any holds at all.
     */
    const heldPersonId =
      thread.correspondentEmailIndex === null
        ? null
        : await this.heldPersonFor(thread.correspondentEmailIndex);

    const erased = await this.prisma.$transaction(async (tx) => {
      if (heldPersonId !== null) {
        /*
         * Before the hold is read, so that reading it settles the question.
         * Everything below runs at READ COMMITTED, where a placement committing
         * between the read and the delete would leave this transaction erasing
         * the rows the hold was placed to preserve - and the board member would
         * have been told the person was held. `LegalHoldService.place` takes the
         * same key, which is what makes the two orderable at all.
         */
        await lockLegalHold(tx, heldPersonId);

        const stands = await tx.legalHold.findFirst({
          where: { personId: heldPersonId, releasedAt: null },
          select: { id: true },
        });
        if (stands !== null) {
          // Re-checked here rather than trusted from the scan. A hold placed
          // between the two has to win.
          return false;
        }
      }

      const { count } = await tx.boardMailboxThread.deleteMany({
        where: { id: threadId, lastMessageAt: { lte: cutoff } },
      });
      if (count === 0) {
        // The scan filters these out, so reaching here means the thread went, or
        // gained a message, while this ran. An entry for an erasure that erased
        // nothing would be a false record in a table that cannot be corrected.
        return false;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          /*
           * No subject either, and that is this purge's own answer rather than a
           * copy of another's. Every other SERVICE_DATA_PURGED entry names the
           * person whose data went; here there is no person, because a
           * correspondent is an address an envelope asserted and this module does
           * not resolve one. Naming the register person whose address happened to
           * match would be that attribution, written into a table that cannot be
           * corrected.
           */
          targetKind: "boardMailboxThread",
          targetId: threadId,
          // The window it fell out of, and nothing about the correspondence: not
          // the address, not the subject line, not a word of any message. This
          // entry outlives the rows it describes by design and the log is exempt
          // from every purge, so anything copied here would be the one copy the
          // purge did not reach.
          context: { retentionDaysAfterLastMessage: retentionDays },
        },
        tx,
      );

      return true;
    });

    if (erased) {
      await this.removeAttachments(attachments.map((row) => row.fileId));
    }
    return erased;
  }

  /**
   * Removes the media a purged thread's attachments pointed at.
   *
   * After the transaction and never inside it. `MediaService.remove` opens a
   * transaction of its own and then deletes the object out of storage, and
   * storage is not a thing a database transaction can roll back - a removal
   * begun inside one that then aborted would leave a row pointing at bytes that
   * are gone, which is the failure the attachment row's own cascade note calls
   * worse than no row at all.
   *
   * Each file is checked for anything still pointing at it first. Nothing shares
   * one today - the collector uploads every attachment as its own file, and the
   * media table deduplicates nothing - but a file this purge did not own is not
   * a file it may delete, and the check costs one query against an indexed key.
   *
   * A failure here is logged and not raised. The thread is already gone and the
   * run has more of them to erase; what is left behind is bytes with nothing
   * pointing at them, which the next run does not retry but which is a smaller
   * fault than a purge that stops.
   */
  private async removeAttachments(fileIds: readonly string[]): Promise<void> {
    for (const fileId of fileIds) {
      try {
        const stillReferenced = await this.prisma.boardMailboxAttachment.count({
          where: { fileId },
        });
        if (stillReferenced > 0) {
          continue;
        }
        // No actor, for the reason the erasure entry above gives: a date
        // arrived, and nobody pressed anything.
        await this.media.remove(fileId, null);
      } catch (error) {
        this.logger.error(
          `Board mailbox purge erased a thread but not one of its attachments: ${failureName(error)}`,
        );
      }
    }
  }

  /**
   * This table's blind index for every address a legal hold stands against.
   *
   * The two stored indexes are not comparable - CipherSweet derives a distinct
   * key per table and field, which `field-encryption.service.ts` states - so each
   * held person's address is decrypted and re-indexed under this table's own
   * label. At most one hold stands per person, and a hold is a dispute the board
   * entered deliberately, so this is a handful of rows in a cooperative that has
   * any at all.
   */
  private async heldAddressIndexes(): Promise<string[]> {
    const holds = await this.prisma.legalHold.findMany({
      where: { releasedAt: null },
      select: { person: { select: { id: true, emailCipher: true } } },
      distinct: ["personId"],
    });

    const indexes: string[] = [];
    for (const hold of holds) {
      const index = await this.indexFor(hold.person.emailCipher);
      if (index !== null) {
        indexes.push(index);
      }
    }
    return indexes;
  }

  /** The held person whose address this thread is with, if any. */
  private async heldPersonFor(
    correspondentEmailIndex: string,
  ): Promise<string | null> {
    const holds = await this.prisma.legalHold.findMany({
      where: { releasedAt: null },
      select: { person: { select: { id: true, emailCipher: true } } },
      distinct: ["personId"],
    });

    for (const hold of holds) {
      const index = await this.indexFor(hold.person.emailCipher);
      if (index !== null && index === correspondentEmailIndex) {
        return hold.person.id;
      }
    }
    return null;
  }

  private async indexFor(emailCipher: string | null): Promise<string | null> {
    if (emailCipher === null) {
      // A person the purge has already stripped the contact details of. There is
      // nothing left to match a thread against, which is the erasure working
      // rather than a gap: the hold still stops that person's own purge, and it
      // is the register that says who they are.
      return null;
    }
    const address = await this.encryption.decrypt("person.email", emailCipher);
    return this.encryption.computeIndex(
      "boardMailboxThread.correspondentEmail",
      address,
    );
  }
}
