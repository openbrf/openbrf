import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import type { ActorContext } from "../audit/actor-context";
import { auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { lockMenu } from "./menu-lock";
import { lockPageOrder } from "./page-order-lock";
import {
  imageReferences,
  type PageContent,
  pageTextParts,
  readPageContent,
} from "./page-content";
import { isUsableSlug, PRIVACY_NOTICE_SLUG } from "./pages.service";

/**
 * Where in a page a refused value sits.
 *
 * Positions and a field name, never the value itself. A refusal has to be
 * actionable - "there is a personal identity number on this page" without
 * saying where leaves the board reading its own text looking for it - and the
 * thing that was found is precisely the thing that must not travel back in a
 * response body, be written to a log, or be shown to anyone who was not already
 * looking at the page.
 */
export interface PageTextLocation {
  part: "title" | "block";
  /** The block's position in the body. Zero for the title. */
  index: number;
  /**
   * Where in the block's words the refused value starts. Absent when it is not
   * in the words - a link's address, which the page's HTML carries and no
   * reader sees - or when the whole block is what was refused, as for a picture.
   */
  offset?: number;
}

/**
 * Where a body carries a personal identity number.
 *
 * One in the words is placed by block and offset. One in an address is placed
 * by its block alone, once however many of the block's addresses carry it: an
 * offset into the words would point at whatever happens to stand there. An
 * address escaped too deeply to be read is placed the same way, since what it
 * says cannot be shown to be free of one.
 */
export function identityNumbersInBody(
  content: PageContent,
): PageTextLocation[] {
  return pageTextParts(content).flatMap((part) => [
    ...scanForPersonalIdentityNumbers(part.text).map(
      (hit): PageTextLocation => ({
        part: "block",
        index: part.index,
        offset: hit.index,
      }),
    ),
    ...(part.unreadableAddress ||
    part.addresses.some(
      (address) => scanForPersonalIdentityNumbers(address).length > 0,
    )
      ? [{ part: "block" as const, index: part.index }]
      : []),
  ]);
}

export type PageWriteReason =
  | "not-found"
  | "invalid-slug"
  | "slug-taken"
  | "page-changed"
  | "personal-identity-number"
  | "photo-consent-required"
  | "image-not-found"
  | "image-not-public";

export class PageWriteError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: PageWriteReason,
    private readonly found: readonly PageTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "not-found"
        ? HttpStatus.NOT_FOUND
        : // A conflict rather than a refusal on the merits: nothing is wrong
          // with what was sent, somebody else wrote first, and the caller reads
          // the page again and decides what to do about it.
          reason === "slug-taken" || reason === "page-changed"
          ? HttpStatus.CONFLICT
          : reason === "invalid-slug"
            ? HttpStatus.BAD_REQUEST
            : // The request was understood and refused on its merits: this page
              // may not be published as it stands, and the board is told which
              // part of it to change.
              HttpStatus.UNPROCESSABLE_ENTITY;
  }

  /**
   * Where the refusal is, in one shape for every reason.
   *
   * One key rather than one per rule, so the screen has one thing to render and
   * the client has one field to read. Positions and a field name only: what was
   * found is exactly what must not travel back.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.found };
  }
}

/** A page as the board's own screen shows it: everything, drafts included. */
/**
 * A page without its body.
 *
 * What a caller gets when it asks which pages exist. Everything here is a fact
 * about the page rather than its content, including `revision`, because a
 * caller that means to rewrite a page needs the number before it reads the
 * body.
 */
