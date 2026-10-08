import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { localDayOf, scanForPersonalIdentityNumbers } from "@openbrf/shared";

import type { ActorContext } from "../audit/actor-context";
import { auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { residencyHeldOn } from "../registers/held-on";
import {
  isTextBlock,
  type PageContent,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import { isSlugShaped } from "../site/pages.service";
import {
  identityNumbersInBody,
  type PageTextLocation,
} from "../site/pages-write.service";
import {
  olderThan,
  parseThreadCursor,
  threadCursor,
} from "./news-comment.service";
import { DELIVERY_FAILURES } from "./news-delivery";
import { NewsMailerService } from "./news-mailer.service";
import { NewsSmsService } from "./news-sms.service";

/**
 * Where in a news item a refused value sits.
 *
 * The page's own type, deliberately, and not a copy of it. A refusal names a
 * position and a field and never the value that was found: the thing the scan
 * caught is precisely the thing that must not travel back in a response body,
 * into a log, or onto a screen somebody else is looking at.
 */
export type NewsTextLocation = PageTextLocation;

export type NewsWriteReason =
  | "not-found"
  | "invalid-slug"
  | "slug-taken"
  | "address-mailed"
  /** The email mailing this item was asked for has already gone out. */
  | "already-mailed"
  | "personal-identity-number"
  | "unsupported-block"
  /** Somebody else saved the item after the caller read it. */
  | "news-changed"
  /**
   * Comments stand under the item. They are erased by their own purge, never
   * with the item, so it can be taken down but not removed until they are gone.
   */
  | "has-comments";

export class NewsWriteError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: NewsWriteReason,
    private readonly found: {
      locations?: readonly NewsTextLocation[];
      blocks?: readonly number[];
    } = {},
  ) {
    super(message);
    this.status =
      reason === "not-found"
        ? HttpStatus.NOT_FOUND
        : // A conflict rather than a refusal on the merits, as for a page:
          // somebody else wrote first, and the caller reads the item again.
          reason === "slug-taken" || reason === "news-changed"
          ? HttpStatus.CONFLICT
          : reason === "invalid-slug"
            ? HttpStatus.BAD_REQUEST
            : // Understood and refused on its merits: this news item may not be
              // published as it stands, and the board is told which part to
              // change.
              HttpStatus.UNPROCESSABLE_ENTITY;
  }

  override details(): Record<string, readonly unknown[]> {
    return {
      locations: this.found.locations ?? [],
      blocks: this.found.blocks ?? [],
    };
  }
}

/** How one channel of a mailing is going, as the board's screen reports it. */
export interface NewsDeliveryReport {
  /** Claimed at publish and not yet handed to a provider. */
  pending: number;
  sent: number;
  failed: number;
  /**
   * That at least one delivery failed because this instance has no provider for
   * that channel - no mail server, or no SMS provider. The news item is
   * published either way; only that channel failed, and that distinction is the
   * whole of what the screen has to say about it.
   */
  notConfigured: boolean;
}

/**
 * How a mailing is going, per channel.
 *
 * Two reports rather than one total, because the two channels succeed and fail
 * independently: an association with no SMS provider still mails its members,
 * and a board looking at a column of failures has to be able to see which post
 * it was that did not go out.
 */
export interface NewsMailingReport {
  email: NewsDeliveryReport;
  sms: NewsDeliveryReport;
}

/** A news item as the board's own screen shows it: drafts included. */
export interface NewsAdminView {
  id: string;
  slug: string;
  title: string;
  content: PageContent;
  visibility: PageVisibility;
  published: boolean;
  /** ISO instant, or null while it has never been published. */
  publishedAt: string | null;
  /**
   * ISO instant the mailing was claimed, or null: this item has not been
   * mailed and, if it is ever published with the mailing asked for, will be
   * mailed exactly once.
   */
  emailQueuedAt: string | null;
  /**
   * ISO instant the SMS mailing was claimed, or null. Claimed separately from
   * the email one: a board that published without texting can still decide to,
   * and one that has texted cannot do it twice.
   */
  smsQueuedAt: string | null;
  delivery: NewsMailingReport;
  /**
   * Whether something that may not mail the members has asked for this item to
   * be mailed.
   *
   * A boolean and not a person: who asked is in the audit entry and reaches no
   * screen. The board is answering "should this go out", and naming the
   * requester would invite them to answer "who asked" instead.
   */
  mailingRequested: boolean;
  /**
   * What this copy of the item is, for a caller that means to write it back
   * as `expectedRevision`. It is not a version anybody displays.
   */
  revision: number;
  updatedAt: string;
}

