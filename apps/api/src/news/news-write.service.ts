import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import {
  isTextBlock,
  type PageContent,
  pageTextParts,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import { isSlugShaped } from "../site/pages.service";
import type { PageTextLocation } from "../site/pages-write.service";
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
  | "personal-identity-number"
  | "unsupported-block";

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
        : reason === "slug-taken"
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
  updatedAt: string;
}

export interface NewsInput {
  slug: string;
  title: string;
  content: PageContent;
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
  actorPersonId: string;
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
  async create(input: CreateNewsInput): Promise<NewsAdminView> {
    await this.requireFreeSlug(input.slug, null);

    const row = await this.prisma.news.create({
      data: {
        slug: input.slug,
        title: input.title,
        content: asJson(onlyProse(input.content)),
        published: false,
        authorPersonId: input.authorPersonId,
      },
      select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
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
  async update(id: string, input: NewsInput): Promise<NewsAdminView> {
    const news = await this.require(id);
    const addressSent =
      news.emailQueuedAt !== null || news.smsQueuedAt !== null;
    if (addressSent && input.slug !== news.slug) {
      throw new NewsWriteError(
        "The address was sent to the members and cannot be changed.",
        "address-mailed",
      );
    }
    await this.requireFreeSlug(input.slug, id);

    const content = onlyProse(input.content);
    if (news.published) {
      this.refusePersonalIdentityNumbers(input.title, content);
    }

    const row = await this.prisma.news.update({
      where: { id },
      data: {
        slug: input.slug,
        title: input.title,
        content: asJson(content),
      },
      select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
    });

    return toAdminView(row);
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
  ): Promise<PublishNewsResult> {
    const news = await this.require(id);
    const visibility = input.visibility ?? news.visibility;
    const content = readNewsContent(news.content);

    if (input.published) {
      this.refusePersonalIdentityNumbers(news.title, content);
    }

    /*
     * Whether this call is the mailing, and whether it is the SMS mailing.
     *
     * Only a publish sends, only when the board asked, and only while that
     * channel's column is still null. The last of the three is re-checked
     * inside the transaction by the claim itself - these are here so an
     * ordinary republish does not open a transaction that reads the register
     * for nothing.
     *
     * Two independent tests, because the two channels are two decisions. A
     * board that emailed the members in the morning may text them in the
     * afternoon about the same notice, and neither claim can be taken twice.
     */
    const mailing =
      input.published &&
      input.sendEmail === true &&
      news.emailQueuedAt === null;

    const texting =
      input.published && input.sendSms === true && news.smsQueuedAt === null;

    /*
     * A write that changes nothing writes nothing.
     *
     * Pressing publish on an item that is already published to the same people,
     * with neither mailing left to claim, is not an event and does not belong
     * in the audit log. The mailings are part of the test rather than an
     * afterthought: a board that published without sending and comes back to
     * press it again is asking for the one thing this call could still do.
     */
    if (
      news.published === input.published &&
      news.visibility === visibility &&
      !mailing &&
      !texting
    ) {
      return { ...toAdminView(news), mailedTo: null, textedTo: null };
    }

    // Before the transaction opens: creating a queue is the queue backend's own
    // work on its own connection, and it has no business inside somebody else's
    // transaction.
    if (mailing) {
      await this.mailer.ensureQueues();
    }
    if (texting) {
      await this.texter.ensureQueues();
    }

    const now = new Date();

    const { row, mailedTo, textedTo } = await this.prisma.$transaction(
      async (tx) => {
        /*
         * The claims, and the only writers of these two columns in the codebase.
         *
         * Conditional on the column still being null, because the read above ran
         * before this transaction and is only as fresh as the moment it was
         * taken. Two publishes racing each other both reach here; the second
         * blocks on the row until the first commits and then matches nothing, so
         * it claims no mailing, writes no ledger and enqueues no job.
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
          },
          select: { ...NEWS_COLUMNS, deliveries: { select: DELIVERY_COLUMNS } },
        });

        await this.audit.record(
          {
            action: "NEWS_PUBLISHED",
            actorPersonId: input.actorPersonId,
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
              actorPersonId: input.actorPersonId,
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
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    const news = await this.require(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.news.delete({ where: { id } });

      if (news.published) {
        await this.audit.record(
          {
            action: "NEWS_PUBLISHED",
            actorPersonId,
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
      ...pageTextParts(content).flatMap((part) =>
        scanForPersonalIdentityNumbers(part.text).map(
          (hit): NewsTextLocation => ({
            part: "block",
            index: part.index,
            offset: hit.index,
          }),
        ),
      ),
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
 * every resident is a member (GLOSSARY: boende, medlem). Membership is an
 * active residency with the MEMBER role - the same derivation the address book
 * reads a person's own view by, written here as a query because this asks it of
 * everybody at once.
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
    residencies: {
      some: {
        role: "MEMBER" as const,
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
      },
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