export interface PageSummary {
  id: string;
  slug: string;
  title: string;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: string | null;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface PageAdminView {
  id: string;
  slug: string;
  title: string;
  content: PageContent;
  visibility: PageVisibility;
  published: boolean;
  /** ISO instant, or null while the page has never been published. */
  publishedAt: string | null;
  sortOrder: number;
  /**
   * What this copy of the page is, for a caller that means to write it back.
   *
   * Sent to a save as `expectedRevision`, which writes only if the page is
   * still the one that was read. It is not a version anybody displays.
   */
  revision: number;
  updatedAt: string;
}

export interface CreatePageInput {
  slug: string;
  title: string;
  content: PageContent;
  visibility: PageVisibility;
}

export interface UpdatePageInput {
  slug: string;
  title: string;
  content: PageContent;
  /**
   * That the board has confirmed every identifiable person on the page has
   * given publication consent. Needed only where a picture declares that it
   * shows any; see the guardrails below.
   */
  photoConsentConfirmed?: boolean;
  /**
   * The page's `revision` as the caller last read it.
   *
   * A save carries the whole page, so two callers who each read it and then
   * wrote would leave the second one's copy standing and the first one's work
   * gone, with nothing said to either. The page editor and the screens that
   * place a block on a page are two such callers, and a board with the website
   * open in one tab and the news screen in another is not an unusual state.
   *
   * A counter rather than `updatedAt`, which this was written against first:
   * that column is stored to the millisecond, so two saves inside one
   * millisecond carry the same token and the second would match the row it was
   * meant to be refused against.
   *
   * Optional, and absent means what this endpoint has always done: write. That
   * keeps a caller written before the field existed working rather than failing
   * on a precondition it does not know about, which for a statutory-adjacent
   * page would be a worse failure than the one it prevents.
   */
  expectedRevision?: number;
}

/**
 * Refuses a precondition the page no longer meets.
 *
 * Answered before anything about the merits of the request, because it is not
 * about the request: it is about the copy the caller decided on. Two things
 * follow from putting it first.
 *
 * A write that would change nothing still answers it. Publishing a published
 * page, or giving a page the audience it already has, is not an event and
 * writes nothing, but somebody else may have rewritten that page and put it in
 * the requested state since - and answering "done" would tell the caller that
 * the content it decided on is what is now published, when it has never seen
 * what is.
 *
 * And a write that would change something answers it before the publication
 * guardrails, which on those paths read the stored page rather than anything
 * the caller sent. A page left carrying a personal identity number by another
 * writer would otherwise be refused on the merits of that writer's content, at
 * a caller whose real problem is the copy in its hand.
 *
 * Absent, or matching, nothing here changes what the method does. The
 * conditional claims downstream stay, because they answer a different
 * question: whether the page changed after this read.
 */
function refuseStalePrecondition(
  page: { revision: number },
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== page.revision) {
    throw new PageWriteError(
      "The page changed after it was read.",
      "page-changed",
    );
  }
}

const PAGE_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  content: true,
  visibility: true,
  published: true,
  publishedAt: true,
  sortOrder: true,
  revision: true,
  updatedAt: true,
} as const;

/**
 * The board's side of the association's pages: writing them, publishing them,
 * and deciding who each one is for.
 *
 * One service, because the publication guardrails are one rule set and a second
 * write path would be a second place to forget them. Every route that can make
 * a page readable by somebody goes through here, and here is where the two
 * refusals live:
 *
 *   A personal identity number is refused. Whenever a write leaves a page
 *   published - editing one that is, publishing one, or changing the visibility
 *   of one - every piece of text on it is scanned, and a hit refuses the write
 *   naming the block and the offset. Not the value: the value is the thing that
 *   must not be repeated.
 *
 *   A picture of identifiable people is refused unless the board confirms the
 *   publication consents. Coarse on purpose this train: the check is the
 *   declaration made at upload plus a confirmation on the write, rather than a
 *   link from each face to a consent row. It is applied to any published page
 *   and not only a public one, because the file behind a picture is stored
 *   public and is therefore fetchable by whoever holds its address whatever the
 *   page's own visibility says.
 *
 * A draft is deliberately not scanned. Half-written text is where a board member
 * pastes something from an email to tidy up later, and refusing to save it would
 * only teach them to write elsewhere; nothing is readable by anyone until it is
 * published, which is the moment the rule applies.
 *
 * Nothing here imports the registers, the address book or the encryption layer,
 * for the same reason the rendering path does not: the boundary is what makes
 * "no stored page can reach the statutory registers" a property of the module
 * graph rather than a promise about intent.
 */
