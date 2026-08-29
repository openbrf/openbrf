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
import { NewsMailerService } from "./news-mailer.service";

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

/** How a mailing is going, as the board's screen reports it. */
export interface NewsDeliveryReport {
  /** Claimed at publish and not yet handed to a mail server. */
  pending: number;
  sent: number;
  failed: number;
  /**
   * That at least one delivery failed because this instance has no mail server.
   * The news item is published either way; only the mailing failed, and that
   * distinction is the whole of what the screen has to say about it.
   */
  mailNotConfigured: boolean;
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
  delivery: NewsDeliveryReport;
  updatedAt: string;
}

export interface NewsInput {
  slug: string;
  title: string;
  content: PageContent;
}

export interface PublishNewsInput {
  published: boolean;
  /** Who it is for. Unchanged when omitted. */
  visibility?: PageVisibility;
  /** Whether to mail the members. Ignored on anything but a first mailing. */
  sendEmail?: boolean;
  actorPersonId: string;
}

export interface PublishNewsResult extends NewsAdminView {
  /**
   * How many members the mailing was claimed for, or null when this publish
   * claimed no mailing - because the board did not ask for one, because one has
   * already been claimed, or because the item was taken down rather than put up.
   */
  mailedTo: number | null;
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
  updatedAt: true,
} as const;

/**
 * The board's side of the association's news: writing it, publishing it, and
 * mailing it to the members exactly once.
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
 * **The members are mailed exactly once.** Publishing with the mailing asked
 * for is one transaction that conditionally claims `emailQueuedAt` while it is
 * null, snapshots the recipients into the delivery ledger - whose (news,
 * person) pair is unique - writes both audit entries, and enqueues the job
 * through the same transaction. Two concurrent publishes both run the claim;
 * the second finds the column set and claims nothing. No edit and no republish
 * writes that column, so re-sending on an edit is impossible rather than
 * unlikely. The worker then claims each ledger row before it mails it, so a
 * retried job re-sends to nobody.
 */
