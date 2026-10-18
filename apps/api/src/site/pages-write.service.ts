import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  numberedSlug,
  PAGE_SLUG_MAX_LENGTH,
  type PageWriteReason,
  scanForPersonalIdentityNumbers,
  slugFromTitle,
} from "@openbrf/shared";

import type { ActorContext } from "../audit/actor-context";
import { auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { isUniqueViolation } from "../database/unique-violation";
import { Prisma } from "../generated/prisma/client";
import type { PageStatus } from "../generated/prisma/enums";
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
          reason === "slug-taken" ||
            reason === "page-changed" ||
            // The page is the front page, and another has to be chosen first:
            // a state of the site the caller can change, not a fault in what
            // it sent.
            reason === "front-page"
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
  status: PageStatus;
  /** Whether the root of the website serves this page. */
  frontPage: boolean;
  /** Whether a rename still moves the address with the title. */
  slugFollowsTitle: boolean;
  publishedAt: string | null;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

/** A page as the board's own screen shows it: everything, drafts included. */
export interface PageAdminView {
  id: string;
  slug: string;
  title: string;
  content: PageContent;
  status: PageStatus;
  /** Whether the root of the website serves this page. */
  frontPage: boolean;
  /**
   * Whether a rename still moves the address with the title: true until the
   * page is first published or the board writes an address by hand.
   */
  slugFollowsTitle: boolean;
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
  /**
   * The address, when the board wrote one by hand. Absent, the page takes its
   * address from its title, numbered when that address is taken or reserved.
   */
  slug?: string | undefined;
  title: string;
  content: PageContent;
}

export interface UpdatePageInput {
  /**
   * An address written by hand, which the page keeps from then on.
   *
   * Absent keeps the address the page has - or, while it still follows the
   * title, moves it to the one the new title gives.
   */
  slug?: string | undefined;
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

/** What a page's status says about whether anybody can read it. */
function isPublished(status: PageStatus): boolean {
  return status !== "DRAFT";
}

/**
 * How many times a write made from a title tries the next free address.
 *
 * Each retry means another write took the address this one picked between the
 * read that found it free and the insert, so a third in a row is somebody
 * creating pages with that title as fast as they can; the board is then told
 * the address is taken rather than the write spinning.
 */
const SLUG_ATTEMPTS = 3;

/**
 * As many numbered addresses as one title is tried with. A board with this
 * many pages of one title has a problem an address will not solve.
 */
const SLUG_NUMBERS = 1000;

const PAGE_COLUMNS = {
  id: true,
  slug: true,
  slugFollowsTitle: true,
  title: true,
  content: true,
  status: true,
  frontPage: true,
  publishedAt: true,
  sortOrder: true,
  revision: true,
  updatedAt: true,
} as const;

/**
 * The board's side of the association's pages: writing them, publishing them,
 * deciding who each one is for, and choosing which one the root serves.
 *
 * One service, because the publication guardrails are one rule set and a second
 * write path would be a second place to forget them. Every route that can make
 * a page readable by somebody goes through here, and here is where the two
 * refusals live:
 *
 *   A personal identity number is refused. Whenever a write leaves a page
 *   published - editing one that is, or giving one the status members only or
 *   public - every piece of text on it is scanned, and a hit refuses the write
 *   naming the block and the offset. Not the value: the value is the thing that
 *   must not be repeated.
 *
 *   A picture of identifiable people is refused unless the board confirms the
 *   publication consents. Coarse on purpose this train: the check is the
 *   declaration made at upload plus a confirmation on the write, rather than a
 *   link from each face to a consent row. It is applied to any published page
 *   and not only a public one, because the file behind a picture is stored
 *   public and is therefore fetchable by whoever holds its address whatever the
 *   page's own status says.
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
        ...(options.publishedOnly === true
          ? { status: { not: "DRAFT" as const } }
          : {}),
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
        slugFollowsTitle: true,
        title: true,
        status: true,
        frontPage: true,
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
        status: row.status,
        frontPage: row.frontPage,
        slugFollowsTitle: row.slugFollowsTitle,
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
   * A draft, always. A page is written before it is meant to be read, and
   * publishing is a separate act with a separate record in the audit log -
   * which is also why creating one needs no guardrail run: nothing it holds is
   * readable by anyone yet.
   *
   * Its address is made from its title unless the board wrote one, so a board
   * member creating a page never has to think of one. A title whose address is
   * reserved or already a page's is given the next free number instead -
   * `styrelsen-2` - because refusing it would be asking the board to solve a
   * problem the product can.
   */
  async create(
    input: CreatePageInput,
    actor: ActorContext,
  ): Promise<PageAdminView> {
    const typed = input.slug;
    if (typed !== undefined) {
      await this.requireFreeSlug(typed, null);
    }

    const row = await this.withFreeSlug(
      async () => typed ?? (await this.freeSlugFor(input.title, null)),
      typed !== undefined,
      async (slug) =>
        this.prisma.$transaction(async (tx) => {
          await lockPageOrder(tx);
          const sortOrder = await placeNewPage(tx);

          const created = await tx.page.create({
            data: {
              slug,
              // A typed address is the board's choice and stays; one made from
              // the title moves with it until the page is published.
              slugFollowsTitle: typed === undefined,
              title: input.title,
              content: asJson(input.content),
              status: "DRAFT",
              sortOrder,
            },
            select: PAGE_COLUMNS,
          });

          await this.audit.record(
            {
              action: "PAGE_CONTENT_CHANGED",
              ...auditActor(actor),
              targetKind: "page",
              targetId: created.id,
              context: {
                slug: created.slug,
                blockCount: input.content.blocks.length,
                status: created.status,
                created: true,
              },
            },
            tx,
          );

          return created;
        }),
    );

    return toAdminView(row);
  }

  /**
   * Rewrites a page's title and body, and its address.
   *
   * Not its status and not whether it is the front page: those decide who can
   * read it and what the root serves, they are what the audit log records,
   * and giving them a second way in through the ordinary save would be a
   * second way for the record to be missed.
   *
   * The address moves with the title while the page still follows it - it has
   * never been published, and the board has not written one by hand. After
   * that a rename leaves the address alone, because somebody may have it; only
   * an address the caller sends changes it.
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
    const typed = input.slug;
    if (typed !== undefined) {
      await this.requireFreeSlug(typed, id);
    }

    if (isPublished(page.status)) {
      await this.enforceGuardrails({
        title: input.title,
        content: input.content,
        photoConsentConfirmed: input.photoConsentConfirmed === true,
      });
    }

    const slugFor = async (): Promise<string> =>
      typed ??
      (page.slugFollowsTitle
        ? await this.freeSlugFor(input.title, id)
        : page.slug);

    return this.withFreeSlug(slugFor, typed !== undefined, async (slug) =>
      this.claimAndRecord(id, actor, (tx) =>
        tx.page.updateMany({
          /*
           * Claimed against the copy the caller read, when they said which. An
           * updateMany with the revision in its where clause is one statement:
           * it either matches the row as it still stands and writes, or matches
           * nothing and writes nothing. A read followed by a compare would leave
           * the same gap between them that the precondition exists to close.
           *
           * The status as well, whether or not a revision was sent. The
           * guardrails above ran against the page this read found, and they are
           * skipped for a draft: a page published between that read and this
           * write would take content nothing checked. Claiming on it means such
           * a save is refused rather than applied - and the caller reads the
           * page again, where the guardrails will run. It is also what keeps an
           * address made from the title off a page that was published in
           * between, whose address is settled.
           */
          where: {
            id,
            status: page.status,
            ...(input.expectedRevision === undefined
              ? {}
              : { revision: input.expectedRevision }),
          },
          data: {
            slug,
            // An address the board typed is theirs from now on.
            ...(typed === undefined ? {} : { slugFollowsTitle: false }),
            title: input.title,
            content: asJson(input.content),
            /*
             * In the same statement as the content it belongs to, so the next
             * caller's claim reads a number that moved with the page. It moves
             * on a save that sent no precondition too: it says the page is not
             * the one somebody else read, and a save that left it alone would
             * let their stale claim match afterwards.
             */
            revision: { increment: 1 },
          },
        }),
      ),
    );
  }

  /**
   * Runs a write that takes an address, answering a lost race for it.
   *
   * The read that found the address free narrows the window and the unique
   * index closes it: two writes to one address at the same moment both pass
   * the read, and the second raises P2002. An address the board typed is then
   * refused as taken, as `requireFreeSlug` would have. One made from a title is
   * the product's choice rather than the board's, so the next free number is
   * tried instead, a few times.
   */
  private async withFreeSlug<T>(
    slugFor: () => Promise<string>,
    typed: boolean,
    write: (slug: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const slug = await slugFor();
      try {
        return await write(slug);
      } catch (cause) {
        if (!typed && attempt < SLUG_ATTEMPTS && isUniqueViolation(cause)) {
          continue;
        }
        return refuseTakenSlug(slug)(cause);
      }
    }
  }

  /**
   * The address a title gives a page: the title's own, or the first numbered
   * one that is usable and not another page's.
   *
   * One read for every candidate rather than one per number. Every candidate
   * starts with the title's address cut short enough to carry a number, so the
   * pages that could stand in the way are the ones whose address starts with
   * that.
   */
  private async freeSlugFor(
    title: string,
    exceptPageId: string | null,
  ): Promise<string> {
    const base = slugFromTitle(title);
    const prefix = base.slice(
      0,
      PAGE_SLUG_MAX_LENGTH - `-${String(SLUG_NUMBERS)}`.length,
    );
    const others = await this.prisma.page.findMany({
      where: {
        slug: { startsWith: prefix },
        ...(exceptPageId === null ? {} : { id: { not: exceptPageId } }),
      },
      select: { slug: true },
    });
    const taken = new Set(others.map((other) => other.slug));

    for (let n = 1; n <= SLUG_NUMBERS; n += 1) {
      const candidate = numberedSlug(base, n);
      if (isUsableSlug(candidate) && !taken.has(candidate)) {
        return candidate;
      }
    }
    throw new PageWriteError(
      `Every address the title gives is already a page.`,
      "slug-taken",
    );
  }

  /**
   * Runs one claim and records the content change it made, together.
   *
   * The save above needs two things together: a conditional write that either
   * matches the page as it still stands or matches nothing, and an audit entry
   * that commits with it. A rewritten page whose entry was lost
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
            status: updated.status,
          },
        },
        tx,
      );

      return updated;
    });

    return toAdminView(row);
  }

  /**
   * Gives a page its status: a draft, for the members only, or public.
   *
   * One act for what used to be two - publishing and choosing an audience -
   * because the board makes one choice. It is still recorded as the change it
   * is: a page put on the website or taken off it is `PAGE_PUBLISHED`, and a
   * published page moved between the members and the street is
   * `PAGE_VISIBILITY_CHANGED`, so the audit log reads the same across the
   * upgrade.
   *
   * The audit entry and the change share a transaction, so the log cannot claim
   * a publication that was rolled back or miss one that stood. A write that
   * changes nothing writes nothing: choosing the status a page already has is
   * not an event.
   *
   * The front page stays public. Taking it down, or closing it to the members,
   * would answer the root with the not-found document for every visitor
   * without a session, so the board is told to choose another front page
   * first rather than finding out from a neighbour.
   */
  async setStatus(
    id: string,
    input: {
      status: PageStatus;
      photoConsentConfirmed?: boolean | undefined;
      /** @see UpdatePageInput.expectedRevision */
      expectedRevision?: number | undefined;
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

    if (page.status === input.status) {
      return toAdminView(page);
    }

    if (page.frontPage && input.status !== "PUBLIC") {
      throw new PageWriteError(
        "The page is the front page. Choose another front page first.",
        "front-page",
      );
    }

    const publishing = isPublished(input.status);
    if (publishing) {
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
       *
       * And, when the page is leaving public, that it is still not the front
       * page: one chosen in that window would otherwise be taken down under the
       * root, which the CHECK on the table would refuse as a fault rather than
       * as the conflict it is.
       */
      const claimed = await tx.page.updateMany({
        where: {
          id,
          revision: page.revision,
          status: page.status,
          ...(input.status === "PUBLIC" ? {} : { frontPage: false }),
        },
        data: {
          status: input.status,
          // Kept once set. It is when the page was first published, and a
          // republish after a correction does not make it a newer page.
          publishedAt:
            publishing && page.publishedAt === null
              ? new Date()
              : page.publishedAt,
          // Published, the address is settled for good: somebody may have it
          // now, and a rename must not break it.
          ...(publishing ? { slugFollowsTitle: false } : {}),
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
        isPublished(page.status) === publishing
          ? {
              action: "PAGE_VISIBILITY_CHANGED",
              ...auditActor(actor),
              targetKind: "page",
              targetId: id,
              context: {
                slug: updated.slug,
                from: page.status,
                to: input.status,
                published: true,
              },
            }
          : {
              action: "PAGE_PUBLISHED",
              ...auditActor(actor),
              targetKind: "page",
              targetId: id,
              context: {
                slug: updated.slug,
                published: publishing,
                status: input.status,
              },
            },
        tx,
      );

      return updated;
    });

    return toAdminView(row);
  }

  /**
   * Makes a page the one the root of the website serves.
   *
   * Exactly one front page at a time, so choosing one clears the one before it,
   * in the same transaction. There is no way to clear the choice without making
   * another: an association's front door is a page the board chose, and the
   * fallback the root has for an instance with none is for an instance that
   * has not chosen yet rather than a setting.
   *
   * Public only. The front page is the one address on the website that never
   * asks who is reading, so a draft or a members' page there would be the
   * not-found document for every visitor without a session.
   *
   * The page's revision does not move. Which page is the front page is a fact
   * about the site rather than about this copy of the page, and a board member
   * mid-way through rewriting it should not be told somebody else wrote it.
   */
  async setFrontPage(
    id: string,
    input: {
      /** @see UpdatePageInput.expectedRevision */
      expectedRevision?: number | undefined;
    },
    actor: ActorContext,
  ): Promise<PageAdminView> {
    const page = await this.require(id);
    refuseStalePrecondition(page, input.expectedRevision);

    if (page.frontPage) {
      return toAdminView(page);
    }
    if (page.status !== "PUBLIC") {
      throw new PageWriteError(
        "Only a public page can be the front page.",
        "front-page-not-public",
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Two boards choosing at once take turns. Without it both would clear the
       * old front page, and the second to set its own would meet the index that
       * allows one - as a fault rather than as the choice it lost to.
       */
      await lockFrontPage(tx);

      const previous = await tx.page.findFirst({
        where: { frontPage: true },
        select: { id: true },
      });
      if (previous !== null) {
        await tx.page.update({
          where: { id: previous.id },
          data: { frontPage: false },
          select: { id: true },
        });
      }

      /*
       * Still public, and still the copy the caller read when they said which,
       * claimed in the statement that makes it the front page. The check above
       * ran before the lock, and a board waiting for the lock waits while
       * somebody else saves: a page taken down or rewritten since is not one to
       * put under the root, and the root would serve words the caller never
       * saw. Refusing here rolls back the clearing of the former front page.
       * The revision is claimed but not moved: see above.
       */
      const claimed = await tx.page.updateMany({
        where: {
          id,
          status: "PUBLIC",
          ...(input.expectedRevision === undefined
            ? {}
            : { revision: input.expectedRevision }),
        },
        data: { frontPage: true },
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
          action: "PAGE_FRONT_PAGE_CHANGED",
          ...auditActor(actor),
          targetKind: "page",
          targetId: id,
          context: { slug: updated.slug, previous: previous?.id ?? null },
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
   * Order alone, and nothing reads meaning into it here. The front page is the
   * board's own choice and never the lowest of it; the order is only the
   * root's last fallback on an instance where nothing has been chosen.
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
   *
   * The front page is not removed. The board chooses another first, for the
   * reason it cannot be taken down: the root would answer the not-found
   * document to everyone.
   */
  async remove(
    id: string,
    input: {
      /** @see PageUpdateInput.expectedRevision */
      expectedRevision?: number;
    },
    actor: ActorContext,
  ): Promise<void> {
    const page = await this.require(id);
    if (page.frontPage) {
      throw new PageWriteError(
        "The page is the front page. Choose another front page first.",
        "front-page",
      );
    }

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

      let deleted: { slug: string; status: PageStatus };
      try {
        deleted = await tx.page.delete({
          where: {
            id,
            // Still not the front page: one chosen since the read above is
            // refused as the page having changed, which it has.
            frontPage: false,
            ...(input.expectedRevision === undefined
              ? {}
              : { revision: input.expectedRevision }),
          },
          select: { slug: true, status: true },
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

      if (isPublished(deleted.status)) {
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
 * The lock a transaction takes before it changes which page is the front page.
 *
 * An advisory lock for the reason `menu-lock.ts` gives, and beside its one
 * writer rather than in a file of its own because there is only the one.
 */
async function lockFrontPage(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"site-front-page"}))`;
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
    if (isUniqueViolation(cause)) {
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
 * Which page is the front page is the board's choice and not the list's, so
 * this placement is about the list alone. Called under the
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
  slugFollowsTitle: boolean;
  status: PageStatus;
  frontPage: boolean;
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
    status: row.status,
    frontPage: row.frontPage,
    slugFollowsTitle: row.slugFollowsTitle,
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