@Injectable()
export class PagesWriteService {
  private readonly logger = new Logger(PagesWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every page, drafts included, in the order they sit in. */
  async list(): Promise<PageAdminView[]> {
    const rows = await this.prisma.page.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: PAGE_COLUMNS,
    });
    return rows.map((row) => toAdminView(row));
  }

  async byId(id: string): Promise<PageAdminView> {
    return toAdminView(await this.require(id));
  }

  /**
   * A bounded page of pages, without their bodies.
   *
   * Its own method rather than a bound on `list()` above, which the board's
   * editor calls and which has to return every page to arrange them. The
   * difference is who is asking: the editor is one board member looking at
   * their own association, while this answers a caller that may be a model
   * with a context window, and `PAGE_COLUMNS` carries `content` - so one
   * unbounded call could return the association's whole website. The per-page
   * ceiling alone is 200 blocks of 200 runs of 5000 characters.
   *
   * Summary rows, so reading a body is a second, deliberate call.
   *
   * The cursor is the position of the last page returned rather than the
   * page itself. A cursor naming a row answers nothing once that row is gone:
   * a caller paging through while somebody deleted the page it stopped at was
   * told the list had ended, and silently missed every page after it.
   */
  async listSummaries(options: {
    limit: number;
    cursor?: string | undefined;
    publishedOnly?: boolean | undefined;
  }): Promise<{ pages: PageSummary[]; nextCursor: string | null }> {
    const after =
      options.cursor === undefined ? null : readPageCursor(options.cursor);

    // One more than asked for, so "is there another page" is answered by the
    // read rather than by a second count query.
    const rows = await this.prisma.page.findMany({
      where: {
        ...(options.publishedOnly === true ? { published: true } : {}),
        // Everything after that position in the order below, whether or not
        // the page that stood there still does.
        ...(after === null
          ? {}
          : {
              OR: [
                { sortOrder: { gt: after.sortOrder } },
                { sortOrder: after.sortOrder, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: options.limit + 1,
      select: {
        id: true,
        slug: true,
        title: true,
        visibility: true,
        published: true,
        publishedAt: true,
        sortOrder: true,
        revision: true,
        updatedAt: true,
      },
    });

    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      pages: page.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        visibility: row.visibility,
        published: row.published,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        sortOrder: row.sortOrder,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > options.limit && last !== undefined
          ? `${String(last.sortOrder)}:${last.id}`
          : null,
    };
  }

  /**
   * Writes a new page.
   *
   * Unpublished, always. A page is written before it is meant to be read, and
   * publishing is a separate act with a separate record in the audit log -
   * which is also why creating one needs no guardrail run: nothing it holds is
   * readable by anyone yet.
   */
  async create(
    input: CreatePageInput,
    actor: ActorContext,
  ): Promise<PageAdminView> {
    await this.requireFreeSlug(input.slug, null);

    const row = await this.prisma.$transaction(async (tx) => {
      await lockPageOrder(tx);
      const sortOrder = await placeNewPage(tx);

      const created = await tx.page
        .create({
          data: {
            slug: input.slug,
            title: input.title,
            content: asJson(input.content),
            visibility: input.visibility,
            published: false,
            sortOrder,
          },
          select: PAGE_COLUMNS,
        })
        .catch(refuseTakenSlug(input.slug));

      await this.audit.record(
        {
          action: "PAGE_CONTENT_CHANGED",
          ...auditActor(actor),
          targetKind: "page",
          targetId: created.id,
          context: {
            slug: created.slug,
            blockCount: input.content.blocks.length,
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
   * Rewrites a page's address, title and body.
   *
   * Not its visibility and not whether it is published: those two are what
   * decide who can read it, they are what the audit log records, and giving
   * them a second way in through the ordinary save would be a second way for
   * the record to be missed.
   *
   * Who rewrote the body of a published page is a separate question from who
   * may read it, and one this write does not answer.
   */
  async update(
    id: string,
    input: UpdatePageInput,
    actor: ActorContext,
  ): Promise<PageAdminView> {
    const page = await this.require(id);
    await this.requireFreeSlug(input.slug, id);

    if (page.published) {
      await this.enforceGuardrails({
        title: input.title,
        content: input.content,
        photoConsentConfirmed: input.photoConsentConfirmed === true,
      });
    }

    /*
     * Claimed against the copy the caller read, when they said which. An
     * updateMany with the timestamp in its where clause is one statement: it
     * either matches the row as it still stands and writes, or matches nothing
     * and writes nothing. A read followed by a compare would leave the same gap
     * between them that the precondition exists to close.
     */
    if (input.expectedRevision !== undefined) {
      return this.claimAndRecord(id, actor, (tx) =>
        tx.page.updateMany({
          /*
           * The publication state as well as the revision. The guardrails above
           * ran against the page this transaction read, and they are skipped for
           * a draft: a page published between that read and this write would take
           * content nothing checked. Claiming on it too means such a save is
           * refused rather than applied - and the caller reads the page again,
           * where the guardrails will run.
           */
          where: {
            id,
            revision: input.expectedRevision,
            published: page.published,
          },
          data: {
            slug: input.slug,
            title: input.title,
            content: asJson(input.content),
            // In the same statement as the content it belongs to, so the next
            // caller's claim reads a number that moved with the page.
            revision: { increment: 1 },
          },
        }),
      ).catch(refuseTakenSlug(input.slug));
    }

    /*
     * The caller sent no precondition, so this writes. The revision still moves:
     * it says the page is not the one somebody else read, and a save that left
     * it alone would let their stale claim match afterwards.
     */
    return this.claimAndRecord(id, actor, (tx) =>
      tx.page.updateMany({
        // No revision to claim on, but the publication state this write was
        // checked against is still a precondition: without it a caller that
        // sends no revision could put content past the guardrails onto a page
        // somebody published in between.
        where: { id, published: page.published },
        data: {
          slug: input.slug,
          title: input.title,
          content: asJson(input.content),
          revision: { increment: 1 },
        },
      }),
    ).catch(refuseTakenSlug(input.slug));
  }

  /**
   * Runs one claim and records the content change it made, together.
   *
   * Both branches of the save above need the same thing: a conditional write
   * that either matches the page as it still stands or matches nothing, and an
   * audit entry that commits with it. A rewritten page whose entry was lost
   * would leave a published page changed by nobody, which is the whole gap
   * PAGE_CONTENT_CHANGED closes.
   */
  private async claimAndRecord(
    id: string,
    actor: ActorContext,
    claim: (tx: Prisma.TransactionClient) => Promise<{ count: number }>,
  ): Promise<PageAdminView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await claim(tx);
      if (claimed.count === 0) {
        throw new PageWriteError(
          "The page changed after it was read.",
          "page-changed",
        );
      }

      const updated = await tx.page.findUniqueOrThrow({
        where: { id },
        select: PAGE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "PAGE_CONTENT_CHANGED",
          ...auditActor(actor),
          targetKind: "page",
          targetId: id,
          // Facts about the act, never the text: which page, and how much of
          // it there now is.
          context: {
            slug: updated.slug,
            blockCount: readPageContent(updated.content).blocks.length,
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
   * Publishes a page, or takes it down.
   *
   * The audit entry and the change share a transaction, so the log cannot claim
   * a publication that was rolled back or miss one that stood. A write that
   * changes nothing writes nothing: pressing publish on a published page is not
   * an event.
   */
  async setPublished(
    id: string,
    input: {
      published: boolean;
      photoConsentConfirmed?: boolean;
      /** @see PageUpdateInput.expectedRevision */
      expectedRevision?: number;
    },
    actor: ActorContext,
  ): Promise<PageAdminView> {
    const page = await this.require(id);
    /*
     * Before the guardrails, because the guardrails on this path read the page
     * as it is stored and a caller holding an older copy has never seen that
     * content. Run first, a page somebody else left carrying a personal
     * identity number would answer on the merits of their writing - and this
     * caller, whose copy is the thing that is wrong, would never reach the
     * conflict its own client handles.
     */
    refuseStalePrecondition(page, input.expectedRevision);

    if (page.published === input.published) {
      return toAdminView(page);
    }

    if (input.published) {
      await this.enforceGuardrails({
        title: page.title,
        content: readPageContent(page.content),
        photoConsentConfirmed: input.photoConsentConfirmed === true,
      });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Claimed against the page the guardrails ran on, above. Publishing is
       * checked and then written, and a content save landing between those two
       * would be a save the guardrails never saw - it was checked as a draft,
       * because that is what the page still was - going public the moment this
       * write lands. The content save moves the revision, so this claim finds
       * nothing and the board is told to look again rather than publishing
       * something nobody read.
       *
       * The revision this method read, and not the caller's: a caller that sent
       * one has already been refused above unless the two are the same number.
       * What is left for this claim is the narrower window the precondition
       * cannot see - a write landing between that read and this one.
       */
      const claimed = await tx.page.updateMany({
        where: { id, revision: page.revision, published: page.published },
        data: {
          published: input.published,
          // Kept once set. It is when the page was first published, and a
          // republish after a correction does not make it a newer page.
          publishedAt:
            input.published && page.publishedAt === null
              ? new Date()
              : page.publishedAt,
          /*
           * The revision moves here as it does on a content save, and for a
           * sharper reason. A save checks the publication guardrails only when
           * the page it read was published, so a save that read a draft and
           * landed after this one would put unchecked content - a personal
           * identity number, a picture of somebody who has not consented - onto
           * a page that is now public. Moving the revision makes that save fail
           * its claim instead.
           */
          revision: { increment: 1 },
        },
      });

      if (claimed.count === 0) {
        throw new PageWriteError(
          "The page changed after it was read.",
          "page-changed",
        );
      }

      const updated = await tx.page.findUniqueOrThrow({
        where: { id },
        select: PAGE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "PAGE_PUBLISHED",
          ...auditActor(actor),
          targetKind: "page",
          targetId: id,
          context: {
            slug: updated.slug,
            published: input.published,
            visibility: updated.visibility,
          },
        },
        tx,
      );

      return updated;
    });

    return toAdminView(row);
  }

  /** Moves a page between public and members only. */
  async setVisibility(
    id: string,
    input: {
      visibility: PageVisibility;
      photoConsentConfirmed?: boolean;
      /** @see PageUpdateInput.expectedRevision */
      expectedRevision?: number;
    },
    actor: ActorContext,
  ): Promise<PageAdminView> {
    const page = await this.require(id);
    // Before the guardrails, for the reason publishing answers it first: they
    // read the stored page, which a caller holding an older copy never saw.
    refuseStalePrecondition(page, input.expectedRevision);

    if (page.visibility === input.visibility) {
      return toAdminView(page);
    }

    if (page.published) {
      await this.enforceGuardrails({
        title: page.title,
        content: readPageContent(page.content),
        photoConsentConfirmed: input.photoConsentConfirmed === true,
      });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Claimed against the page the guardrails ran on, for the reason
       * publishing is: this is checked and then written, and a content save
       * landing between the two would be widened to a new audience without
       * anything having read it.
       *
       * The revision this method read, for the reason publishing claims on the
       * one it read: a caller's own precondition was answered above, and what
       * is left here is a write landing between that read and this one.
       */
      const claimed = await tx.page.updateMany({
        where: { id, revision: page.revision, visibility: page.visibility },
        // The revision moves for the reason publishing moves it: this decides
        // who reads the page, and a content save built on the copy from before
        // it should be told rather than applied.
        data: { visibility: input.visibility, revision: { increment: 1 } },
      });

      if (claimed.count === 0) {
        throw new PageWriteError(
          "The page changed after it was read.",
          "page-changed",
        );
      }

      const updated = await tx.page.findUniqueOrThrow({
        where: { id },
        select: PAGE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "PAGE_VISIBILITY_CHANGED",
          ...auditActor(actor),
          targetKind: "page",
          targetId: id,
          context: {
            slug: updated.slug,
            from: page.visibility,
            to: input.visibility,
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
   * Puts the pages in the order the ids arrive in.
   *
   * Order alone, and nothing reads meaning into it here beyond the front page
   * being the lowest of it. What the ordering is FOR is the menu the board
   * arranges, which is a later change and owns that question.
   *
   * Ids the instance does not have are ignored rather than refused: this is a
   * drag on a list, and a stale row in the browser must not lose the whole
   * arrangement.
   */
  async reorder(
    ids: readonly string[],
    actor: ActorContext,
  ): Promise<PageAdminView[]> {
    /*
     * Interactive rather than the array form, which cannot carry the audit
     * entry: the entry has to commit or roll back with the arrangement it
     * records.
     */
    await this.prisma.$transaction(
      async (tx) => {
        await lockPageOrder(tx);
        for (const [index, id] of ids.entries()) {
          await tx.page.updateMany({
            where: { id },
            data: { sortOrder: index },
          });
        }

        // The count of ids the board sent, not of rows that moved: ids the
        // instance does not have are ignored, so how many rows changed is not a
        // number this call knows.
        await this.audit.record(
          {
            action: "PAGE_REORDERED",
            ...auditActor(actor),
            targetKind: "page",
            targetId: null,
            context: { count: ids.length },
          },
          tx,
        );
      },
      /*
       * The interactive form costs one round trip per id where the array form
       * sent one batch, and both the route and `page_reorder` cap the list at
       * 500 - so the default five-second budget is reachable on a loaded
       * database. Exceeding it aborts the whole arrangement with P2028 after
       * the row locks have been held for the duration, which tells the board
       * nothing it can act on. The budget is stated rather than the loop
       * removed, because what forces the loop is the audit entry committing
       * with the arrangement.
       */
      { timeout: 30_000 },
    );
    return this.list();
  }

  /**
   * Removes a page.
   *
   * Deleting a published page takes it off the website, so it is recorded as
   * the publication change it is - in the same transaction, like every other
   * one. A draft nobody could read leaves no entry: there was nothing published
   * to stop being so.
   *
   * The precondition matters most here of the four writes that take one,
   * because this is the one with nothing to read again afterwards: a board
   * member deleting a page on the strength of a copy somebody else has since
   * rewritten is deleting work they never saw. The revision sits in the
   * delete's own predicate, so a claim that matches nothing is a refusal.
   *
   * Whether the page was published is read off the row the delete took rather
   * than off the read above. A page published between the two would otherwise
   * leave the website with no entry saying so - the one record ADR 0006 asks
   * of every publication change.
   *
   * The page's menu entries go with it, by cascade, and so do the entries
   * hanging under them. Each entry pointing at the page is recorded as the
   * removal it is, with how many hung under it, exactly as the menu's own
   * removal records one: every menu write is audited, and this is one reached
   * through the page rather than through the menu. The menu lock is what makes
   * the record true - nothing can be hung under those entries, or pointed at
   * this page, between the read that finds them and the delete that takes them.
   */
  async remove(
    id: string,
    input: {
      /** @see PageUpdateInput.expectedRevision */
      expectedRevision?: number;
    },
    actor: ActorContext,
  ): Promise<void> {
    await this.require(id);

    const removed = await this.prisma.$transaction(async (tx) => {
      await lockMenu(tx);
      const entries = await tx.menuItem.findMany({
        where: { pageId: id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          kind: true,
          parentId: true,
          _count: { select: { children: true } },
        },
      });
      /*
       * An entry hanging under another entry for the same page goes with its
       * parent, and the parent's record already counts it among the children
       * it took. Recording it again would say two removals happened where the
       * board made one.
       */
      const pointing = new Set(entries.map((entry) => entry.id));
      const recorded = entries.filter(
        (entry) => entry.parentId === null || !pointing.has(entry.parentId),
      );

      let deleted: { slug: string; published: boolean };
      try {
        deleted = await tx.page.delete({
          where: {
            id,
            ...(input.expectedRevision === undefined
              ? {}
              : { revision: input.expectedRevision }),
          },
          select: { slug: true, published: true },
        });
      } catch (cause) {
        // Nothing matched: the page is not the one the caller read, or it is
        // no longer there at all.
        if (
          cause instanceof Prisma.PrismaClientKnownRequestError &&
          cause.code === "P2025"
        ) {
          throw new PageWriteError(
            "The page changed after it was read.",
            "page-changed",
          );
        }
        throw cause;
      }

      if (deleted.published) {
        await this.audit.record(
          {
            action: "PAGE_PUBLISHED",
            ...auditActor(actor),
            targetKind: "page",
            targetId: id,
            context: { slug: deleted.slug, published: false, deleted: true },
          },
          tx,
        );
      }

      for (const entry of recorded) {
        await this.audit.record(
          {
            action: "MENU_ITEM_REMOVED",
            ...auditActor(actor),
            targetKind: "menuItem",
            targetId: entry.id,
            context: {
              kind: entry.kind,
              childrenRemoved: entry._count.children,
              // Why it went, since nobody removed it from the menu itself.
              withPage: id,
            },
          },
          tx,
        );
      }

      return deleted;
    });

    this.logger.log(`Removed the page at /${removed.slug}`);
  }

  /**
   * The publication guardrails, in one place.
   *
   * Called by every write that leaves a page readable, and by nothing else.
   */
  private async enforceGuardrails(input: {
    title: string;
    content: PageContent;
    photoConsentConfirmed: boolean;
  }): Promise<void> {
    this.refusePersonalIdentityNumbers(input.title, input.content);
    await this.refuseUnconsentedPictures(
      input.content,
      input.photoConsentConfirmed,
    );
  }

  /**
   * Refuses a page carrying a Swedish personal identity number.
   *
   * A personnummer on a public page is a disclosure the association cannot take
   * back, and the ordinary way one arrives is by being pasted along with the
   * text around it rather than by anybody deciding to publish it. The scan runs
   * the anchored validator over unanchored candidates, so a date, an invoice
   * number or an organisation number does not stop the board publishing.
   */
  private refusePersonalIdentityNumbers(
    title: string,
    content: PageContent,
  ): void {
    const locations: PageTextLocation[] = [
      ...scanForPersonalIdentityNumbers(title).map((hit): PageTextLocation => ({
        part: "title",
        index: 0,
        offset: hit.index,
      })),
      ...identityNumbersInBody(content),
    ];

    if (locations.length > 0) {
      throw new PageWriteError(
        "The page carries a personal identity number and cannot be published.",
        "personal-identity-number",
        locations,
      );
    }
  }

  /**
   * Refuses a picture of identifiable people without a confirmed consent.
   *
   * The declaration made when the file was uploaded is the input; the
   * confirmation on this write is the board saying the consents exist. Coarse,
   * deliberately, and the coarseness is written down rather than implied: it
   * does not tie a face to a consent row, so it cannot catch a board that
   * confirms without asking. What it does catch is the ordinary case - a
   * photograph of a summer party dropped onto the front page by somebody who
   * had not thought about it - and that is the case the guardrail exists for.
   *
   * A picture the instance does not have, and one whose file is not public, are
   * refused here too. Either would leave a published page with a broken picture
   * on it, and finding that out from a visitor is worse than being told now.
   */
  private async refuseUnconsentedPictures(
    content: PageContent,
    photoConsentConfirmed: boolean,
  ): Promise<void> {
    const references = imageReferences(content);
    if (references.length === 0) {
      return;
    }

    const files = await this.prisma.mediaFile.findMany({
      where: { id: { in: references.map((one) => one.mediaFileId) } },
      select: { id: true, visibility: true, showsIdentifiablePersons: true },
    });
    const byId = new Map(files.map((file) => [file.id, file]));

    const missing: number[] = [];
    const notPublic: number[] = [];
    const identifiable: number[] = [];

    for (const reference of references) {
      const file = byId.get(reference.mediaFileId);
      if (file === undefined) {
        missing.push(reference.index);
        continue;
      }
      if (file.visibility !== "PUBLIC") {
        notPublic.push(reference.index);
        continue;
      }
      if (file.showsIdentifiablePersons === true) {
        identifiable.push(reference.index);
      }
    }

    if (missing.length > 0) {
      throw new PageWriteError(
        "The page refers to a picture this instance does not hold.",
        "image-not-found",
        blocksAt(missing),
      );
    }
    if (notPublic.length > 0) {
      throw new PageWriteError(
        "The page refers to a picture that is not served publicly.",
        "image-not-public",
        blocksAt(notPublic),
      );
    }
    if (identifiable.length > 0 && !photoConsentConfirmed) {
      throw new PageWriteError(
        "A picture on the page shows identifiable persons, and the publication consents have not been confirmed.",
        "photo-consent-required",
        blocksAt(identifiable),
      );
    }
  }

  private async require(id: string) {
    const row = await this.prisma.page.findUnique({
      where: { id },
      select: PAGE_COLUMNS,
    });
    if (row === null) {
      throw new PageWriteError("There is no such page.", "not-found");
    }
    return row;
  }

  /**
   * Refuses an address a page may not have, or already has.
   *
   * Two different refusals rather than one, because they need two different
   * answers on the screen: "that address cannot be used" is about the text
   * typed, and "that address is taken" is about another page.
   */
  private async requireFreeSlug(
    slug: string,
    exceptPageId: string | null,
  ): Promise<void> {
    if (!isUsableSlug(slug)) {
      throw new PageWriteError(
        `The address /${slug} cannot be used for a page.`,
        "invalid-slug",
      );
    }

    const existing = await this.prisma.page.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing !== null && existing.id !== exceptPageId) {
      throw new PageWriteError(
        `The address /${slug} is already a page.`,
        "slug-taken",
      );
    }
  }
}

/**
 * Answers a lost race for an address with the refusal `requireFreeSlug` gives.
 *
 * The read there narrows the window and the unique index closes it. Two
 * creates or renames to one address at the same moment both pass the read, and
 * the second write raises P2002 - which, unanswered, reaches the caller as a
 * 500 for a conflict its client already knows how to show.
 */
function refuseTakenSlug(slug: string): (cause: unknown) => never {
  return (cause) => {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      throw new PageWriteError(
        `The address /${slug} is already a page.`,
        "slug-taken",
      );
    }
    throw cause;
  };
}

/**
 * The sort order a new page is written with, after moving the privacy notice
 * out of its way when it has to.
 *
 * After the last page, not counting the notice. When the notice is at the end
 * of the board's list, where it is seeded, the new page goes directly before it
 * and the notice moves one place down - otherwise a list the board has
 * rearranged, which numbers every page from nought and the notice with them,
 * would hand the new page the notice's own number and show it after the
 * notice. When the board has moved the notice up the list, its arrangement is
 * left alone and the new page goes at the end.
 *
 * The root's fallback leaves the notice out by its slug, so this placement is
 * about the list and not about which page is the front page. Called under the
 * page order lock, so nothing rearranges the list between the reads and the
 * writes.
 */
async function placeNewPage(tx: Prisma.TransactionClient): Promise<number> {
  const highest = await tx.page.aggregate({
    where: { slug: { not: PRIVACY_NOTICE_SLUG } },
    _max: { sortOrder: true },
  });
  const notice = await tx.page.findUnique({
    where: { slug: PRIVACY_NOTICE_SLUG },
    select: { sortOrder: true },
  });

  const last = highest._max.sortOrder;
  const placed = (last ?? 0) + 1;
  const noticeAtTheEnd =
    notice !== null && (last === null || notice.sortOrder > last);
  if (noticeAtTheEnd && notice.sortOrder <= placed) {
    await tx.page.update({
      where: { slug: PRIVACY_NOTICE_SLUG },
      data: { sortOrder: placed + 1 },
      select: { id: true },
    });
  }
  return placed;
}

/** The range of PostgreSQL's `integer`, which `Page.sortOrder` is stored as. */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

/**
 * The position a `listSummaries` cursor names: a sort order and an id.
 *
 * Refused as a page that is not there when it is not one this service wrote,
 * rather than read as the start of the list - which would hand a caller that
 * sent a stale or mangled cursor the first pages again as if they were the
 * next ones.
 *
 * The sort order is held to the column's own range: ten digits reach past a
 * 32-bit integer, and the database answers such a value with an error rather
 * than an empty list, which the caller would read as a failure of ours.
 */
function readPageCursor(cursor: string): { sortOrder: number; id: string } {
  const match = /^(-?\d{1,10}):([^:]+)$/.exec(cursor);
  const sortOrder = Number(match?.[1]);
  const id = match?.[2];
  if (
    id === undefined ||
    !Number.isInteger(sortOrder) ||
    sortOrder < INT4_MIN ||
    sortOrder > INT4_MAX
  ) {
    throw new PageWriteError(
      "There is no such place in the list of pages. Start it again without a cursor.",
      "not-found",
    );
  }
  return { sortOrder, id };
}

/** The blocks at these positions, as the one location shape. */
function blocksAt(indexes: readonly number[]): PageTextLocation[] {
  return indexes.map((index) => ({ part: "block", index }));
}

function toAdminView(row: {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: Date | null;
  sortOrder: number;
  revision: number;
  updatedAt: Date;
}): PageAdminView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    // Read through the same parser the renderer uses, so the editor is shown
    // what the website would actually put on the page and never more.
    content: readPageContent(row.content),
    visibility: row.visibility,
    published: row.published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    revision: row.revision,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Cast at the persistence boundary: Prisma types a JSON column with its own
 * recursive InputJsonValue, which a declared object type does not satisfy.
 */
function asJson(content: PageContent): Prisma.InputJsonObject {
  return content as unknown as Prisma.InputJsonObject;
}