export interface NewsInput {
  slug: string;
  title: string;
  content: PageContent;
}

/** What an ordinary save carries beyond the item's words. */
export interface UpdateNewsInput extends NewsInput {
  /**
   * The item's `revision` as the caller last read it, and the save is refused
   * with `news-changed` if somebody else has saved since.
   *
   * Optional, as it is on a page, and absent means write: a caller written
   * before the field existed keeps working rather than failing on a
   * precondition it does not know about.
   */
  expectedRevision?: number;
}

/** What writing a new item needs beyond an ordinary save. */
export interface CreateNewsInput extends NewsInput {
  /**
   * Who wrote it.
   *
   * Captured here because it is only knowable while it is being written: an
   * item somebody else corrects afterwards is still the work of the person who
   * wrote it, and no later save could tell us which of them that was.
   */
  authorPersonId: string;
}

export interface PublishNewsInput {
  published: boolean;
  /** Who it is for. Unchanged when omitted. */
  visibility?: PageVisibility;
  /** Whether to mail the members. Ignored on anything but a first mailing. */
  sendEmail?: boolean;
  /**
   * Whether to text the members. Ignored on anything but a first SMS mailing.
   *
   * Off unless the board asks, unlike the email, and the difference is what the
   * two cost. An email costs nothing and reaches everyone in the register with
   * an address; a text message is billed per member and reaches only those who
   * have given the association a number, so it is a decision rather than a
   * default.
   */
  sendSms?: boolean;
}

/**
 * A news item without its body.
 *
 * `mailingRequested` rather than who asked: the person is in the audit entry,
 * and no screen and no caller is told which of them placed the request.
 */
export interface NewsSummary {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  visibility: PageVisibility;
  publishedAt: string | null;
  updatedAt: string;
  mailingRequested: boolean;
}

export interface PublishNewsResult extends NewsAdminView {
  /**
   * How many members the mailing was claimed for, or null when this publish
   * claimed no mailing - because the board did not ask for one, because one has
   * already been claimed, or because the item was taken down rather than put up.
   */
  mailedTo: number | null;
  /**
   * How many members the SMS mailing was claimed for, on the same terms.
   *
   * Its own count rather than the same one, because the two audiences are not
   * the same people: the association can email everyone whose address it holds
   * and text only those who gave it a number.
   */
  textedTo: number | null;
}

const NEWS_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  content: true,
  visibility: true,
  published: true,
  publishedAt: true,
  emailQueuedAt: true,
  smsQueuedAt: true,
  mailingRequestedAt: true,
  revision: true,
  updatedAt: true,
} as const;

/**
 * The board's side of the association's news: writing it, publishing it, and
 * sending it to the members exactly once by each channel they asked for.
 *
 * Two rules live here and nowhere else.
 *
 * **A news item is prose.** Its body is the same block list a page stores, read
 * by the same parser, and narrowed to paragraphs and headings: a picture or a
 * block that reads something else out of the database is refused on the way in.
 * An announcement is not a page layout, and a data block on one would be a
 * second place where what the website discloses is decided.
 *
 * **A personal identity number is refused.** Whenever a write leaves an item
 * readable - editing one that is published, or publishing one - every piece of
 * text on it is scanned and a hit refuses the write, naming the block and the
 * offset but never the value. A draft is not scanned, for the reason a draft
 * page is not: half-written text is where somebody pastes an email to tidy up
 * later, and refusing to save it only teaches them to write elsewhere.
 *
 * And one guarantee, which is why this service exists at all.
 *
 * **The members are reached exactly once, per channel.** Publishing with a
 * mailing asked for is one transaction that conditionally claims that channel's
 * column - `emailQueuedAt`, `smsQueuedAt` - while it is null, snapshots that
 * channel's recipients into the delivery ledger - whose (news, person, channel)
 * triple is unique - writes the audit entries, and enqueues the job through the
 * same transaction. Two concurrent publishes both run the claim; the second
 * finds the column set and claims nothing. No edit and no republish writes
 * either column, so re-sending on an edit is impossible rather than unlikely.
 * The worker then claims each ledger row before it sends it, so a retried job
 * reaches nobody twice.
 *
 * The two channels are two decisions and two claims on one row. A board that
 * emailed the members can still text them about the same notice, and a board
 * that has done both can do neither again: each update matches on its own
 * column alone, so asking for the channel still available never re-sends the
 * one that is not. Each channel then has its own job, its own retries and its
 * own dead letter, so an SMS provider that is down costs the mailing nothing.
 */
@Injectable()
export class NewsWriteService {
  private readonly logger = new Logger(NewsWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mailer: NewsMailerService,
    private readonly texter: NewsSmsService,
  ) {}

