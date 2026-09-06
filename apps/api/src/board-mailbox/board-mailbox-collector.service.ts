import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MediaError, MediaService } from "../media/media.service";
import { BoardMailboxError } from "./board-mailbox.error";
import { COLLECTION_REFUSALS } from "./board-mailbox-delivery";
import {
  loadBoardMailboxSettings,
  mailboxFingerprint,
} from "./board-mailbox-settings";
import { type MimeAttachment, readMessage } from "./mime";
import { openPop3Session, Pop3Error, type Pop3Listing } from "./pop3";

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
const MAX_MESSAGES_PER_COLLECTION = 50;

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
 * How much of one letter is stored.
 *
 * Long enough for anything a person writes to their board, and short enough that
 * a machine-generated message with a megabyte of quoted history does not become
 * a row nothing can render. What is cut is recorded on the message, so the board
 * is told it is reading part of a letter rather than shown a truncated one that
 * reads as complete.
 */
const MAX_BODY_CHARACTERS = 20_000;

/**
 * How far ahead of this instance's clock a sender's Date header may be.
 *
 * The header is the sender's own clock and this module orders a thread by it, so
 * a message dated next year would sit at the top of the board's inbox for a year
 * and a thread's retention would not start running. A date outside the window is
 * replaced by the moment of collection, which is a fact this instance owns.
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
   * Messages left where they are: too large, or carrying no address the board
   * could answer.
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
      const held = await this.heldUids(listings, prefix);

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
        );
        if (stored === "collected") {
          collected += 1;
        } else if (stored === "already-held") {
          alreadyHeld += 1;
        } else {
          skipped += 1;
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
   */
  private async ownAnswerId(messageId: string | null): Promise<string | null> {
    if (messageId === null) {
      return null;
    }
    const own = await this.prisma.boardMailboxMessage.findFirst({
      where: { messageId, direction: "OUTBOUND" },
      select: { id: true },
    });
    return own?.id ?? null;
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
   */
  private async holdOwnAnswer(id: string, uid: string): Promise<void> {
    try {
      await this.prisma.boardMailboxMessage.updateMany({
        where: { id, sourceUid: null },
        data: { sourceUid: uid },
      });
    } catch (error) {
      this.logger.warn(
        `Board mailbox: an answer of this instance's own could not be marked as held: ${failureName(error)}`,
      );
    }
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
  ): Promise<ReadonlySet<string>> {
    if (listings.length === 0) {
      return new Set();
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
        select: { sourceUid: true },
      }),
    ]);

    return new Set([
      ...stored
        .map((row) => row.sourceUid)
        .filter((uid): uid is string => uid !== null),
      ...ignored.map((row) => row.sourceUid),
    ]);
  }

  /**
   * Records that a message was read and will not be stored.
   *
   * Which is what stops it being fetched again. Without it a letter the
   * collector can do nothing with is read in full on every run for as long as
   * the mailbox keeps it, and - since the per-run bound counts fetches - enough
   * of them at the head of the mailbox stop the collection before it reaches the
   * mail behind them, so the board goes on receiving nothing while the mailbox
   * fills.
   *
   * Written only for a refusal that cannot change its mind. `createMany` with
   * `skipDuplicates`, so two runs that read the same letter do not fight over
   * it, and a write that does not land is logged rather than raised: the letter
   * stays in the mailbox either way, which is where it was.
   */
  private async ignoreMessage(uid: string, reason: string): Promise<void> {
    try {
      await this.prisma.boardMailboxIgnoredMessage.createMany({
        data: [{ sourceUid: uid, reason }],
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.warn(
        `Board mailbox: a message that cannot be stored could not be marked as read: ${failureName(error)}`,
      );
    }
  }

  /** One letter: fetch it, read it, store it. */
  private async collectOne(
    retrieve: (number: number, maxBytes: number) => Promise<Buffer>,
    listing: Pop3Listing,
    uid: string,
    now: Date,
  ): Promise<"collected" | "already-held" | "skipped"> {
    let raw: Buffer;
    try {
      raw = await retrieve(listing.number, MAX_MESSAGE_BYTES);
    } catch (error) {
      // One message that cannot be fetched must not stop the ones behind it.
      // It stays in the mailbox and the next run tries again.
      this.logger.error(
        `Board mailbox: a message could not be retrieved: ${failureName(error)}`,
      );
      return "skipped";
    }

    const parsed = readMessage(raw);

    const own = await this.ownAnswerId(parsed.messageId);
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
       * Recognised by the identifier this instance generated when it wrote the
       * reply, which is the only part of the message that is certainly ours -
       * the envelope sender is the mail server's and the body has been through a
       * relay. Anything we did not send is not matched by this and is collected
       * normally.
       */
      await this.holdOwnAnswer(own, uid);
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
      await this.ignoreMessage(uid, COLLECTION_REFUSALS.noSenderAddress);
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
     * sees a message that says nothing about files that did arrive. What it
     * risks instead is a stored file no row names, if the process dies in
     * between - which is the failure the media layer already tolerates in the
     * other direction and states it prefers: an orphan object, never an orphan
     * row.
     */
    const stored = await this.storeAttachments(parsed.attachments);

    const occurredAt = trustedDate(parsed.date, now);
    const body = parsed.text.slice(0, MAX_BODY_CHARACTERS);

    try {
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
            body,
            bodyFromHtml: parsed.textFromHtml,
            bodyTruncated: parsed.text.length > MAX_BODY_CHARACTERS,
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
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another collection stored this letter between the query above and this
        // insert. The constraint is what makes that harmless rather than a race
        // the board would see as a duplicate.
        return "already-held";
      }
      throw error;
    }

    return "collected";
  }

  /**
   * The thread this message belongs on, creating one when it opens a
   * conversation.
   *
   * A message joins an existing thread only when BOTH its In-Reply-To names a
   * message already on that thread AND it comes from the address the thread is
   * with. The second condition is the one that matters: a Message-ID travels in
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
          thread: { correspondentEmailIndex: input.emailIndex },
        },
        select: { threadId: true },
        orderBy: { occurredAt: "desc" },
      });

      if (answered !== null) {
        const thread = await tx.boardMailboxThread.findUnique({
          where: { id: answered.threadId },
          select: { id: true, status: true, takenByPersonId: true },
        });
        if (thread !== null) {
          await tx.boardMailboxThread.update({
            where: { id: thread.id },
            data: {
              lastMessageAt: input.occurredAt,
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
   * It carries no required capability for the reason that file does not - what
   * keeps it private is that nothing hands out its identifier except a thread
   * payload, and those are behind `boardMailbox:handle`.
   */
  private async storeAttachments(
    attachments: readonly MimeAttachment[],
  ): Promise<readonly { id: string }[]> {
    const stored: { id: string }[] = [];

    for (const attachment of attachments.slice(
      0,
      MAX_ATTACHMENTS_PER_MESSAGE,
    )) {
      const file = await this.upload(attachment);
      if (file !== null) {
        stored.push(file);
      }
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
          showsIdentifiablePersons: accept === "image" ? true : undefined,
          uploadedByPersonId: null,
        });
      } catch (error) {
        if (
          error instanceof MediaError &&
          error.reason === "unsupported-type"
        ) {
          // The other kind, then. The two accept lists are disjoint, so trying
          // both is how a message carrying a PDF and a photograph keeps them
          // both without the sender's declared type being consulted.
          continue;
        }
        // Anything else - a file too large for the instance, storage that would
        // not take it - loses this attachment and keeps the letter. The count on
        // the message is what tells the board.
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
 */
function trustedDate(claimed: Date | null, now: Date): Date {
  if (claimed === null) {
    return now;
  }
  const skew = claimed.getTime() - now.getTime();
  if (skew > MAX_CLOCK_SKEW_MS || claimed.getTime() < EARLIEST_PLAUSIBLE) {
    return now;
  }
  return claimed;
}

/**
 * Before this, a Date header is not a clock that is wrong but a value that is
 * not a date at all. 1990 is comfortably before electronic mail reached a
 * Swedish housing cooperative and comfortably after the epoch a broken client
 * defaults to.
 */
const EARLIEST_PLAUSIBLE = Date.UTC(1990, 0, 1);

/** Whether a database failure is the unique constraint on the source identifier. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
