import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { isUniqueViolation } from "../database/unique-violation";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import type { RenderedMail } from "../mail/mail-template";
import { MediaError, MediaService } from "../media/media.service";
import { BoardMailboxError } from "./board-mailbox.error";
import {
  COLLECTION_REFUSALS,
  type CollectionRefusal,
  LISTED_REFUSALS,
} from "./board-mailbox-delivery";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";
import { BoardMailboxPurgeService } from "./board-mailbox-purge.service";
import { boardMailboxPurgeCutoff } from "./board-mailbox-retention";
import {
  loadBoardMailboxSettings,
  legacyMailboxFingerprint,
  mailboxFingerprint,
} from "./board-mailbox-settings";
import { isDataRefusal } from "./database-refusal";
import {
  type MimeAttachment,
  type ParsedMessage,
  type ReadText,
  readBody,
  readMessage,
} from "./mime";
import {
  openPop3Session,
  type Pop3Credentials,
  Pop3Error,
  type Pop3Listing,
} from "./pop3";
import { lockThread } from "./thread-lock";

/**
 * Collecting the board's mailbox.
 *
 * This is the inbound half of the shared board mailbox, and the reason the
 * module exists at all: mail sent to the address the board publishes is fetched
 * into this instance so that every seat reads the same inbox. The protocol and
 * the argument for choosing it are in `pop3.ts`; what this file adds is what
 * happens to a letter once it has been fetched.
 *
 * ## Exactly once, without deleting anybody's mail
 *
 * Nothing is removed from the mailbox. What stops the same letter being
 * collected twice is its POP3 unique identifier, stored on the message under a
 * unique constraint: a poll asks the server for the identifiers it holds, skips
 * the ones this instance already has, and if two polls overlap the second loses
 * on the constraint rather than on a check it made a moment earlier. Both halves
 * matter - the query keeps the ordinary case cheap, and the constraint is what
 * makes it correct.
 *
 * The identifier carries a fingerprint of the mailbox it came from, because a
 * UID is unique within one mailbox and not between two. See
 * `board-mailbox-settings.ts`.
 *
 * ## What a letter is allowed to cost
 *
 * Every bound here exists because the input is written by somebody outside the
 * association, who chooses how large it is and how much of it there is. A
 * message over the size limit is skipped without being retrieved at all - the
 * server states each message's size before anything is fetched - so a mailbox
 * full of large files costs this instance a listing and nothing more. The letter
 * stays where it is, which is the honest outcome: it is still in the board's
 * mailbox, readable in a mail client, rather than half-collected here.
 *
 * ## What a collected letter is not
 *
 * It is not attributed to anybody. The From address is an assertion by whoever
 * sent it and this platform cannot check it, so a thread records an address and
 * a display name, and nothing in the product turns one into a person on a
 * screen - see the model comment on BoardMailboxThread.
 *
 * A thread opened from an address exactly one person in the register holds does
 * record that person, and that is a different claim: it decides whose data
 * subject access report the letter belongs in, is read by that report and by
 * nothing else, and says whose data the association is answering for rather
 * than who wrote.
 *
 * It is not markup either: the body is stored as text and an HTML part is
 * converted as it is read, so nothing markup-shaped is ever persisted. And an
 * attachment's declared type is not believed: every file goes through the
 * ordinary upload path, which identifies it from its own bytes.
 */

/** Queue the collection runs on. */
export const BOARD_MAILBOX_COLLECT_QUEUE = "board-mailbox-collect";

/**
 * How often the mailbox is collected.
 *
 * Every five minutes, which is the interval at which "the board has a shared
 * inbox" is true rather than nearly true: a resident who writes about a leak
 * expects the board to have it, and a board member watching the screen after
 * telling somebody to write in should not have to wonder whether the delay is
 * the poll or the sender. It costs one short session against the mailbox
 * provider, which is what a mail client on a phone does rather more often.
 *
 * Not one of the small-hours minutes the purges take: this is the only recurring
 * job in the product that is not a nightly clean-up, and contending with them
 * twelve times an hour would be the wrong trade in both directions. The board
 * can also collect on demand from the screen, which is what makes a five-minute
 * floor acceptable rather than a compromise.
 */
const COLLECT_CRON = "*/5 * * * *";

/**
 * The largest message this instance will retrieve, in bytes.
 *
 * Ten mebibytes, which is the default upload limit the rest of the product
 * carries (`OPENBRF_MAX_UPLOAD_BYTES`) and is deliberately the same number: a
 * board that can be sent a photograph of a leak through the issue form should be
 * able to be sent one by mail. A message is held in memory while it is parsed,
 * so this is also what bounds that.
 *
 * Stated here rather than read from the environment variable, because the two
 * bound different things and coupling them would make one a lever on the other:
 * that setting is what an association's own residents may upload through a
 * screen this instance controls, and this is what a stranger may cause it to
 * fetch. Raising the first should not raise the second.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * The most messages one collection fetches.
 *
 * Whatever is left is fetched by the next run, five minutes later, because
 * eligibility is computed from what is in the mailbox rather than marked on
 * anything. It exists for the first collection on a mailbox that has been
 * receiving for years, and for the day somebody points a mailing list at the
 * board's address.
 */
export const MAX_MESSAGES_PER_COLLECTION = 50;

/**
 * The most attachments one message may leave behind.
 *
 * A bound on one message and only on one message, exactly as
 * MAX_PHOTOS_PER_ISSUE is: every file is held in memory while it is identified
 * and checksummed, and twenty pictures on one letter are neither readable by
 * whoever has to answer it nor free to serve. It is not a defence against
 * filling the data volume - the message size limit above is what bounds that.
 */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * How often a letter may fail to be stored before it is set aside.
 *
 * A failure that says nothing about the letter is retried, because a later run
 * stores it - see `database-refusal.ts`. This is what stops a letter that fails
 * every time for a reason nobody foresaw being retried for as long as the
 * mailbox keeps it, unseen by the board. Twelve runs is an hour of the schedule.
 */
const MAX_STORE_ATTEMPTS = 12;

/**
 * How long a letter is retried before it may be set aside, however often it
 * was tried.
 *
 * The schedule is not the only caller: a board pressing "collect now" during an
 * outage would otherwise use a letter's attempts up in a minute, and set aside
 * mail that the next quiet run would have stored.
 */