  /** Every news item, drafts included, newest first. */
  async list(): Promise<NewsAdminView[]> {
    const rows = await this.prisma.news.findMany({
      orderBy: [{ createdAt: "desc" }],
      select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
    });
    return rows.map((row) => toAdminView(row));
  }

  /**
   * A bounded page of news items, without their bodies.
   *
   * Its own method rather than a bound on `list()` above, for the reason the
   * pages have one: the board's screen shows every item, and this answers a
   * caller that may be a model reading into a context window. Summary rows, so
   * reading a body is a second, deliberate call.
   *
   * The cursor is the position of the last item returned rather than the item
   * itself, as a comment thread's is and for the same reason: a cursor naming a
   * row answers nothing once that row is gone, so a caller paging through while
   * somebody removed the item it stopped at was told the list had ended.
   */
  async listSummaries(options: {
    limit: number;
    cursor?: string | undefined;
    publishedOnly?: boolean | undefined;
  }): Promise<{ news: NewsSummary[]; nextCursor: string | null }> {
    const after =
      options.cursor === undefined ? null : parseThreadCursor(options.cursor);
    if (options.cursor !== undefined && after === null) {
      // Refused rather than read as the start of the list, which would hand
      // the caller the first items again as if they were the next ones.
      throw new NewsWriteError(
        "There is no such place in the list of news items. Start it again without a cursor.",
        "not-found",
      );
    }

    const rows = await this.prisma.news.findMany({
      where: {
        ...(options.publishedOnly === true ? { published: true } : {}),
        // Everything after that position in the order below, whether or not
        // the item that stood there still does.
        ...(after === null ? {} : olderThan(after)),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit + 1,
      select: {
        createdAt: true,
        id: true,
        slug: true,
        title: true,
        published: true,
        visibility: true,
        publishedAt: true,
        updatedAt: true,
        mailingRequestedAt: true,
      },
    });

    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      news: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        published: row.published,
        visibility: row.visibility,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        mailingRequested: row.mailingRequestedAt !== null,
      })),
      nextCursor:
        rows.length > options.limit && last !== undefined
          ? threadCursor(last)
          : null,
    };
  }

  async byId(id: string): Promise<NewsAdminView> {
    return toAdminView(await this.require(id));
  }

  /**
   * How many members a mailing would reach on each channel, right now.
   *
   * Shown beside the mailing toggles so the board knows what it is about to do,
   * and deliberately counts rather than lists: who the association's members
   * are is the register's answer to give, on the register's own screen and
   * under the register's own capability.
   *
   * Two counts, because they are not the same people. Every member with an
   * address can be emailed; only the members who have given the association a
   * number can be texted, and a board about to spend money on messages has to
   * be able to see the difference before it presses publish.
   */
  async recipientCounts(): Promise<{ email: number; sms: number }> {
    const now = new Date();
    const [email, sms] = await Promise.all([
      this.prisma.person.count({ where: recipientsWhere(now, "EMAIL") }),
      this.prisma.person.count({ where: recipientsWhere(now, "SMS") }),
    ]);
    return { email, sms };
  }

  /**
   * Writes a new item.
   *
   * Unpublished, always. It is written before it is meant to be read, and
   * publishing is a separate act with its own record in the audit log - which
   * is also why creating one runs no guardrail: nothing it holds is readable by
   * anyone yet.
   */
  async create(
    input: CreateNewsInput,
    actor: ActorContext,
  ): Promise<NewsAdminView> {
    await this.requireFreeSlug(input.slug, null);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.news.create({
        data: {
          slug: input.slug,
          title: input.title,
          content: asJson(onlyProse(input.content)),
          published: false,
          authorPersonId: input.authorPersonId,
        },
        select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
      });

      await this.audit.record(
        {
          action: "NEWS_CONTENT_CHANGED",
          ...auditActor(actor),
          targetKind: "news",
          targetId: created.id,
          context: {
            slug: created.slug,
            blockCount: onlyProse(input.content).blocks.length,
            published: false,
            created: true,
          },
        },
        tx,
      );

      return created;
    });

    return toAdminView(row);
  }

  /**
   * Rewrites an item's address, title and body.
   *
   * Not whether it is published, not who it is for, and above all not whether
   * it has been mailed. Correcting a spelling mistake in a published notice is
   * an ordinary save, and it must not be able to put the notice in anybody's
   * mailbox a second time - which here is not a rule to remember but a column
   * this method does not write.
   *
   * The address is the one thing a mailing settles. Once the members have been
   * written to, the link in that message is the only copy of the address they
   * have, and nothing on this instance would answer the old one afterwards: a
   * rename is refused rather than allowed to break it. Either channel settles
   * it, and a text message settles it harder - it is a bare link with no
   * sender to write back to and no thread to correct it in.
   */
  async update(
    id: string,
    input: UpdateNewsInput,
    actor: ActorContext,
  ): Promise<NewsAdminView> {
    const content = onlyProse(input.content);
    await this.requireFreeSlug(input.slug, id);

    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Decided on the item as it stands under the lock, not as it was read
       * before the transaction. A publish or a mailing landing in between
       * moves none of the revision, so the claim below would still match, and
       * a decision taken on the earlier read would write a personal identity
       * number into an item that had just become readable, or rename one
       * whose address had just gone out.
       */
      const news = await this.lockAndRead(tx, id);
      const addressSent =
        news.emailQueuedAt !== null || news.smsQueuedAt !== null;
      if (addressSent && input.slug !== news.slug) {
        throw new NewsWriteError(
          "The address was sent to the members and cannot be changed.",
          "address-mailed",
        );
      }
      if (news.published) {
        this.refusePersonalIdentityNumbers(input.title, content);
      }

      /*
       * Claimed against the copy the caller read, when they said which: one
       * conditional statement either matches the item as it still stands or
       * matches nothing, as a page save does. Without a revision it writes,
       * and the revision still moves, so a copy read before this save cannot
       * match afterwards.
       */
      const claimed = await tx.news.updateMany({
        where:
          input.expectedRevision === undefined
            ? { id }
            : { id, revision: input.expectedRevision },
        data: {
          slug: input.slug,
          title: input.title,
          content: asJson(content),
          revision: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new NewsWriteError(
          "The news item changed after it was read.",
          "news-changed",
        );
      }
      const updated = await tx.news.findUniqueOrThrow({
        where: { id },
        select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
      });

      await this.audit.record(
        {
          action: "NEWS_CONTENT_CHANGED",
          ...auditActor(actor),
          targetKind: "news",
          targetId: id,
          context: {
            slug: updated.slug,
            blockCount: content.blocks.length,
            published: updated.published,
          },
        },
        tx,
      );

      return updated;
    });

    return toAdminView(row);
  }

  /**
   * Records that a published news item should be mailed to the members.
   *
   * The whole point of the separation: something acting through a connected
   * app may write and publish a news item and may never mail anybody. An email
   * reaches every member whose address the association holds, it cannot be
   * recalled, and the mailing is claimed exactly once - so the decision to send
   * belongs to a person on a screen, every time.
   *
   * What this writes is the ask. A board member sees it on the item and
   * publishes with the mailing in the ordinary way, which is the path that
   * claims it.
   */
  async requestMailing(
    id: string,
    actor: ActorContext,
  ): Promise<{ requestedAt: string }> {
    const news = await this.require(id);
    if (news.emailQueuedAt !== null) {
      /*
       * Read from emailQueuedAt rather than from either column: the request is
       * for the email, so an item already texted to the members has still not
       * had the thing done that is being asked for.
       */
      throw new NewsWriteError(
        "The members have already been mailed about this item.",
        "already-mailed",
      );
    }

    const requestedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      /*
       * Conditional on the column still being null, so a second ask writes
       * nothing and the first asker stays the one on the record - and on the
       * mailing still being unsent, because the check above it ran before this
       * transaction. A publish landing in between claims the email and clears
       * the request, and without this condition the ask would be written back
       * afterwards: a request standing for an item the members have already
       * had, which is the one state the board can do nothing about.
       */
      const claimed = await tx.news.updateMany({
        where: { id, mailingRequestedAt: null, emailQueuedAt: null },
        data: {
          mailingRequestedAt: requestedAt,
          mailingRequestedByPersonId: actor.personId,
        },
      });

      if (claimed.count === 1) {
        await this.audit.record(
          {
            action: "NEWS_MAILING_REQUESTED",
            ...auditActor(actor),
            targetKind: "news",
            targetId: id,
            context: { slug: news.slug },
          },
          tx,
        );
      }

      const held = await tx.news.findUniqueOrThrow({
        where: { id },
        select: { mailingRequestedAt: true },
      });
      if (held.mailingRequestedAt === null) {
        /*
         * Nothing was claimed and nothing stands, which only a publish landing
         * in the window above can produce: it sends the mailing and clears the
         * request in one act. Answered with the refusal the check before the
         * transaction gives, because what was being asked for has happened -
         * reporting a request that was never written would be worse.
         */
        throw new NewsWriteError(
          "The members have already been mailed about this item.",
          "already-mailed",
        );
      }
      return { requestedAt: held.mailingRequestedAt.toISOString() };
    });
  }

  /** Clears a standing request, which is a board member deciding not to send. */
  async dismissMailingRequest(id: string, actor: ActorContext): Promise<void> {
    const news = await this.require(id);
    if (news.mailingRequestedAt === null) {
      return;
    }

    const standing = news.mailingRequestedAt;
    await this.prisma.$transaction(async (tx) => {
      /*
       * Conditional on the request still being the one that was read. A publish
       * landing in between answers the request by sending the mailing and
       * clears it, and an unconditional write would then record a board member
       * declining to send something that had just gone out. The entry is
       * written only where the clearing was this call's doing, because the
       * audit log is what the association answers with.
       */
      const cleared = await tx.news.updateMany({
        where: { id, mailingRequestedAt: standing },
        data: { mailingRequestedAt: null, mailingRequestedByPersonId: null },
      });
      if (cleared.count === 0) {
        return;
      }
      await this.audit.record(
        {
          action: "NEWS_MAILING_REQUEST_DISMISSED",
          ...auditActor(actor),
          targetKind: "news",
          targetId: id,
          context: { slug: news.slug },
        },
        tx,
      );
    });
  }

  /**
   * Publishes a news item, or takes it down, and mails the members once.
   *
   * Publication and audience are one decision rather than two routes, unlike a
   * page. A page has a standing audience that the board revisits; a news item
   * is published once, to the people it was written for, and saying who those
   * are in the same act is what puts the audience into the entry the audit log
   * keeps of the publication.
   *
   * The mailing is claimed inside this transaction and nowhere else. See the
   * class comment for why that is the whole of "exactly once".
   */
  async publish(
    id: string,
    input: PublishNewsInput,
    actor: ActorContext,
  ): Promise<PublishNewsResult> {
    /*
     * Whether this call is the mailing, and whether it is the SMS mailing.
     *
     * Only a publish sends, only when the board asked, and only while that
     * channel's column is still null. The last of the three is re-checked
     * inside the transaction by the claim itself.
     *
     * Two independent tests, because the two channels are two decisions. A
     * board that emailed the members in the morning may text them in the
     * afternoon about the same notice, and neither claim can be taken twice.
     */
    const sends = (news: {
      emailQueuedAt: Date | null;
      smsQueuedAt: Date | null;
    }) => ({
      mailing:
        input.published &&
        input.sendEmail === true &&
        news.emailQueuedAt === null,
      texting:
        input.published && input.sendSms === true && news.smsQueuedAt === null,
    });

    /*
     * A write that changes nothing writes nothing.
     *
     * Pressing publish on an item that is already published to the same people,
     * with neither mailing left to claim, is not an event and does not belong
     * in the audit log. The mailings are part of the test rather than an
     * afterthought: a board that published without sending and comes back to
     * press it again is asking for the one thing this call could still do.
     */
    const changesNothing = (news: {
      published: boolean;
      visibility: string;
      emailQueuedAt: Date | null;
      smsQueuedAt: Date | null;
    }): boolean => {
      const { mailing, texting } = sends(news);
      return (
        news.published === input.published &&
        news.visibility === (input.visibility ?? news.visibility) &&
        !mailing &&
        !texting
      );
    };

    /*
     * Read once before the transaction, so an ordinary republish does not open
     * one, and so the queues are created outside it: creating a queue is the
     * queue backend's own work on its own connection, and it has no business
     * inside somebody else's transaction. A channel's column is never cleared
     * once set, so this read can only ask for a queue the locked one below
     * turns out not to need, never miss one it does.
     */
    const before = await this.require(id);
    if (changesNothing(before)) {
      return { ...toAdminView(before), mailedTo: null, textedTo: null };
    }
    const planned = sends(before);
    if (planned.mailing) {
      await this.mailer.ensureQueues();
    }
    if (planned.texting) {
      await this.texter.ensureQueues();
    }

    const now = new Date();

    const { row, mailedTo, textedTo } = await this.prisma.$transaction(
      async (tx) => {
        /*
         * Everything below is decided on the item as it stands under the lock.
         * An edit landing after the read above changes the words this publish
         * would make readable, and the scan has to be of those words: the
         * earlier copy may have been clean while the current one is not.
         */
        const news = await this.lockAndRead(tx, id);
        const visibility = input.visibility ?? news.visibility;
        if (input.published) {
          this.refusePersonalIdentityNumbers(
            news.title,
            readNewsContent(news.content),
          );
        }
        if (changesNothing(news)) {
          return { row: news, mailedTo: null, textedTo: null };
        }
        const { mailing, texting } = sends(news);

        /*
         * The claims, and the only writers of these two columns in the codebase.
         *
         * Conditional on the column still being null, which the locked read
         * above already says, and which is kept so the guarantee does not rest
         * on a lock alone: this statement is what claims, and it cannot claim a
         * column that is set. Two publishes racing each other queue on the row;
         * the second reads the first's claim once it commits, so it claims no
         * mailing, writes no ledger and enqueues no job.
         *
         * One row, two columns, two conditions. A publish that claims the SMS
         * mailing cannot take the email one with it, and vice versa: each update
         * matches on its own column alone, so asking for the channel that is
         * still available never re-sends the one that is not.
         */
        const claimedEmail =
          mailing &&
          (
            await tx.news.updateMany({
              where: { id, emailQueuedAt: null },
              data: { emailQueuedAt: now },
            })
          ).count === 1;

        const claimedSms =
          texting &&
          (
            await tx.news.updateMany({
              where: { id, smsQueuedAt: null },
              data: { smsQueuedAt: now },
            })
          ).count === 1;

        const updated = await tx.news.update({
          where: { id },
          data: {
            published: input.published,
            visibility,
            // Kept once set. It is when the item was first published, and a
            // republish after a correction does not make it newer news.
            publishedAt:
              input.published && news.publishedAt === null
                ? now
                : news.publishedAt,
            /*
             * A standing request is answered by the email mailing and by
             * nothing else.
             *
             * The request is for the mailing (nyhetsutskick), which is the
             * email; the text message is asked for and claimed separately. So
             * publishing with SMS alone leaves the request standing, which is
             * correct - the thing that was asked for has not happened - and
             * the board still sees the notice on the item.
             */
            ...(claimedEmail
              ? { mailingRequestedAt: null, mailingRequestedByPersonId: null }
              : {}),
          },
          select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
        });

        await this.audit.record(
          {
            action: "NEWS_PUBLISHED",
            ...auditActor(actor),
            targetKind: "news",
            targetId: id,
            context: {
              slug: updated.slug,
              published: input.published,
              visibility,
            },
          },
          tx,
        );

        /**
         * One channel's recipients, as they stand at this instant, written down.
         *
         * The snapshot is the record of who the board was writing to when it
         * pressed publish, and it is never refreshed. A member who moves in
         * tomorrow is not sent today's news; somebody who moves out between this
         * commit and the worker's run still receives it. Both follow from the
         * same reading of the act, and the second is the honest one: the board
         * addressed them.
         *
         * Reached only from behind a claim that held, so the ledger it writes and
         * the job it enqueues belong to a mailing that has been claimed exactly
         * once.
         */
        const snapshot = async (channel: "EMAIL" | "SMS"): Promise<number> => {
          const recipients = await tx.person.findMany({
            where: recipientsWhere(now, channel),
            select: { id: true },
          });

          // No skipDuplicates. The unique triple is the guarantee, and a
          // duplicate reaching here would mean the claim above had failed to
          // hold - which must abort the publish loudly rather than be quietly
          // dropped.
          await tx.newsDelivery.createMany({
            data: recipients.map((person) => ({
              newsId: id,
              personId: person.id,
              channel,
            })),
          });

          await this.audit.record(
            {
              action: channel === "SMS" ? "NEWS_TEXTED" : "NEWS_EMAILED",
              ...auditActor(actor),
              targetKind: "news",
              targetId: id,
              context: { slug: updated.slug, recipients: recipients.length },
            },
            tx,
          );

          // In this transaction, so the job row commits with the ledger it works
          // through or with neither. A job sent after the commit could fail on
          // its own and leave a mailing claimed with nothing coming for it.
          if (channel === "SMS") {
            await this.texter.enqueueInTransaction(tx, id);
          } else {
            await this.mailer.enqueueInTransaction(tx, id);
          }

          return recipients.length;
        };

        return {
          row: updated,
          mailedTo: claimedEmail ? await snapshot("EMAIL") : null,
          textedTo: claimedSms ? await snapshot("SMS") : null,
        };
      },
    );

    if (mailedTo !== null) {
      this.logger.log(
        `Published news ${id} and claimed a mailing for ${String(mailedTo)} members`,
      );
    }
    if (textedTo !== null) {
      this.logger.log(
        `Published news ${id} and claimed an SMS mailing for ${String(textedTo)} members`,
      );
    }

    return { ...toAdminView(row), mailedTo, textedTo };
  }

  /**
   * Removes a news item.
   *
   * Taking down something that was published is itself a publication change, so
   * it is recorded as one, in the same transaction. A draft nobody could read
   * leaves no entry: there was nothing published to stop being so. The delivery
   * ledger goes with the row - it records a mailing of an item that no longer
   * exists - while the audit entries stay, because the log is evidence and is
   * append-only.
   *
   * Refused while a comment stands under it. A comment is its author's personal
   * data on a clock of its own, and the news comment purge is the one path that
   * erases it: the path that honours a legal hold, a restriction and an erasure
   * request, and that writes an audit entry for whoever it erased. Erasing the
   * thread here would be a second such path, and it would also be the deletion
   * moderation deliberately does not give the board, reached through the item
   * instead of the comment. Taking the item down is what the board can do
   * instead: that shuts the thread to its readers, and once the purge has
   * erased the last comment the item can be removed.
   */
  async remove(id: string, actor: ActorContext): Promise<void> {
    const news = await this.require(id);

    const hasComments = (): NewsWriteError =>
      new NewsWriteError(
        "The news item has comments under it and cannot be removed.",
        "has-comments",
      );

    try {
      await this.prisma.$transaction(async (tx) => {
        if ((await tx.newsComment.count({ where: { newsId: id } })) > 0) {
          throw hasComments();
        }
        await tx.news.delete({ where: { id } });

        if (news.published) {
          await this.audit.record(
            {
              action: "NEWS_PUBLISHED",
              ...auditActor(actor),
              targetKind: "news",
              targetId: id,
              context: {
                slug: news.slug,
                published: false,
                deleted: true,
                visibility: news.visibility,
              },
            },
            tx,
          );
        }
      });
    } catch (cause) {
      /*
       * The count above narrows the window; the foreign key closes it. A
       * comment written between the count and the delete makes the delete
       * raise P2003 against the restrictive key, and that is the same refusal.
       */
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2003"
      ) {
        throw hasComments();
      }
      throw cause;
    }

    this.logger.log(`Removed the news item at /nyheter/${news.slug}`);
  }

  /**
   * Refuses a news item carrying a Swedish personal identity number.
   *
   * The same rule a page lives under, and for the same reason: a personnummer
   * on something the association publishes is a disclosure it cannot take back,
   * and it usually arrives pasted along with the text around it rather than
   * because somebody decided to publish it.
   */
  private refusePersonalIdentityNumbers(
    title: string,
    content: PageContent,
  ): void {
    const locations: NewsTextLocation[] = [
      ...scanForPersonalIdentityNumbers(title).map((hit): NewsTextLocation => ({
        part: "title",
        index: 0,
        offset: hit.index,
      })),
      ...identityNumbersInBody(content),
    ];

    if (locations.length > 0) {
      throw new NewsWriteError(
        "The news item carries a personal identity number and cannot be published.",
        "personal-identity-number",
        { locations },
      );
    }
  }

  private async require(id: string) {
    const row = await this.prisma.news.findUnique({
      where: { id },
      select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
    });
    if (row === null) {
      throw new NewsWriteError("There is no such news item.", "not-found");
    }
    return row;
  }

  /**
   * The item as it stands, with its row locked until the transaction ends.
   *
   * A row lock rather than an advisory key, so that every writer of the row
   * waits for it without having to know it is there: a publish, a save, a
   * mailing request and a removal all update or delete the row, and each of
   * them waits until this transaction ends. The read after the lock sees
   * whatever the writer before it committed.
   */
  private async lockAndRead(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`SELECT 1 FROM news WHERE id = ${id} FOR UPDATE`;
    const row = await tx.news.findUnique({
      where: { id },
      select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
    });
    if (row === null) {
      throw new NewsWriteError("There is no such news item.", "not-found");
    }
    return row;
  }

  /**
   * Refuses an address a news item may not have, or already has.
   *
   * The shape rule only, and not the reserved list: a news item lives under
   * /nyheter, where nothing the router claims can be in its way, so refusing it
   * the name "api" would be a rule inherited from a namespace it is not in.
   */
  private async requireFreeSlug(
    slug: string,
    exceptNewsId: string | null,
  ): Promise<void> {
    if (!isSlugShaped(slug)) {
      throw new NewsWriteError(
        `The address /nyheter/${slug} cannot be used.`,
        "invalid-slug",
      );
    }

    const existing = await this.prisma.news.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing !== null && existing.id !== exceptNewsId) {
      throw new NewsWriteError(
        `The address /nyheter/${slug} is already a news item.`,
        "slug-taken",
      );
    }
  }
}