@Injectable()
export class NewsWriteService {
  private readonly logger = new Logger(NewsWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mailer: NewsMailerService,
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
   * How many members a mailing would reach, right now.
   *
   * Shown beside the mailing toggle so the board knows what it is about to do,
   * and deliberately a count rather than a list: who the association's members
   * are is the register's answer to give, on the register's own screen and
   * under the register's own capability.
   */
  async recipientCount(): Promise<number> {
    return this.prisma.person.count({ where: recipientsWhere(new Date()) });
  }

  /**
   * Writes a new item.
   *
   * Unpublished, always. It is written before it is meant to be read, and
   * publishing is a separate act with its own record in the audit log - which
   * is also why creating one runs no guardrail: nothing it holds is readable by
   * anyone yet.
   */
  async create(input: NewsInput): Promise<NewsAdminView> {
    await this.requireFreeSlug(input.slug, null);

    const row = await this.prisma.news.create({
      data: {
        slug: input.slug,
        title: input.title,
        content: asJson(onlyProse(input.content)),
        published: false,
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
   */
  async update(id: string, input: NewsInput): Promise<NewsAdminView> {
    const news = await this.require(id);
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
     * Whether this call is the mailing.
     *
     * Only a publish mails, only when the board asked, and only while the
     * column is still null. The last of the three is re-checked inside the
     * transaction by the claim itself - this one is here so an ordinary
     * republish does not open a transaction that reads the register for
     * nothing.
     */
    const mailing =
      input.published &&
      input.sendEmail === true &&
      news.emailQueuedAt === null;

    /*
     * A write that changes nothing writes nothing.
     *
     * Pressing publish on an item that is already published to the same people,
     * with no mailing left to claim, is not an event and does not belong in the
     * audit log. The mailing is part of the test rather than an afterthought:
     * a board that published without mailing and comes back to press it again
     * is asking for the one thing this call could still do.
     */
    if (
      news.published === input.published &&
      news.visibility === visibility &&
      !mailing
    ) {
      return { ...toAdminView(news), mailedTo: null };
    }

    if (mailing) {
      // Before the transaction opens: creating a queue is the queue backend's
      // own work on its own connection, and it has no business inside somebody
      // else's transaction.
      await this.mailer.ensureQueues();
    }

    const now = new Date();

    const { row, mailedTo } = await this.prisma.$transaction(async (tx) => {
      /*
       * The claim, and the only writer of this column in the codebase.
       *
       * Conditional on it still being null, because the read above ran before
       * this transaction and is only as fresh as the moment it was taken. Two
       * publishes racing each other both reach here; the second blocks on the
       * row until the first commits and then matches nothing, so it claims no
       * mailing, writes no ledger and enqueues no job.
       */
      const claimed =
        mailing &&
        (
          await tx.news.updateMany({
            where: { id, emailQueuedAt: null },
            data: { emailQueuedAt: now },
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

      if (!claimed) {
        return { row: updated, mailedTo: null };
      }

      /*
       * The recipients, as they stand at this instant, written down.
       *
       * The snapshot is the record of who the board was writing to when it
       * pressed publish, and it is never refreshed. A member who moves in
       * tomorrow is not mailed today's news; somebody who moves out between
       * this commit and the worker's run still receives it. Both follow from
       * the same reading of the act, and the second is the honest one: the
       * board addressed them.
       */
      const recipients = await tx.person.findMany({
        where: recipientsWhere(now),
        select: { id: true },
      });

      // No skipDuplicates. The unique pair is the guarantee, and a duplicate
      // reaching here would mean the claim above had failed to hold - which
      // must abort the publish loudly rather than be quietly dropped.
      await tx.newsDelivery.createMany({
        data: recipients.map((person) => ({ newsId: id, personId: person.id })),
      });

      await this.audit.record(
        {
          action: "NEWS_EMAILED",
          actorPersonId: input.actorPersonId,
          targetKind: "news",
          targetId: id,
          context: { slug: updated.slug, recipients: recipients.length },
        },
        tx,
      );

      // In this transaction, so the job row commits with the ledger it works
      // through or with neither. A job sent after the commit could fail on its
      // own and leave a mailing claimed with nothing coming for it.
      await this.mailer.enqueueInTransaction(tx, id);

      return { row: updated, mailedTo: recipients.length };
    });

    if (mailedTo !== null) {
      this.logger.log(
        `Published news ${id} and claimed a mailing for ${String(mailedTo)} members`,
      );
    }

    return { ...toAdminView(row), mailedTo };
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
 */
export function recipientsWhere(now: Date) {
  return {
    emailCipher: { not: null },
    residencies: {
      some: {
        role: "MEMBER" as const,
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
      },
    },
  };
}

const DELIVERY_COLUMNS = { status: true, failureReason: true } as const;

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
  updatedAt: Date;
  deliveries: readonly { status: string; failureReason: string | null }[];
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
    delivery: {
      pending: row.deliveries.filter((one) => one.status === "PENDING").length,
      sent: row.deliveries.filter((one) => one.status === "SENT").length,
      failed: row.deliveries.filter((one) => one.status === "FAILED").length,
      mailNotConfigured: row.deliveries.some(
        (one) => one.failureReason === MAIL_NOT_CONFIGURED,
      ),
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The code a delivery carries when this instance has no mail server at all.
 *
 * Shared with the worker that writes it, so the screen's one sentence about it
 * and the failure it describes cannot drift apart.
 */
export const MAIL_NOT_CONFIGURED = "mail-not-configured";

/**
 * Cast at the persistence boundary: Prisma types a JSON column with its own
 * recursive InputJsonValue, which a declared object type does not satisfy.
 */
function asJson(content: PageContent): Prisma.InputJsonObject {
  return content as unknown as Prisma.InputJsonObject;
}
