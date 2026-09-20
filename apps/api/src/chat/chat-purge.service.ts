import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { lockChat } from "./chat-lock";
import {
  erasureRequestedPersonIds,
  withheldPersonIds,
} from "../retention/withheld-persons";
import {
  CHAT_MESSAGE_RETENTION_DAYS,
  chatMessagePurgeCutoff,
} from "./chat-retention";

/** Queue the nightly chat purge runs on. */
export const CHAT_PURGE_QUEUE = "chat-purge";

/**
 * When it runs.
 *
 * 03:59, the last minute of the band, because this job erases the rows a person
 * wrote and the service-data purge at 03:53 is the one that closes a granted
 * erasure request. Running after it would be a night's delay on nothing; running
 * before it is what lets a granted erasure take these rows on the same night.
 *
 * The band as it actually stands: 03:05 board mailbox, 03:07 news comments,
 * 03:11 key orders and event sign-ups, 03:17 sublet applications, member charges
 * and issues, 03:23 import sessions, 03:29 motions, 03:41 bookings, 03:53
 * service data, 03:59 chat. Spacing it is what keeps jobs from waking together
 * on one small connection pool, and the two minutes that carry more than one job
 * are a drift the band was meant to prevent rather than a pattern to copy.
 */
const PURGE_CRON = "59 3 * * *";

/**
 * The most people one run erases the messages of.
 *
 * A board is a handful of people and a night's worth of expiries is a handful of
 * rows each, so this is never reached in ordinary running. It exists for the
 * first run on an instance that has been chatting for years, or the day the
 * retention window is shortened: without a bound that run would erase every
 * message ever written in one transaction-per-person loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface ChatPurgeRunSummary {
  /** People the eligibility scan found erasable messages for. */
  considered: number;
  /** People whose messages were erased. */
  purged: number;
  /** Messages deleted across all of them. */
  messagesDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later person for good.
   */
  failed: number;
  /** Empty groups erased, with the membership lists that were all they held. */
  groupsDeleted: number;
}

/**
 * The chat purge (gallring av chattmeddelanden).
 *
 * A message is service-tier personal data - which person wrote which words in
 * which room - and the purpose it is held for is the conversation. So it is
 * erased on a date derived from when it was written, a year later, and not on
 * the residency purge's clock: somebody who still sits on the board has no more
 * use for last spring's exchange about the roof than somebody who has left, and
 * the residency purge would never reach it at all while they stayed. The
 * arithmetic and the reasoning are in `chat-retention.ts`.
 *
 * ## What it erases
 *
 * The message row, whole. There is nothing on it to blank down to: strip the
 * person and what is left is an unattributed line in a conversation, which is of
 * no use to anybody and is still a record somebody has to keep.
 *
 * The room itself is never touched, and neither is a read marker. A room with
 * every message erased is an empty room, which is what a board that has not
 * written anything for a year has; deleting it would only mean creating it again
 * on the next read. A read marker names an instant and no message, so it says
 * nothing once the messages are gone.
 *
 * ## Legal hold
 *
 * A hold standing against the person who wrote the message stops it, the way it
 * stops the residency purge and the news comment purge. The ground under GDPR
 * art. 17.3 is about the person's data rather than about one table, so a dispute
 * that keeps somebody's contact details keeps what they wrote in the room the
 * dispute may be about.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link ChatPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency and news comment purges and for
 * the same reasons. A crash halfway through leaves what it finished finished and
 * the rest for tomorrow, because eligibility is computed from `createdAt` and
 * the window rather than from a flag somebody has to keep in step; and a person
 * with nothing left to erase is not selected, so nobody collects an entry a night
 * for ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "chatMessage", rather
 * than an action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per person
 * is what lets a later access report say which of that person's data went and
 * when. The count says how much; the messages themselves are gone, which is the
 * point.
 *
 * This is the only audit entry the chat writes at all. Writing a message writes
 * none, for the reason `ChatService` gives, so the log's whole account of a room
 * is that data was erased from it on a date the retention window named.
 */