/**
 * Who a mailing goes to: the members, with somewhere to send it.
 *
 * The decision log says the board mails the members, and members precisely: not
 * every resident is a member (GLOSSARY: boende, medlem). Membership is a
 * residency with the MEMBER role held today - the same derivation the address
 * book reads a person's own view by, written here as a query because this asks
 * it of everybody at once.
 *
 * A member with protected personal data is included. The protection governs
 * what the association discloses about them to others; it has never meant that
 * the association stops writing to them.
 *
 * The channel decides which contact detail has to be there. A member the
 * association holds no number for is simply not among the people it can text:
 * they are left out of the snapshot rather than written into it and failed, so
 * being unreachable one way is an absence from that ledger and never a column
 * of failures on the board's screen.
 */
export function recipientsWhere(now: Date, channel: "EMAIL" | "SMS") {
  return {
    ...(channel === "SMS"
      ? { phoneCipher: { not: null } }
      : { emailCipher: { not: null } }),
    /*
     * A standing objection under GDPR art. 21, and a restriction under art. 18.
     *
     * A news mailing rests on a legitimate interest (art. 6(1)(f)), which is
     * exactly the processing art. 21 lets a person object to; the association
     * could in principle answer with compelling legitimate grounds and does
     * not, so an objection stops the mailing. A restriction stops it for a
     * different reason: art. 18(2) permits storage and little else, and sending
     * is a use.
     *
     * Here rather than only at the send, so the count the board is shown before
     * it publishes and the snapshot the job works from agree by construction.
     * Neither reaches the summons to a general meeting (kallelse), which rests
     * on art. 6(1)(c) and is exempt - see meeting-notice.service.ts.
     */
    communicationObjectionAt: null,
    processingRestrictedAt: null,
    residencies: {
      some: { role: "MEMBER" as const, ...residencyHeldOn(localDayOf(now)) },
    },
  };
}