const MIN_RETRY_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a letter set aside for failing on every attempt waits before it is
 * tried again.
 *
 * The bound above cannot tell a letter that fails from an instance that does:
 * storage down for longer than the window, or a deploy ahead of its migration,
 * fails every letter it touches alike, and all of them reach the bound
 * together. So the set-aside is not final. Each is tried once more after this
 * long, stored if the instance has recovered, and set aside for as long again
 * if not - which is four fetches a day for a letter that really cannot be
 * stored, and the board's screen lists it meanwhile.
 */
const SET_ASIDE_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * How far a sender's Date header may be from the clocks this module checks it
 * against.
 *
 * The header is the sender's own clock and this module orders a thread by it, so
 * a message dated next year would sit at the top of the board's inbox for a year
 * and a thread's retention would not start running. A date further ahead of
 * this instance's clock than this is replaced by the moment of collection, which
 * is a fact this instance owns.
 *
 * The same distance either side of the moment the mailbox received the letter,
 * where that is known - see {@link trustedDate}.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** What one collection did. Counts only: no address and no subject. */
export interface CollectionSummary {
  /** Whether a mailbox is configured at all. */
  configured: boolean;
  /** Messages the mailbox held. */
  available: number;
  /** Messages stored by this run. */
  collected: number;
  /** Messages this instance already held. */
  alreadyHeld: number;
  /**
   * Messages left where they are: too large, dated before the retention
   * window, carrying no address the board could answer, refused by the
   * database, or to be tried again.
   */
  skipped: number;
}

interface CollectJob {
  [key: string]: unknown;
}

@Injectable()
export class BoardMailboxCollectorService implements OnModuleInit {
  private readonly logger = new Logger(BoardMailboxCollectorService.name);