@Injectable()
export class ChatPurgeService implements OnModuleInit {
  private readonly logger = new Logger(ChatPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a
      // worker must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(CHAT_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(CHAT_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every message past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a message is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = CHAT_MESSAGE_RETENTION_DAYS,
  ): Promise<ChatPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let messagesDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          messagesDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row. The id
        // stays because it is the only handle on an erasure that did not
        // happen, and a failed transaction wrote no audit entry to carry it -
        // ADR 0007.
        failed += 1;
        this.logger.error(
          `Chat purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (messagesDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(messagesDeleted)} chat messages for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Chat purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    const groupsDeleted = await this.purgeEmptyGroups(now, retentionDays);

    return {
      considered: personIds.length,
      purged,
      messagesDeleted,
      failed,
      groupsDeleted,
    };
  }

  /**
   * Erases a group that holds nothing and has held nothing for a year.
   *
   * The one thing in the chat that has no clock of its own. A message carries
   * its own window and a read marker and a report go with the message, but a
   * membership list does not: it says which neighbours were in a room together,
   * and a room whose last message the purge has already erased would keep saying
   * that forever.
   *
   * So a group with no message left in it, created longer ago than a message is
   * kept, goes - and its members, its read markers and the room itself with it.
   * The two conditions are both needed: the first is a room the purge has
   * already emptied, and the second keeps a group somebody made this morning and
   * has not yet written in.
   *
   * The board chat is never touched. There is exactly one of it, it is created
   * on first read and it holds no membership list at all - its members are
   * whoever holds a seat - so an empty board chat is a room waiting for the
   * board to write in it rather than a room that is over.
   *
   * No audit entry. The purge writes one entry per person whose messages it
   * erased, which is the record of what was erased; a room that holds nothing is
   * not a person's data being erased, it is the last of it having gone already.
   */
  private async purgeEmptyGroups(
    now: Date,
    retentionDays: number,
  ): Promise<number> {
    const cutoff = chatMessagePurgeCutoff(now, retentionDays);

    const empty = await this.prisma.chat.findMany({
      where: {
        kind: "GROUP",
        createdAt: { lte: cutoff },
        messages: { none: {} },
      },
      take: MAX_PERSONS_PER_RUN,
      select: { id: true },
    });
    if (empty.length === 0) {
      return 0;
    }

    /*
     * Sorted, so two runs of this sweep take the same rooms in the same order
     * and wait for each other rather than deadlock. One transaction per room
     * rather than one for all of them: a transaction holding five hundred locks
     * would make every writer in the house wait on a sweep of rooms nobody has
     * written in for a year.
     */
    const chatIds = empty.map((chat) => chat.id).sort();

    let deleted = 0;
    for (const chatId of chatIds) {
      try {
        deleted += await this.prisma.$transaction(async (tx) => {
          /*
           * Before the emptiness is decided, so that deciding it settles the
           * question. A message committing between the scan above and this delete
           * would be erased by the cascade and its author told it was stored -
           * `chat-lock.ts` has the whole of that argument, and `ChatService.write`
           * takes the same key.
           */
          await lockChat(tx, chatId);

          /*
           * Every condition again, under the lock and in the delete itself, so
           * that what the scan found is not what is acted on. The room alone: its
           * read markers and its membership rows both cascade with it, so
           * deleting either here would leave the constraint removable without a
           * test noticing. `chatId` carries the cascade; `personId` stays a plain
           * column so a purge can reach a person's rows unvetoed.
           */
          const { count } = await tx.chat.deleteMany({
            where: {
              id: chatId,
              kind: "GROUP",
              createdAt: { lte: cutoff },
              messages: { none: {} },
            },
          });
          return count;
        });
      } catch (error) {
        /*
         * One room the database refuses must not stop the rest, exactly as one
         * person's purge does not stop the run: the loop is a list of erasures
         * that are all owed, and a room that fails every night would otherwise
         * keep every room sorting after it for as long as it kept failing -
         * a retention failure that hides itself behind a summary nobody sees.
         *
         * The class of the failure and the room, and nothing the failure was
         * holding: an exception message here can be quoting a row, and this one
         * would be quoting a room's name - ADR 0007.
         */
        this.logger.error(
          `Purging empty group chat ${chatId} failed: ${failureName(error)}`,
        );
      }
    }

    if (deleted > 0) {
      this.logger.log(`Purged ${String(deleted)} empty group chats`);
    }

    return deleted;
  }

  /**
   * The people who wrote at least one message whose retention has run out.
   *
   * Grouped by the author rather than listing messages, because the unit of work
   * is a person: one transaction, one audit entry, one answer to "what of mine
   * was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather
   * than filtered out of its answer, and that ordering is the whole reason for
   * the extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held
   * people sorting ahead of everybody else would fill every run for as long as
   * their holds stood, and the messages behind them would outlive their
   * retention window with nothing reporting a fault.
   *
   * `authorPersonId` is a plain column and not a relation, so the holds are read
   * first and passed in rather than joined - the same trade the audit log makes,
   * and the reason a purge can reach this table at all.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = chatMessagePurgeCutoff(now, retentionDays);
    const withheld = await withheldPersonIds(this.prisma);
    const requested = (await erasureRequestedPersonIds(this.prisma)).filter(
      (personId) => !withheld.includes(personId),
    );

    const groups = await this.prisma.chatMessage.groupBy({
      by: ["authorPersonId"],
      where: {
        /*
         * Either the message's own window has run out, or the person has been
         * granted erasure, in which case every message of theirs goes however
         * recent: bringing the purge forward is what the board granted.
         */
        OR: [
          { createdAt: { lte: cutoff } },
          ...(requested.length > 0
            ? [{ authorPersonId: { in: requested } }]
            : []),
        ],
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(withheld.length > 0 ? { authorPersonId: { notIn: withheld } } : {}),
      },
      orderBy: [{ authorPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.authorPersonId);
  }

  /**
   * Erases one person's expired messages, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = CHAT_MESSAGE_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = chatMessagePurgeCutoff(now, retentionDays);

    return this.prisma.$transaction(async (tx) => {
      /*
       * Before the hold is read, so that reading it settles the question.
       * Everything below runs at READ COMMITTED, where a placement committing
       * between the read and the delete would leave this transaction erasing the
       * rows the hold was placed to preserve - and the board member would have
       * been told the person was held. `LegalHoldService.place` takes the same
       * key, which is what makes the two orderable at all.
       */
      await lockLegalHold(tx, personId);

      const held = await tx.legalHold.findFirst({
        where: { personId, releasedAt: null },
        select: { id: true },
      });
      const person = await tx.person.findUnique({
        where: { id: personId },
        select: { processingRestrictedAt: true },
      });
      if (held !== null || person?.processingRestrictedAt != null) {
        /*
         * Re-checked here rather than trusted from the scan. A hold placed, or a
         * restriction recorded, between the scan and this transaction has to
         * win: whoever asked for it is entitled to assume it took effect, and
         * this is the moment where that is either true or a promise nobody kept.
         * A restriction refuses for the reason art. 18(2) gives - the
         * association may store the data, which makes erasing it the one act
         * the person asked it not to perform.
         */
        return 0;
      }

      /*
       * A granted erasure request moves this job's cutoff to now, which is the
       * whole of what bringing the purge forward means: the same rows, on the
       * same rule, without waiting out a window the person asked to be freed
       * from. The request is not closed here - the service-data purge runs at
       * 03:53 and closes it, and this job runs six minutes later, so a granted
       * erasure reaches the chat on the same night rather than the next one.
       */
      const request = await tx.dataSubjectRequest.findFirst({
        where: {
          personId,
          kind: "ERASURE",
          decision: "GRANTED",
          executedAt: null,
          closedAt: null,
        },
        select: { id: true },
      });
      const effectiveCutoff = request === null ? cutoff : now;

      const { count } = await tx.chatMessage.deleteMany({
        where: {
          authorPersonId: personId,
          createdAt: { lte: effectiveCutoff },
        },
      });
      if (count === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing would
        // be a false record in a table that cannot be corrected.
        return 0;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          targetPersonId: personId,
          targetKind: "chatMessage",
          /*
           * How many, and the window they fell out of. Not which room, and not a
           * word of what any of them said - the retention rule on
           * AuditLogService. This entry names the person and outlives the rows
           * it describes by design, and the log is exempt from every purge, so
           * text copied in here would be a permanent record of what the board
           * said to itself, inside the entry that says it was erased.
           */
          context: {
            chatMessages: count,
            retentionDaysAfterMessage: retentionDays,
          },
        },
        tx,
      );

      return count;
    });
  }
}