const DELIVERY_COLUMNS = {
  channel: true,
  status: true,
  failureReason: true,
} as const;

/**
 * A body narrowed to what a news item may hold, refusing the rest.
 *
 * On the write path, where refusing is the right answer: the board put this
 * block here, so it can be told the block does not belong on a news item rather
 * than silently getting an announcement with a hole in it.
 */
function onlyProse(content: PageContent): PageContent {
  const refused = content.blocks
    .map((block, index) => ({ block, index }))
    .filter((entry) => !isTextBlock(entry.block))
    .map((entry) => entry.index);

  if (refused.length > 0) {
    throw new NewsWriteError(
      "A news item holds text only.",
      "unsupported-block",
      { blocks: refused },
    );
  }
  return content;
}

/** A stored body, read the way the website reads it. */
function readNewsContent(value: unknown): PageContent {
  return textBlocksOnly(readPageContent(value));
}

function toAdminView(row: {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: Date | null;
  emailQueuedAt: Date | null;
  smsQueuedAt: Date | null;
  mailingRequestedAt: Date | null;
  revision: number;
  updatedAt: Date;
  deliveries: readonly {
    channel: string;
    status: string;
    failureReason: string | null;
  }[];
}): NewsAdminView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    // Through the same parser the website uses, so the editor is shown what the
    // website would actually publish and never more.
    content: readNewsContent(row.content),
    visibility: row.visibility,
    published: row.published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    emailQueuedAt: row.emailQueuedAt?.toISOString() ?? null,
    smsQueuedAt: row.smsQueuedAt?.toISOString() ?? null,
    mailingRequested: row.mailingRequestedAt !== null,
    delivery: {
      email: channelReport(
        row.deliveries,
        "EMAIL",
        DELIVERY_FAILURES.mailNotConfigured,
      ),
      sms: channelReport(
        row.deliveries,
        "SMS",
        DELIVERY_FAILURES.smsNotConfigured,
      ),
    },
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One channel's counts, from the rows that belong to it.
 *
 * Filtered by channel rather than counted over the whole ledger, because the
 * two are reported side by side: a total that mixed them would tell a board
 * with no SMS provider that its email mailing had failures in it.
 */
function channelReport(
  deliveries: readonly {
    channel: string;
    status: string;
    failureReason: string | null;
  }[],
  channel: "EMAIL" | "SMS",
  notConfiguredReason: string,
): NewsDeliveryReport {
  const rows = deliveries.filter((one) => one.channel === channel);
  return {
    pending: rows.filter((one) => one.status === "PENDING").length,
    sent: rows.filter((one) => one.status === "SENT").length,
    failed: rows.filter((one) => one.status === "FAILED").length,
    notConfigured: rows.some(
      (one) => one.failureReason === notConfiguredReason,
    ),
  };
}

/**
 * Cast at the persistence boundary: Prisma types a JSON column with its own
 * recursive InputJsonValue, which a declared object type does not satisfy.
 */
function asJson(content: PageContent): Prisma.InputJsonObject {
  return content as unknown as Prisma.InputJsonObject;
}