  /** The collection in flight, which every caller that arrives shares. */
  private running: Promise<CollectionSummary> | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly media: MediaService,
    private readonly jobs: JobQueueService,
    private readonly purge: BoardMailboxPurgeService,
    private readonly mailer: BoardMailboxMailerService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the collection themselves, so a worker must not
      // race them with the real one.
      return;
    }
    await this.startWorker();
  }

  /** Registers the collection. Public so an integration test can drive it. */
  async startWorker(): Promise<void> {
    await this.jobs.work<CollectJob>(BOARD_MAILBOX_COLLECT_QUEUE, async () => {
      await this.collect();
    });
    await this.jobs.schedule(BOARD_MAILBOX_COLLECT_QUEUE, COLLECT_CRON, {});
  }

  /**
   * Collects whatever is waiting in the mailbox.
   *
   * Answered rather than thrown for the configuration case: a board that has not
   * set the mailbox up is not an error condition, and the screen says so.
   * Everything else the mailbox can do wrong - a wrong password, a host that is
   * not there, a connection that stalls - is thrown as
   * {@link BoardMailboxError} with `mailbox-unreachable`, because a board member
   * who pressed a button is owed an answer and the alternative is a screen that
   * says nothing arrived.
   *
   * @param now The moment to judge a sender's Date header against. Passed in so
   *   a test drives the clock rather than the process's.
   */
  async collect(now: Date = new Date()): Promise<CollectionSummary> {
    /*
     * One collection at a time, and everybody waiting on it gets its answer.
     *
     * The schedule runs every five minutes and the screen has a button beside
     * it, so two collections overlapping is ordinary rather than exceptional -
     * and a mailbox is a single resource: POP3 gives one session an exclusive
     * lock on it (RFC 1939 section 3), so the second connection is refused and
     * the board is told its mailbox could not be reached when it was only busy.
     * The concurrent one is also the expensive one, because each session
     * retrieves the same letters the other is retrieving.
     *
     * Sharing the promise answers both. A caller that arrives while a collection
     * is running is answered by that collection, which is the answer it would
     * have computed, and no request can open a second session however many
     * arrive.
     */
    this.running ??= this.collectOnce(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The collection itself. Entered through {@link collect}, never directly. */
  private async collectOnce(now: Date): Promise<CollectionSummary> {
    const settings = await loadBoardMailboxSettings(
      this.prisma,
      this.encryption,
    );
    if (settings === null) {
      return {
        configured: false,
        available: 0,
        collected: 0,
        alreadyHeld: 0,
        skipped: 0,
      };
    }

    const prefix = mailboxFingerprint(settings.credentials);
    await this.adoptLegacyPrefix(settings.credentials, prefix);
    const session = await openPop3Session(settings.credentials).catch(
      (error: unknown) => {
        // The class of the failure, never the mailbox's own words: a POP3 error
        // response quotes the mailbox name back, and that is the board's
        // address.
        this.logger.error(`Board mailbox unreachable: ${failureName(error)}`);
        // A refused sign-in gets its own reason, because it is the one the board
        // can act on: it means the user name or the password is wrong, and the
        // screen says so and points at the settings. Everything else - a host
        // that is not there, a certificate, a connection that stalls - is one
        // answer, because they are one answer to a board: the mailbox did not
        // respond.
        throw new BoardMailboxError(
          "The board's mailbox could not be reached.",
          error instanceof Pop3Error && error.reason === "authentication-failed"
            ? "mailbox-sign-in-refused"
            : "mailbox-unreachable",
        );
      },
    );

    try {
      const listings = await session.list();
      await this.forgetDeparted(listings, prefix);
      const { held, retrying } = await this.heldUids(listings, prefix, now);

      let collected = 0;
      let alreadyHeld = 0;
      let skipped = 0;
      /*
       * What the cap above counts.
       *
       * Retrievals, not rows written. A message can be fetched in full and still
       * leave nothing behind - it was the board's own answer, or it carried no
       * address to reply to, or the mailbox refused it halfway - and counting
       * only the stored ones would let a mailbox full of those be downloaded
       * whole on every run, five minutes apart, for as long as they sit there.
       * The constant says fetches, and this is what makes that true.
       */
      let retrieved = 0;

      for (const listing of listings) {
        const uid = `${prefix}:${listing.uid}`;
        if (held.has(uid)) {
          alreadyHeld += 1;
          continue;
        }
        if (retrieved >= MAX_MESSAGES_PER_COLLECTION) {
          break;
        }
        if (listing.octets > MAX_MESSAGE_BYTES) {
          // Not retrieved at all. The letter stays in the mailbox, where a board
          // member can still open it in a mail client, which is a better outcome
          // than a half-collected one here.
          this.logger.warn(
            `Board mailbox: a message of ${String(listing.octets)} bytes is over the limit and was left in the mailbox.`,
          );
          skipped += 1;
          continue;
        }

        retrieved += 1;
        const stored = await this.collectOne(
          session.retrieve.bind(session),
          listing,
          uid,
          now,
          retrying.has(uid),
          settings.address,
        );
        if (stored === "collected") {
          collected += 1;
        } else if (stored === "already-held") {
          alreadyHeld += 1;
        } else {
          skipped += 1;
        }
        // A failure that ended the session ends the run. Every letter behind
        // it would fail for the session's sake rather than its own, and be
        // counted towards being set aside for it.
        if (!session.open) {
          break;
        }
      }

      if (collected > 0 || skipped > 0) {
        this.logger.log(
          `Board mailbox: ${String(collected)} collected, ${String(skipped)} left, ${String(alreadyHeld)} already held`,
        );
      }

      return {
        configured: true,
        available: listings.length,
        collected,
        alreadyHeld,
        skipped,
      };
    } finally {
      // Always, and never in a way that can replace the failure above: a session
      // left open holds a connection on the far end until its own idle timer
      // fires, and a mailbox provider counts concurrent connections.
      await session.close();
    }
  }

  /**
   * Whether this message is one the board sent from here.
   *
   * A message with no identifier is never ours: every reply this instance writes
   * is given one before it is handed to a mail server, precisely so that it can
   * be recognised again - on the way back into a thread, and here.
   *
   * The identifier is not enough on its own, because it is not a secret: it
   * travels in the answer to the correspondent, and in every reply they make.
   * Taken alone it would let anybody who was ever answered write to the board
   * again under it, and have the letter set aside here as the board's own
   * words - never stored, and never shown. So the letter has to say what the
   * board said as well. Its subject and every form of its text are held to
   * the answer as this instance renders it, and it may carry nothing the
   * answer did not: no file, and no part the reader leaves unread. A text part
   * a sender adds beside the answer is read into the text, and an HTML form
   * beside the plain one is read on its own, so each is compared with the
   * rest. A sender who copies all of that has sent the board its own answer,
   * and nothing is lost by not storing it twice.
   *
   * A copy that does not match - a list that adds a footer, an association
   * renamed between the answer and its copy - is collected as a letter. That
   * is the failure this can afford: the board sees its own words once more,
   * rather than not seeing somebody else's at all.
   */
  private async ownAnswerId(
    parsed: ParsedMessage,
    boardAddress: string,
  ): Promise<string | null> {
    if (
      parsed.messageId === null ||
      parsed.attachments.length > 0 ||
      parsed.unreadParts > 0
    ) {
      return null;
    }
    const candidates = await this.prisma.boardMailboxMessage.findMany({
      where: { messageId: parsed.messageId, direction: "OUTBOUND" },
      select: { id: true },
      // An identifier this instance minted or a mail service reported names one
      // answer. A bound all the same, since each candidate is rendered, and an
      // order, so the same copy is compared with the same answers on every run.
      orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
      take: 3,
    });
    for (const candidate of candidates) {
      let rendered: RenderedMail | null;
      try {
        rendered = await this.mailer.renderReply(candidate.id, boardAddress);
      } catch (error) {
        // Not recognised, so collected: the board's own words on the screen
        // again is the outcome this can afford, as above.
        this.logger.warn(
          `Board mailbox: an answer of this instance's own could not be rendered to compare: ${failureName(error)}`,
        );
        continue;
      }
      if (rendered !== null && saysTheSame(parsed, rendered)) {
        return candidate.id;
      }
    }
    return null;
  }

  /**
   * Writes the mailbox identifier onto the answer this instance already sent.
   *
   * Which is what stops it being fetched again. The identifier is how this
   * module decides what it holds, so an answer that comes back round and is
   * recognised only by reading it would be read again on every run for as long
   * as the mailbox keeps it - and a mailbox that files sent mail keeps it for
   * good. Recognising it once and saying so leaves the same row, under the same
   * unique identifier, as a collected letter.
   *
   * The write is conditional on the column still being empty, so two runs that
   * saw the same answer do not fight over it, and a failure to write is not a
   * reason to store the board's own words back as a question.
   *
   * The answer has one column, and a mailbox can hold more than one copy: a
   * provider that files sent mail and a board that copies its own address
   * leave two. A copy that finds the column taken is recorded in the ledger
   * of letters read and not stored instead, under a reason the board's screen
   * does not list. Without that it would be fetched again on every run, and
   * as many copies as one run fetches would stop the collection before the
   * letters behind them.
   *
   * @param letterDate The copy's own date, where it is believed.
   */
  private async holdOwnAnswer(
    id: string,
    uid: string,
    letterDate: Date | null,
  ): Promise<void> {
    try {
      const marked = await this.prisma.boardMailboxMessage.updateMany({
        where: { id, sourceUid: null },
        data: { sourceUid: uid },
      });
      if (marked.count > 0) {
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Board mailbox: an answer of this instance's own could not be marked as held: ${failureName(error)}`,
      );
      return;
    }
    await this.setAside(
      uid,
      COLLECTION_REFUSALS.ownAnswerCopy,
      letterDate,
      null,
    );
  }

  /**
   * Which of the listed messages this instance already holds.
   *
   * One query for the whole listing rather than one per message. The listing is
   * bounded by the mailbox, and asking about a hundred identifiers at once is a
   * single index scan.
   */
  private async heldUids(
    listings: readonly Pop3Listing[],
    prefix: string,
    now: Date,
  ): Promise<{ held: ReadonlySet<string>; retrying: ReadonlySet<string> }> {
    if (listings.length === 0) {
      return { held: new Set(), retrying: new Set() };
    }
    const uids = listings.map((listing) => `${prefix}:${listing.uid}`);

    // Both ledgers, because both answer the same question. A letter is held
    // either because it became a message or because it was read and refused,
    // and a collection that asked only the first would fetch every refused
    // letter again on every run.
    const [stored, ignored] = await Promise.all([
      this.prisma.boardMailboxMessage.findMany({
        where: { sourceUid: { in: uids } },
        select: { sourceUid: true },
      }),
      this.prisma.boardMailboxIgnoredMessage.findMany({
        where: { sourceUid: { in: uids } },
        select: { sourceUid: true, reason: true, retryAfter: true },
      }),
    ]);

    const storedUids = new Set(
      stored
        .map((row) => row.sourceUid)
        .filter((uid): uid is string => uid !== null),
    );
    const setAside = ignored.filter((row) => !storedUids.has(row.sourceUid));
    await this.forgetStoredSetAside(
      ignored
        .filter(
          (row) =>
            storedUids.has(row.sourceUid) &&
            (LISTED_REFUSALS as readonly string[]).includes(row.reason),
        )
        .map((row) => row.sourceUid),
    );

    // A letter set aside for failing, whose wait is over, is tried again by
    // this run rather than held.
    const due = (retryAfter: Date | null): boolean =>
      retryAfter !== null && retryAfter.getTime() <= now.getTime();

    return {
      held: new Set([
        ...storedUids,
        ...setAside
          .filter((row) => !due(row.retryAfter))
          .map((row) => row.sourceUid),
      ]),
      retrying: new Set(
        setAside
          .filter((row) => due(row.retryAfter))
          .map((row) => row.sourceUid),
      ),
    };
  }

  /**
   * Moves what was collected under the fingerprint as it was first taken - of
   * the host and user exactly as typed - to the one taken now.
   *
   * An instance whose settings carried a capital letter or a space would
   * otherwise find no letter held on its first run after the change, and store
   * every letter still in the mailbox a second time; the purged and set-aside
   * ledgers would stop matching with it. Nothing to do, and one comparison,
   * where the two agree, which is every mailbox typed in lowercase.
   */
  private async adoptLegacyPrefix(
    credentials: Pop3Credentials,
    prefix: string,
  ): Promise<void> {
    const legacy = `${legacyMailboxFingerprint(credentials)}:`;
    if (legacy === `${prefix}:`) {
      return;
    }
    // substr from the separator on, so what follows the prefix is kept as is.
    await this.prisma.$transaction([
      this.prisma
        .$executeRaw`UPDATE board_mailbox_message SET "sourceUid" = ${prefix} || substr("sourceUid", ${legacy.length}) WHERE starts_with("sourceUid", ${legacy})`,
      this.prisma
        .$executeRaw`UPDATE board_mailbox_ignored_message SET "sourceUid" = ${prefix} || substr("sourceUid", ${legacy.length}) WHERE starts_with("sourceUid", ${legacy})`,
      this.prisma
        .$executeRaw`UPDATE board_mailbox_collection_failure SET "sourceUid" = ${prefix} || substr("sourceUid", ${legacy.length}) WHERE starts_with("sourceUid", ${legacy})`,
    ]);
  }

  /**
   * Takes stored letters off the set-aside list.
   *
   * A letter is one or the other, but two collections can each leave half of
   * both: one fails to store a letter and finds it not stored, the other stores
   * it, and the first then sets it aside. A stored letter is not fetched again,
   * so nothing else would ever correct the row, and the board's screen would
   * list a letter it has already received for as long as the mailbox keeps it.
   * Repaired here, where every run reads both ledgers anyway.
   *
   * Only the rows the screen lists. A letter can also be stored and recorded as
   * purged at once: the purge deletes a thread and records its letters in one
   * transaction, and a collection that read the messages before it committed
   * and the ledger after sees both. That row is what keeps an erased letter
   * erased, and the stored copy goes the next night with the rest of what is
   * past the window, so the row has to outlive it. The same for a letter
   * recorded as past retention when it was first read.
   *
   * A failure is logged and the run goes on: the letter is held either way, and
   * the next run tries again.
   */
  private async forgetStoredSetAside(uids: readonly string[]): Promise<void> {
    if (uids.length === 0) {
      return;
    }
    try {
      await this.prisma.boardMailboxIgnoredMessage.deleteMany({
        where: {
          sourceUid: { in: [...uids] },
          reason: { in: [...LISTED_REFUSALS] },
        },
      });
    } catch (error) {
      this.logger.warn(
        `Board mailbox: a stored message could not be removed from the set-aside list: ${failureName(error)}`,
      );
    }
  }

  /**
   * Forgets the letters the mailbox no longer holds.
   *
   * The ledger of set-aside letters and the count of failures are both keyed by
   * a letter in the mailbox, and a board member can delete one there in a mail
   * client. Without this the screen would go on saying such a letter is still in
   * the mailbox, and counting it, for good. Only rows under the mailbox being
   * collected: one the settings no longer name is not listed here, so nothing
   * can be said about what it holds.
   *
   * The rows are read and compared here rather than deleted with the listing
   * as a NOT IN: a mailbox kept for years lists more identifiers than one
   * statement takes parameters, and these ledgers hold a handful of rows.
   *
   * A failure here is logged and the run goes on. What it leaves is a stale row,
   * which the next run removes.
   */
  private async forgetDeparted(
    listings: readonly Pop3Listing[],
    prefix: string,
  ): Promise<void> {
    const listed = new Set(
      listings.map((listing) => `${prefix}:${listing.uid}`),
    );
    const where = { sourceUid: { startsWith: `${prefix}:` } };
    const select = { id: true, sourceUid: true } as const;
    const departed = (rows: readonly { id: string; sourceUid: string }[]) => ({
      id: {
        in: rows
          .filter((row) => !listed.has(row.sourceUid))
          .map((row) => row.id),
      },
    });
    try {
      const [ignored, failures] = await Promise.all([
        this.prisma.boardMailboxIgnoredMessage.findMany({ where, select }),
        this.prisma.boardMailboxCollectionFailure.findMany({ where, select }),
      ]);
      await this.prisma.boardMailboxIgnoredMessage.deleteMany({
        where: departed(ignored),
      });
      await this.prisma.boardMailboxCollectionFailure.deleteMany({
        where: departed(failures),
      });
    } catch (error) {
      this.logger.warn(
        `Board mailbox: letters no longer in the mailbox could not be forgotten: ${failureName(error)}`,
      );
    }
  }

  /**
   * Records that a message was read and will not be stored, for now or for
   * good.
   *
   * Which is what stops it being fetched again. Without it a letter the
   * collector can do nothing with is read in full on every run for as long as
   * the mailbox keeps it, and - since the per-run bound counts fetches - enough
   * of them at the head of the mailbox stop the collection before it reaches the
   * mail behind them, so the board goes on receiving nothing while the mailbox
   * fills.
   *
   * Written only for a refusal that cannot change its mind, or a letter that
   * has failed more often than MAX_STORE_ATTEMPTS allows. An upsert, so a
   * letter tried again and set aside again keeps one row, and a write that does
   * not land is logged rather than raised: the letter stays in the mailbox
   * either way, which is where it was.
   *
   * @param letterDate The letter's own date, where it is believed, which is
   *   what the board's screen gives to find the letter by in a mail client.
   * @param retryAfter When to try it again, or null for a refusal.
   */
  private async setAside(
    uid: string,
    reason: CollectionRefusal,
    letterDate: Date | null,
    retryAfter: Date | null,
  ): Promise<void> {
    try {
      await this.prisma.boardMailboxIgnoredMessage.upsert({
        where: { sourceUid: uid },
        create: { sourceUid: uid, reason, letterDate, retryAfter },
        update: { reason, letterDate, retryAfter },
        select: { id: true },
      });
      // After, and on its own: a count left behind by a failure here is never
      // read again, because a letter in the ledger is not fetched again.
      await this.prisma.boardMailboxCollectionFailure.deleteMany({
        where: { sourceUid: uid },
      });
    } catch (error) {
      this.logger.warn(
        `Board mailbox: a message that cannot be stored could not be marked as read: ${failureName(error)}`,
      );
    }
  }

  /**
   * Counts a failure to store a letter, and says whether it has now failed
   * often enough, and for long enough, to be set aside.
   *
   * A count that cannot be written is logged and answered with no: the letter
   * is retried, which is what it would have been without the bound, and a
   * database that cannot take this row is the likeliest reason it failed.
   */
  private async countFailure(uid: string, now: Date): Promise<boolean> {
    try {
      const failure = await this.prisma.boardMailboxCollectionFailure.upsert({
        where: { sourceUid: uid },
        create: { sourceUid: uid, attempts: 1, firstFailedAt: now },
        update: { attempts: { increment: 1 } },
        select: { attempts: true, firstFailedAt: true },
      });
      return (
        failure.attempts >= MAX_STORE_ATTEMPTS &&
        now.getTime() - failure.firstFailedAt.getTime() >= MIN_RETRY_WINDOW_MS
      );
    } catch (error) {
      this.logger.warn(
        `Board mailbox: a failure to store a message could not be counted: ${failureName(error)}`,
      );
      return false;
    }
  }

  /**
   * Removes the files of a letter whose rows may not have been written.
   *
   * A failed transaction is not proof that nothing committed: when the reply to
   * a COMMIT that landed is lost - a connection dropped just after it, a
   * failover - the rows are there and the collector is told they are not. The
   * attachment rows go with their file, so removing a file on that word alone
   * would empty a stored letter for good. So a file is removed only when no
   * attachment row names it, and when that cannot be asked, none is: an orphan
   * object is what the media layer prefers to a lost file.
   */
  private async discardUnnamedFiles(
    files: readonly { id: string }[],
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }
    let named: ReadonlySet<string>;
    try {
      const rows = await this.prisma.boardMailboxAttachment.findMany({
        where: { fileId: { in: files.map((file) => file.id) } },
        select: { fileId: true },
      });
      named = new Set(rows.map((row) => row.fileId));
    } catch (error) {
      this.logger.warn(
        `Board mailbox: the attachments of a message that may not have been stored were left in place: ${failureName(error)}`,
      );
      return;
    }
    await this.discardFiles(files.filter((file) => !named.has(file.id)));
  }

  /**
   * Whether this letter is stored after all, although its write failed.
   *
   * The same lost reply as above: a letter whose rows committed must not be
   * counted as failing, or set aside. An answer that cannot be had is no.
   */
  private async storedAfterAll(uid: string): Promise<boolean> {
    try {
      const message = await this.prisma.boardMailboxMessage.findFirst({
        where: { sourceUid: uid },
        select: { id: true },
      });
      return message !== null;
    } catch {
      return false;
    }
  }

  /**
   * Removes the files of a letter whose rows were not written.
   *
   * Nothing names them, so nothing would ever serve or purge them: a letter
   * retried on every run would otherwise leave a fresh copy of each attachment
   * behind every five minutes. A file that cannot be removed is logged and left,
   * which is the media layer's own answer to the same failure.
   */
  private async discardFiles(files: readonly { id: string }[]): Promise<void> {
    for (const file of files) {
      await this.media
        // No file name in the audit log: it is a stranger's words, and a letter
        // retried for an hour would write it there a dozen times over.
        .remove(file.id, null, "SYSTEM", { recordFileName: false })
        .catch((error: unknown) => {
          this.logger.warn(
            `Board mailbox: an attachment of a message that was not stored could not be removed: ${failureName(error)}`,
          );
        });
    }
  }

  /** One letter: fetch it, read it, store it. */
  private async collectOne(
    retrieve: (number: number, maxBytes: number) => Promise<Buffer>,
    listing: Pop3Listing,
    uid: string,
    now: Date,
    retrying: boolean,
    boardAddress: string,
  ): Promise<"collected" | "already-held" | "skipped"> {
    let raw: Buffer;
    try {
      raw = await retrieve(listing.number, MAX_MESSAGE_BYTES);
    } catch (error) {
      // One message that cannot be fetched must not stop the ones behind it.
      // It stays in the mailbox and the next run tries again - up to the bound
      // a letter that cannot be stored has, and for the same reason: one the
      // mailbox refuses on every run would otherwise take one of the run's
      // retrievals for as long as it sits there. Undated, because what carries
      // the date is what could not be fetched.
      this.logger.error(
        `Board mailbox: a message could not be retrieved: ${failureName(error)}`,
      );
      if (retrying || (await this.countFailure(uid, now))) {
        await this.setAside(
          uid,
          COLLECTION_REFUSALS.unstorable,
          null,
          new Date(now.getTime() + SET_ASIDE_RETRY_MS),
        );
      }
      return "skipped";
    }

    const parsed = readMessage(raw);
    const letterDate = believedDate(parsed.date, now);

    const own = await this.ownAnswerId(parsed, boardAddress);
    if (own !== null) {
      /*
       * The board's own reply, come back round.
       *
       * A mailbox can hold what was sent from it as well as what was delivered
       * to it: a board that copies its own address on an answer, a provider that
       * files sent mail in the same mailbox, or the association's address
       * subscribed to a list it also writes to. Collecting one of those would
       * open a thread in which the board appears to have been written to by
       * itself, and would put its own words back on the screen as a fresh
       * question.
       *
       * Recognised by the identifier this instance gave the reply, and by
       * saying what the reply said - the identifier alone is known to everybody
       * the board has answered. Anything we did not send is not matched by this
       * and is collected normally.
       */
      await this.holdOwnAnswer(own, uid, letterDate);
      return "already-held";
    }

    if (parsed.fromAddress === null) {
      /*
       * A letter the board could not answer if it wanted to.
       *
       * Left in the mailbox rather than stored without an address, which keeps
       * the correspondent column meaning what it says: every thread in this
       * table can be replied to. A message with no readable From header is
       * malformed to the point where there is nothing to reply to, and it is
       * still in the mailbox for a board member to look at.
       */
      this.logger.warn(
        "Board mailbox: a message carried no usable sender address and was left in the mailbox.",
      );
      // Recorded as read, because no later run will read it differently: the
      // bytes in the mailbox do not change, and a letter fetched afresh every
      // five minutes for nothing is what spends the per-run bound that the mail
      // behind it needs.
      await this.setAside(
        uid,
        COLLECTION_REFUSALS.noSenderAddress,
        letterDate,
        null,
      );
      return "skipped";
    }

    const address = await this.encryption.encrypt(
      "boardMailboxThread.correspondentEmail",
      parsed.fromAddress,
    );
    /*
     * The same address indexed a second time, under the register's own field
     * label, because that is the only form in which the register can be asked
     * about it: CipherSweet derives a distinct key per table and field, so the
     * index stored on a thread and the index stored on a person are not
     * comparable values.
     */
    const personEmailIndex = await this.encryption.computeIndex(
      "person.email",
      parsed.fromAddress,
    );

    const occurredAt = trustedDate(parsed.date, parsed.receivedAt, now);
    if (
      occurredAt.getTime() <= boardMailboxPurgeCutoff(now).getTime() &&
      !(await this.purge.withholds(address.index))
    ) {
      /*
       * A letter already past the retention window when it is first read.
       *
       * The date is the one the thread would be anchored on, so storing it
       * would keep a letter the purge is due to erase that night. Not stored,
       * and recorded as read: time only moves one way, so no later run will
       * judge it differently.
       *
       * Which is a letter the mailbox received before the window, and not one
       * its sender only dated so: the date is held to the mailbox's own record
       * of receiving it (see trustedDate). That is what makes it safe to leave
       * these off the board's screen - they are a mailbox's old mail, read for
       * the first time, and not something sent to the board this week.
       *
       * Unless a legal hold or a restriction of processing stands against the
       * address. The purge keeps that person's correspondence past its window,
       * so a letter left here would be missing from the very record the hold
       * or the restriction was placed to preserve - evidence the association
       * was told to keep, or data it was asked not to erase. Asked here, after
       * the address is indexed, because the purge matches on nothing else.
       */
      this.logger.warn(
        "Board mailbox: a message dated before the retention window was left in the mailbox.",
      );
      await this.setAside(
        uid,
        COLLECTION_REFUSALS.pastRetention,
        letterDate,
        null,
      );
      return "skipped";
    }

    const name =
      parsed.fromName === null
        ? null
        : await this.encryption.encrypt(
            "boardMailboxThread.correspondentName",
            parsed.fromName,
          );

    /*
     * The files are stored before the rows that point at them.
     *
     * That ordering makes the letter atomic: the thread, the message and its
     * attachment rows all commit together or none of them do, so the board never
     * sees a message that says nothing about files that did arrive. A letter
     * whose rows do not commit takes back out the files no row names, so a
     * refused or retried letter leaves no object behind; what remains is
     * the process dying in between, which is the failure the media layer already
     * tolerates in the other direction and states it prefers: an orphan object,
     * never an orphan row.
     */
    let stored: readonly { id: string }[] = [];
    try {
      stored = await this.storeAttachments(parsed.attachments);

      await this.prisma.$transaction(async (tx) => {
        const threadId = await this.threadFor(tx, {
          inReplyTo: parsed.inReplyTo,
          emailIndex: address.index,
          personEmailIndex,
          emailCipher: address.cipher,
          nameCipher: name?.cipher ?? null,
          subject: parsed.subject,
          occurredAt,
        });

        const message = await tx.boardMailboxMessage.create({
          data: {
            threadId,
            direction: "INBOUND",
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            sourceUid: uid,
            // Bounded by the reader, which is also what knows whether it cut.
            body: parsed.text,
            bodyFromHtml: parsed.textFromHtml,
            bodyTruncated: parsed.textTruncated,
            attachmentsDropped: parsed.attachments.length - stored.length,
            occurredAt,
          },
          select: { id: true },
        });

        if (stored.length > 0) {
          await tx.boardMailboxAttachment.createMany({
            data: stored.map((file, position) => ({
              messageId: message.id,
              fileId: file.id,
              sortOrder: position,
            })),
          });
        }

        // Stored, so whatever earlier runs counted against it no longer counts,
        // and a letter set aside earlier is no longer set aside - whether this
        // run was retrying it or another collection set it aside meanwhile.
        // Not a row the purge or the retention window wrote: see
        // forgetStoredSetAside.
        await tx.boardMailboxCollectionFailure.deleteMany({
          where: { sourceUid: uid },
        });
        await tx.boardMailboxIgnoredMessage.deleteMany({
          where: { sourceUid: uid, reason: { in: [...LISTED_REFUSALS] } },
        });
      });
    } catch (error) {
      await this.discardUnnamedFiles(stored);

      if (isUniqueViolation(error) || (await this.storedAfterAll(uid))) {
        // Another collection stored this letter between the query above and this
        // insert. The constraint is what makes that harmless rather than a race
        // the board would see as a duplicate.
        // The other collection may not have known it was set aside, and a
        // stored letter must not go on being listed as one.
        await this.forgetStoredSetAside([uid]);
        return "already-held";
      }
      if (isDataRefusal(error)) {
        /*
         * The database refused this letter as it was read.
         *
         * Set aside rather than thrown. Nothing is deleted from the mailbox, so
         * a letter that stopped the run would stop every run after it at the
         * same place, and the board would receive nothing from then on. Recorded
         * as read because the bytes do not change and neither would the answer;
         * the letter is still in the mailbox for a board member to open, and
         * the board's screen says so.
         */
        this.logger.error(
          `Board mailbox: a message could not be stored and was set aside: ${failureName(error)}`,
        );
        await this.setAside(
          uid,
          COLLECTION_REFUSALS.unstorable,
          letterDate,
          null,
        );
        return "skipped";
      }

      /*
       * Nothing the letter is known to be at fault for: the next run tries it
       * again, and the letters behind it are still tried by this one. Counted,
       * so a letter that fails on every run is set aside in the end rather
       * than retried unseen for as long as the mailbox keeps it - and set aside
       * until a later try, not for good, because an instance that failed every
       * letter for an hour fails them all alike. A letter that was already set
       * aside and failed its later try waits as long again.
       */
      if (retrying || (await this.countFailure(uid, now))) {
        this.logger.error(
          `Board mailbox: a message failed to be stored on every attempt and was set aside: ${failureName(error)}`,
        );
        await this.setAside(
          uid,
          COLLECTION_REFUSALS.unstorable,
          letterDate,
          new Date(now.getTime() + SET_ASIDE_RETRY_MS),
        );
      } else {
        this.logger.error(
          `Board mailbox: a message could not be stored this time: ${failureName(error)}`,
        );
      }
      return "skipped";
    }

    return "collected";
  }

  /**
   * The thread this message belongs on, creating one when it opens a
   * conversation.
   *
   * A message joins an existing thread only when BOTH its In-Reply-To names
   * one of the board's own answers on that thread AND it comes from the address
   * the thread is with (GLOSSARY, tråd). The second condition is the one that matters: a Message-ID travels in
   * every copy of a letter and in every reply to it, so anybody who has ever
   * been on one of these conversations - or who guesses one - could otherwise
   * post into a thread the board is having with somebody else, and the board
   * would read it as that person's words.
   *
   * Threading is never decided by the subject line. Two strangers writing
   * "Fraga om balkongen" in the same month is ordinary, and merging them would
   * show each of them the other's letter the moment the board replied.
   */
  private async threadFor(
    tx: Prisma.TransactionClient,
    input: {
      inReplyTo: string | null;
      emailIndex: string | null;
      personEmailIndex: string | null;
      emailCipher: string;
      nameCipher: string | null;
      subject: string;
      occurredAt: Date;
    },
  ): Promise<string> {
    if (input.inReplyTo !== null && input.emailIndex !== null) {
      const answered = await tx.boardMailboxMessage.findFirst({
        where: {
          messageId: input.inReplyTo,
          // One of the board's own answers. Every other identifier on a thread
          // was written by somebody outside the association, and a letter's
          // own Message-ID travels to everyone it was sent to.
          direction: "OUTBOUND",
          thread: { correspondentEmailIndex: input.emailIndex },
        },
        select: { threadId: true },
        orderBy: { occurredAt: "desc" },
      });

      if (answered !== null) {
        // Locked before it is read, as every act on a thread's state is: the
        // status written below is decided from the one read here.
        await lockThread(tx, answered.threadId);
        const thread = await tx.boardMailboxThread.findUnique({
          where: { id: answered.threadId },
          select: {
            id: true,
            status: true,
            takenByPersonId: true,
          },
        });
        if (thread !== null) {
          await tx.boardMailboxThread.update({
            where: { id: thread.id },
            data: {
              /*
               * A conversation the board thought was over is open again.
               *
               * Back to whoever had it, when somebody had it: the board member
               * who answered this correspondent is who the follow-up is for, and
               * putting it back in the unclaimed pile would lose that. A thread
               * nobody held goes back to nobody, so it is offered to every seat -
               * which is what NEW means.
               */
              status:
                thread.status === "ANSWERED" || thread.status === "CLOSED"
                  ? thread.takenByPersonId === null
                    ? "NEW"
                    : "TAKEN"
                  : undefined,
              closedAt: null,
              closedByPersonId: null,
            },
          });
          /*
           * The retention anchor moves forward only. A reply's date is the
           * sender's Date header wherever it lies within a day of the mailbox
           * receiving it (see trustedDate), and its own date where nothing
           * says when it arrived - so it can still be dated before the last
           * thing said on the thread: a client whose clock is a few hours
           * behind, an answer sent while the reply was on its way, a letter
           * filed into the mailbox by hand. It is still a message on a live
           * conversation. Taking its date would put the whole thread back to
           * that day and hand it to the purge while it was still running.
           *
           * The comparison is in the statement rather than read first and
           * written after, so a reply collected at the same moment cannot
           * interleave with this one and leave the older date on the row:
           * Postgres checks the condition again against the row it locks.
           */
          await tx.boardMailboxThread.updateMany({
            where: { id: thread.id, lastMessageAt: { lt: input.occurredAt } },
            data: { lastMessageAt: input.occurredAt },
          });
          return thread.id;
        }
      }
    }

    const created = await tx.boardMailboxThread.create({
      data: {
        subject: input.subject.slice(0, MAX_SUBJECT_CHARACTERS),
        correspondentEmailCipher: input.emailCipher,
        correspondentEmailIndex: input.emailIndex,
        correspondentNameCipher: input.nameCipher,
        /*
         * Asked once, here, and never again: the answer is who held the address
         * when the letter arrived, and a thread that later gained a link, or
         * lost one, would be answering about a register that has moved on. A
         * reply joining the thread above does not revisit it for the same
         * reason.
         */
        correspondentPersonId: await this.identifiedCorrespondent(
          tx,
          input.personEmailIndex,
        ),
        lastMessageAt: input.occurredAt,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * The person in the register this address belonged to, where exactly one did.
   *
   * Not attribution and not a check on the sender: anybody can put anybody's
   * address in a From header, and this answers a narrower question the
   * association is obliged to answer anyway - whose data subject access report
   * this letter belongs in. That report is a disclosure, so the only safe
   * answer is an unambiguous one.
   *
   * Two rows are read rather than one, because everything turns on whether a
   * second exists. `Person.emailIndex` is indexed and not unique, and a
   * household that gave the association one address is the ordinary way it comes
   * to be held twice; reporting such a thread to either resident would hand each
   * of them the other's correspondence with the board. Two holders, none, or an
   * address the register never held all answer the same way: nobody, and a
   * thread nobody was established to be is in no automatic disclosure.
   */
  private async identifiedCorrespondent(
    tx: Prisma.TransactionClient,
    personEmailIndex: string | null,
  ): Promise<string | null> {
    if (personEmailIndex === null) {
      return null;
    }

    const persons = await tx.person.findMany({
      where: { emailIndex: personEmailIndex },
      select: { id: true },
      take: 2,
    });

    return persons.length === 1 ? (persons[0]?.id ?? null) : null;
  }

  /**
   * The attachments this instance is willing to keep.
   *
   * Every one goes through the ordinary upload path, so it is identified from
   * its own bytes rather than from the type the sender declared - which is the
   * whole reason a message claiming a PDF and carrying something else is refused
   * here rather than trusted. A file the path will not take is dropped and
   * counted; the count is on the message, because a board reading "see the
   * attached" with nothing attached must be able to tell a sender's mistake from
   * this instance's refusal.
   *
   * Recorded INTERNAL and declared as showing identifiable persons, on the issue
   * photograph's argument in full: nobody knows whether a photograph somebody
   * mailed the board caught a neighbour in it, an attachment here is never
   * published, and the declaration is the input the publication guardrails need.
   * It names `boardMailbox:handle` as its required capability, which
   * `MediaService.open` checks on every read: whoever handles the board's mail
   * reads it, and nobody else does, whether or not they have its identifier.
   */
  private async storeAttachments(
    attachments: readonly MimeAttachment[],
  ): Promise<readonly { id: string }[]> {
    const stored: { id: string }[] = [];

    try {
      for (const attachment of attachments.slice(
        0,
        MAX_ATTACHMENTS_PER_MESSAGE,
      )) {
        const file = await this.upload(attachment);
        if (file !== null) {
          stored.push(file);
        }
      }
    } catch (error) {
      // The files already stored go with the letter, which is tried again.
      await this.discardFiles(stored);
      throw error;
    }

    return stored;
  }

  private async upload(
    attachment: MimeAttachment,
  ): Promise<{ id: string } | null> {
    for (const accept of ["image", "document"] as const) {
      try {
        return await this.media.upload({
          bytes: attachment.bytes,
          fileName: attachment.fileName,
          accept,
          visibility: "INTERNAL",
          // Letters to the board are read by whoever handles its mail.
          requiredCapability: "boardMailbox:handle",
          showsIdentifiablePersons: accept === "image" ? true : undefined,
          uploadedByPersonId: null,
          // The collector is a job: no person asked for this file to be stored.
          channel: "SYSTEM",
          // Nor is the name in the audit log: it is a stranger's words, and a
          // letter retried for an hour would write it there a dozen times over.
          recordFileName: false,
        });
      } catch (error) {
        if (!(error instanceof MediaError)) {
          /*
           * Not a refusal of this file: storage that did not answer, a database
           * that did not take the row. Thrown, so the letter is tried again with
           * its files on the next run, rather than stored for good without one
           * the next run would have kept.
           */
          throw error;
        }
        if (error.reason === "unsupported-type") {
          // The other kind, then. The two accept lists are disjoint, so trying
          // both is how a message carrying a PDF and a photograph keeps them
          // both without the sender's declared type being consulted.
          continue;
        }
        // The media layer refused the file itself - an empty one, say - and
        // would refuse it again on every run. The attachment is lost and the
        // letter kept; the count on the message is what tells the board.
        this.logger.warn(
          `Board mailbox: an attachment was not stored: ${failureName(error)}`,
        );
        return null;
      }
    }
    return null;
  }
}

/**
 * The longest subject line this module keeps.
 *
 * A subject is a header the sender composes and nothing bounds it at the far
 * end. It is shown in a list, so a letter with a paragraph in its subject line
 * would push every other thread off the screen.
 */
const MAX_SUBJECT_CHARACTERS = 300;

/**
 * When a message happened, as far as this instance is prepared to believe.
 *
 * A Date header is the sender's clock. It is used because it is nearly always
 * right and is what a board expects to see, and it is bounded because it orders
 * the inbox and anchors the retention window: a letter dated next year would sit
 * at the top of the board's screen until next year, and one dated 1970 would be
 * erasable the moment it arrived.
 *
 * Bounded on both sides by the moment the mailbox received the letter, where
 * its Received header says. That is the mailbox provider's clock rather than
 * the sender's, and it is what decides whether a letter is already past the
 * retention window: without it, a letter from a device whose clock is years
 * behind - or from somebody who set the header so - would be read as one the
 * window had already closed on, and never reach the board. A letter that sat
 * in an outbox for a week is dated by its arrival, which is when the board
 * could first have read it.
 *
 * A message with no Received header did not reach the mailbox through a mail
 * server - it was filed or imported there by whoever holds the mailbox - so a
 * stranger did not put it there, and its own date stands.
 *
 * @param received When the mailbox received the letter, by its Received
 *   header, or null.
 */
function trustedDate(
  claimed: Date | null,
  received: Date | null,
  now: Date,
): Date {
  const written = believedDate(claimed, now);
  const receipt = believedDate(received, now);
  if (receipt === null) {
    return written ?? now;
  }
  if (
    written === null ||
    Math.abs(written.getTime() - receipt.getTime()) > MAX_CLOCK_SKEW_MS
  ) {
    return receipt;
  }
  return written;
}

/** The sender's date where it is believed, and null where it is not. */
function believedDate(claimed: Date | null, now: Date): Date | null {
  if (claimed === null) {
    return null;
  }
  const skew = claimed.getTime() - now.getTime();
  if (skew > MAX_CLOCK_SKEW_MS || claimed.getTime() < EARLIEST_PLAUSIBLE) {
    return null;
  }
  return claimed;
}

/**
 * Whether a letter says what an answer says, as this instance renders it.
 *
 * Its subject, and every form of its text: the body the reader chose and each
 * alternative beside it, so that a letter cannot put the answer where this
 * module reads and something else where a mail client shows it. Each form is
 * held to the answer's form of the same kind, read as the reader reads a
 * letter - a copy that kept only its HTML is read from that. Plain text is
 * compared by its words. HTML is compared as HTML, because its words are not
 * all a client shows: a picture, or text a style sheet writes, says something
 * no word of it does. A form that says nothing is held to the answer all the
 * same, since a client may show what it does say. Compared with the whitespace
 * folded, which is what a transfer encoding and a client's line wrapping
 * change, and nothing else is forgiven: a word or a tag added anywhere is a
 * letter.
 *
 * A form the reader cut matches only an answer the reader cuts at the same
 * place, which is an answer longer than the reader keeps of any letter: as long
 * as the board may write, with its greeting and closing line. A copy of it is
 * always read cut, and what lies past the cut would not have been on the
 * board's screen either, only the notice that the letter went on. A short
 * answer and a cut letter are never the same, whatever the letter keeps of it
 * before the cut.
 */
function saysTheSame(letter: ParsedMessage, answer: RenderedMail): boolean {
  const folded = (value: string | null): string | null =>
    value === null ? null : value.replaceAll(/\s+/g, " ").trim();
  const text = readBody(answer.text, false);
  const html = readBody(answer.html, true);
  const matches = (form: ReadText): boolean => {
    const meant = form.fromHtml ? html : text;
    return (
      form.truncated === meant.truncated &&
      folded(form.text) === folded(meant.text) &&
      folded(form.html) === folded(meant.html)
    );
  };
  return (
    folded(letter.subject) === folded(answer.subject) &&
    matches({
      text: letter.text,
      truncated: letter.textTruncated,
      fromHtml: letter.textFromHtml,
      html: letter.textHtml,
    }) &&
    letter.alternatives.every(matches)
  );
}

/**
 * Before this, a Date header is not a clock that is wrong but a value that is
 * not a date at all. 1990 is comfortably before electronic mail reached a
 * Swedish housing cooperative and comfortably after the epoch a broken client
 * defaults to.
 */
const EARLIEST_PLAUSIBLE = Date.UTC(1990, 0, 1);
