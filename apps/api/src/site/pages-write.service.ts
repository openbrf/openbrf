import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import {
  imageReferences,
  type PageContent,
  pageTextParts,
  readPageContent,
} from "./page-content";
import { isUsableSlug } from "./pages.service";

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
  /** Where in that text the value starts. */
  offset: number;
}

export type PageWriteReason =
  | "not-found"
  | "invalid-slug"
  | "slug-taken"
  | "personal-identity-number"
  | "photo-consent-required"
  | "image-not-found"
  | "image-not-public";

export class PageWriteError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: PageWriteReason,
    private readonly found: {
      locations?: readonly PageTextLocation[];
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
            : // The request was understood and refused on its merits: this page
              // may not be published as it stands, and the board is told which
              // part of it to change.
              HttpStatus.UNPROCESSABLE_ENTITY;
  }

  override details(): Record<string, readonly unknown[]> {
    return {
      locations: this.found.locations ?? [],
      blocks: this.found.blocks ?? [],
    };
  }
}

/** A page as the board's own screen shows it: everything, drafts included. */
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
   * Writes a new page.
   *
   * Unpublished, always. A page is written before it is meant to be read, and
   * publishing is a separate act with a separate record in the audit log -
   * which is also why creating one needs no guardrail run: nothing it holds is
   * readable by anyone yet.
   */
  async create(input: CreatePageInput): Promise<PageAdminView> {
    await this.requireFreeSlug(input.slug, null);

    const highest = await this.prisma.page.aggregate({
      _max: { sortOrder: true },
    });

    const row = await this.prisma.page.create({
      data: {
        slug: input.slug,
        title: input.title,
        content: asJson(input.content),
        visibility: input.visibility,
        published: false,
        sortOrder: (highest._max.sortOrder ?? 0) + 1,
      },
      select: PAGE_COLUMNS,
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
   */
  async update(id: string, input: UpdatePageInput): Promise<PageAdminView> {
    const page = await this.require(id);
    await this.requireFreeSlug(input.slug, id);

    if (page.published) {
      await this.enforceGuardrails({
        title: input.title,
        content: input.content,
        photoConsentConfirmed: input.photoConsentConfirmed === true,
      });
    }

    const row = await this.prisma.page.update({
      where: { id },
      data: {
        slug: input.slug,
        title: input.title,
        content: asJson(input.content),
      },
      select: PAGE_COLUMNS,
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
      actorPersonId: string;
    },
  ): Promise<PageAdminView> {
    const page = await this.require(id);

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
      const updated = await tx.page.update({
        where: { id },
        data: {
          published: input.published,
          // Kept once set. It is when the page was first published, and a
          // republish after a correction does not make it a newer page.
          publishedAt:
            input.published && page.publishedAt === null
              ? new Date()
              : page.publishedAt,
        },
        select: PAGE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "PAGE_PUBLISHED",
          actorPersonId: input.actorPersonId,
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
      actorPersonId: string;
    },
  ): Promise<PageAdminView> {
    const page = await this.require(id);

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
      const updated = await tx.page.update({
        where: { id },
        data: { visibility: input.visibility },
        select: PAGE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "PAGE_VISIBILITY_CHANGED",
          actorPersonId: input.actorPersonId,
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
  async reorder(ids: readonly string[]): Promise<PageAdminView[]> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.page.updateMany({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
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
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    const page = await this.require(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.page.delete({ where: { id } });

      if (page.published) {
        await this.audit.record(
          {
            action: "PAGE_PUBLISHED",
            actorPersonId,
            targetKind: "page",
            targetId: id,
            context: { slug: page.slug, published: false, deleted: true },
          },
          tx,
        );
      }
    });

    this.logger.log(`Removed the page at /${page.slug}`);
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
      ...pageTextParts(content).flatMap((part) =>
        scanForPersonalIdentityNumbers(part.text).map(
          (hit): PageTextLocation => ({
            part: "block",
            index: part.index,
            offset: hit.index,
          }),
        ),
      ),
    ];

    if (locations.length > 0) {
      throw new PageWriteError(
        "The page carries a personal identity number and cannot be published.",
        "personal-identity-number",
        { locations },
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
        { blocks: missing },
      );
    }
    if (notPublic.length > 0) {
      throw new PageWriteError(
        "The page refers to a picture that is not served publicly.",
        "image-not-public",
        { blocks: notPublic },
      );
    }
    if (identifiable.length > 0 && !photoConsentConfirmed) {
      throw new PageWriteError(
        "A picture on the page shows identifiable persons, and the publication consents have not been confirmed.",
        "photo-consent-required",
        { blocks: identifiable },
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

function toAdminView(row: {
  id: string;
  slug: string;
  title: string;
  content: unknown;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: Date | null;
  sortOrder: number;
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
