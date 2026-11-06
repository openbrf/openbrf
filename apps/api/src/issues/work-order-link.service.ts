import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  localDayOf,
  normalizeFreeText,
  scanForPersonalIdentityNumbers,
  WORK_ORDER_LIMITS,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { failureName } from "../logging/failure";
import { readImageHeader } from "../media/image-bytes";
import { extensionOf } from "../storage/storage-key";
import {
  MediaError,
  MediaService,
  mediaUrl,
  type ServedFile,
} from "../media/media.service";
import { requireHandledIssueForWrite } from "./issue-handlers";
import {
  HOUSEHOLD_PROTECTION_TRANSACTION,
  lockHouseholdProtection,
  lockIssue,
  lockIssueForHandling,
  lockIssueType,
} from "./issue-lock";
import { type ContractorNoticeKind, IssueMailer } from "./issue-mailer.service";
import { IssueError } from "./issue.error";
import {
  type LiveWorkOrderLink,
  liveWorkOrderLinkByDigest,
  liveWorkOrderLinksOfIssue,
  revokeWorkOrderLinks,
  showsProtectedHousehold,
  WORK_ORDER_LINK_DAYS,
  type WorkOrderLinkState,
} from "./work-order-link";
import {
  hasWorkOrderLinkTokenForm,
  mintWorkOrderLinkToken,
  workOrderLinkDigest,
} from "./work-order-link-token";

/**
 * Where a contractor's page lives, on the website's origin: one static segment
 * the board cannot claim for a page (`pages.service.ts`), then the token.
 */
export const WORK_ORDER_LINK_PATH = "/arbetsorder";

/** The segment below the token that a photograph is posted to and read from. */
export const WORK_ORDER_LINK_PHOTO_SEGMENT = "foto";

/**
 * Notes one link may write in an hour, counted in the database against the
 * work order it opens, so a link that leaked and is used from many addresses
 * shares one budget (control D4 of the threat review).
 */
export const WORK_ORDER_LINK_NOTES_PER_HOUR = 10;

/** Notes a work order may carry in all: a job, not a channel. */
export const WORK_ORDER_LINK_NOTES_PER_WORK_ORDER = 50;

/** Photographs one link may add in an hour, counted as notes are. */
export const WORK_ORDER_LINK_PHOTOS_PER_HOUR = 5;

/**
 * Photographs a work order may carry from its contractor in all, and their
 * size together (control G3). Beside the per-file `OPENBRF_MAX_UPLOAD_BYTES`.
 * Only a handler creates a work order and its link ends within 30 days, so a
 * cap per work order bounds what one stranger can put on the disk.
 */
export const WORK_ORDER_LINK_PHOTOS_PER_WORK_ORDER = 10;
export const WORK_ORDER_LINK_BYTES_PER_WORK_ORDER = 30 * 1024 * 1024;

/**
 * The most pixels a contractor's photograph may have (control G6). Every
 * handler's browser that opens the issue decodes it, and the per-side bound
 * of the media layer lets a few kilobytes declare 400 megapixels. Forty is
 * more than any phone camera takes.
 */
export const WORK_ORDER_LINK_MAX_PIXELS = 40_000_000;

/** Photographs a handler may choose for one work order's link. */
export const WORK_ORDER_LINK_CHOSEN_PHOTOS = 20;

/** What a contractor can answer through the link. */
export type WorkOrderLinkAnswer = "accept" | "decline" | "done";

/**
 * The page a contractor's link shows, and nothing more (ADR 0055, controls H1
 * and H3 of the threat review).
 *
 * Built field by field from what is allowed, never by passing a work order or
 * an issue on: the work order's text as the handler wrote and previewed it,
 * whom it was written to, the day it was sent as its reference, the
 * photographs the board chose, and the contractor's own answer, notes and
 * photographs. No issue number, no type, no report, no reporter, no address,
 * no conversation, no handler's name and no other work order: there is no
 * field here that could hold one.
 */
export interface WorkOrderLinkPageView {
  /** The work order's own reference: the day it was sent (control C4). */
  sentAt: Date;
  /** The name the work order was written to: the contractor's own. */
  recipientName: string;
  body: string;
  /**
   * Whether the contractor has accepted it. A decline or done ends the link,
   * so the page never shows either.
   */
  accepted: boolean;
  /** When the link stops opening the work order, if nothing ends it sooner. */
  expiresAt: Date;
  /** The photographs the board chose, as file identifiers inside the grant. */
  photos: string[];
  /** The contractor's own photographs, likewise. */
  ownPhotos: string[];
  notes: { id: string; body: string; redacted: boolean; createdAt: Date }[];
  /** Whether a note can be written now; false once the work order has all. */
  acceptsNotes: boolean;
  /** Whether a photograph can be added now; false once the caps are reached. */
  acceptsPhotos: boolean;
}

/** What became of a contractor's act through the link. */
export type WorkOrderLinkOutcome =
  /** Recorded. */
  | "done"
  /** Already so: an acceptance of an accepted work order. Nothing written. */
  | "unchanged"
  /** The link has written as much as it may this hour; later it may again. */
  | "limited"
  /** The work order has as much as it may ever take: no later try helps. */
  | "full"
  /** The token opens nothing: the same answer for every reason. */
  | "not-found";

/**
 * What became of an answer: an answer is never bounded, because a link takes
 * at most two (an acceptance, then a decline or done) and the second ends it.
 */
export type WorkOrderLinkAnswerOutcome = Extract<
  WorkOrderLinkOutcome,
  "done" | "unchanged" | "not-found"
>;

/** What became of a photograph sent through the link. */
export type WorkOrderLinkUploadOutcome =
  | WorkOrderLinkOutcome
  /** Not an image the media layer identifies and can read to its end. */
  | "refused"
  /** Past the per-file limit of the instance. */
  | "too-large"
  /** More pixels than a contractor's photograph may have. */
  | "too-many-pixels";

/** A file the contractor's upload delivered, read only once the link is known. */
export interface WorkOrderLinkUploadedFile {
  bytes: Buffer;
}

/** A link as issued: the address, shown to the handler once, and its end. */
export interface IssuedWorkOrderLink {
  url: string;
  expiresAt: string;
}

/**
 * What a work order's record shows its handlers of its link (ADR 0055): where
 * the link stands, the contractor's answer, notes and photographs, and which
 * of the issue's photographs the link shows.
 */
export interface WorkOrderLinkRecordView {
  link: { state: WorkOrderLinkState; expiresAt: string | null };
  answer: "ACCEPTED" | "DECLINED" | "DONE" | null;
  answeredAt: string | null;
  chosenFileIds: string[];
  notes: {
    id: string;
    body: string;
    redactedAt: string | null;
    createdAt: string;
  }[];
  files: {
    id: string;
    url: string;
    fileName: string;
    width: number | null;
    height: number | null;
    createdAt: string;
  }[];
}

/** One photograph of an issue a handler may choose for a link. */
export interface ChoosablePhotoView {
  fileId: string;
  url: string;
  fileName: string;
  /** The reporter's photograph, or a file a handler attached. */
  source: "report" | "handler";
}

/**
 * The contractor's link to a work order (decision 24 of the issue module plan,
 * ADR 0055): issuing and withdrawing it, the photographs the board chooses for
 * it, the page it opens, and what the contractor does there.
 *
 * Behind a switch (`OPENBRF_CONTRACTOR_LINKS_ENABLED`) that is off until the
 * legal review clears it (decision 25). Off, nothing is issued or chosen, and
 * every token opens nothing: the switch is a parameter of the lookup, so the
 * refusal is the one every dead link gets.
 *
 * A link reaches one work order, and of the issue only the photographs chosen
 * for it. Everything here that a link holder can reach takes the token and
 * resolves it itself, in the transaction that reads or writes, so there is no
 * grant to keep and no way to name a work order, an issue or a file beside the
 * token that the token's grant does not cover. Nothing takes a principal, so
 * no path through this service confuses a link with an account.
 *
 * Rules that hold here, each with a test that fails without it:
 *
 * - **The token is never stored, logged or queued.** It is minted in the
 *   handler's request, returned once in the answer, and only its digest is
 *   written. There is no way to see it again: a new link replaces it.
 * - **A read writes nothing.** Opening the page or a photograph stamps no
 *   "seen", no "last used" and no audit entry, so a mail scanner or a link
 *   preview opening the link does nothing by it.
 * - **Every write resolves the token again under the locks** the board's own
 *   changes take, with the work order's row locked, so a revocation, a
 *   ring-fence, a redaction or a removed contractor committed while the
 *   contractor was typing is answered as it is now.
 * - **Writes are bounded per work order in the database**, not per address.
 */
@Injectable()
export class WorkOrderLinkService {
  private readonly logger = new Logger(WorkOrderLinkService.name);

  /** The legal gate's switch (decision 25). */
  readonly enabled: boolean;

  private readonly appUrl: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly media: MediaService,
    private readonly mailer: IssueMailer,
  ) {
    this.enabled = env.OPENBRF_CONTRACTOR_LINKS_ENABLED;
    this.appUrl = env.APP_URL;
  }

  // -------------------------------------------------------------------------
  // The handlers' side.
  // -------------------------------------------------------------------------

  /**
   * Issues a link for a work order, revoking the one before it, and answers
   * its address: the one time the token leaves the instance's hands (control
   * A5). The handler passes it on by whatever way they choose (control K1).
   *
   * Under the issue type's lock and the issue's, with the work order's row
   * locked, so a ring-fence, a redaction or a contractor removed is decided
   * before or after it, and under the household protection's lock, so a
   * protection is too. Refused on a ring-fenced or closed issue, for a work
   * order declined or done, without its text or its recipient, and while a
   * person with protected personal data reported the issue or lives or is to
   * live in its apartment.
   */
  async issue(
    handlerPersonId: string,
    issueId: string,
    workOrderId: string,
  ): Promise<IssuedWorkOrderLink> {
    this.requireEnabled();
    const token = mintWorkOrderLinkToken();
    const tokenDigest = workOrderLinkDigest(token);

    const issued = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
      if (issue.type.ringFenced) {
        throw new IssueError(
          "Nothing about an issue of this type may reach a contractor.",
          "work-order-ring-fenced",
        );
      }
      if (issue.status.meaning === "DONE") {
        throw new IssueError(
          "A closed issue is reopened before a contractor is given a link.",
          "issue-closed",
        );
      }
      const order = await this.lockWorkOrder(tx, issueId, workOrderId);
      if (order.answer === "DECLINED" || order.answer === "DONE") {
        throw new IssueError(
          "The contractor has answered this work order for good.",
          "work-order-answered",
        );
      }
      if (order.body === null) {
        throw new IssueError(
          "The text of this work order is erased.",
          "work-order-text-erased",
        );
      }
      if (order.recipientName === null) {
        throw new IssueError(
          "The contractor of this work order was removed from the list.",
          "work-order-recipient-removed",
        );
      }
      // Under the lock a protection's write takes, so a protection committed
      // while this link is being issued either is seen here or finds the link
      // and ends it.
      await lockHouseholdProtection(tx);
      // The wait for this lock, and the work order's before it, may have
      // outlasted the handler's role or board seat: asked again, at the
      // instant read now that every lock is held.
      await this.requireHandledForWrite(tx, issueId, handlerPersonId);
      if (await showsProtectedHousehold(tx, issueId, localDayOf(new Date()))) {
        throw new IssueError(
          "A work order on this issue is given no link: somebody it concerns has protected personal data.",
          "work-order-protected",
        );
      }

      // A work order has one live link at most (a partial unique index holds
      // it): the one before ends now, in this transaction.
      const previous = await tx.workOrderLink.findMany({
        where: { workOrderId, revokedAt: null },
        select: { id: true },
      });
      await revokeWorkOrderLinks(tx, { id: workOrderId });
      for (const link of previous) {
        await this.audit.record(
          {
            action: "ISSUE_WORK_ORDER_LINK_REVOKED",
            channel: "WEB",
            actorPersonId: handlerPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { workOrderId, linkId: link.id, replaced: true },
          },
          tx,
        );
      }

      /*
       * The end is the database's clock, as every instant that decides what a
       * link opens is: created already expired, then given its 30 days by one
       * statement in this transaction, so no reader sees it so.
       */
      const link = await tx.workOrderLink.create({
        data: { workOrderId, tokenDigest, expiresAt: new Date(0) },
        select: { id: true },
      });
      const [ends] = await tx.$queryRaw<{ expiresAt: Date }[]>`
        UPDATE "work_order_link"
        SET "issuedAt" = clock_timestamp(),
            "expiresAt" = clock_timestamp() + make_interval(days => ${WORK_ORDER_LINK_DAYS})
        WHERE "id" = ${link.id}
        RETURNING "expiresAt"`;
      if (ends === undefined) {
        throw new Error(
          `Work order link ${link.id} could not be given its end.`,
        );
      }

      // The photographs already chosen are served from this moment.
      await this.recordExposure(
        tx,
        workOrderId,
        (
          await tx.workOrderPhoto.findMany({
            where: { workOrderId },
            select: { fileId: true },
          })
        ).map((photo) => photo.fileId),
      );

      await this.audit.record(
        {
          action: "ISSUE_WORK_ORDER_LINK_ISSUED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // The link, never the token or its digest.
          context: { workOrderId, linkId: link.id },
        },
        tx,
      );
      return { linkId: link.id, expiresAt: ends.expiresAt };
    }, HOUSEHOLD_PROTECTION_TRANSACTION);

    this.logger.log(
      `Work order ${workOrderId} on issue ${issueId} has a new link ${issued.linkId}`,
    );
    return {
      url: workOrderLinkUrl(this.appUrl, token),
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /**
   * A handler withdraws a work order's link. Withdrawing a work order that has
   * no live link is not a second act and writes nothing. Allowed with the
   * switch off too: it only ever narrows.
   */
  async revoke(
    handlerPersonId: string,
    issueId: string,
    workOrderId: string,
  ): Promise<void> {
    const revoked = await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      await this.requireHandledForWrite(tx, issueId, handlerPersonId);
      await this.lockWorkOrder(tx, issueId, workOrderId);
      // The wait for the work order's lock may have outlasted the handler's
      // role or board seat: asked again now that it is held.
      await this.requireHandledForWrite(tx, issueId, handlerPersonId);
      const links = await tx.workOrderLink.findMany({
        where: { workOrderId, revokedAt: null },
        select: { id: true },
      });
      await revokeWorkOrderLinks(tx, { id: workOrderId });
      for (const link of links) {
        await this.audit.record(
          {
            action: "ISSUE_WORK_ORDER_LINK_REVOKED",
            channel: "WEB",
            actorPersonId: handlerPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { workOrderId, linkId: link.id },
          },
          tx,
        );
      }
      return links.length;
    });
    if (revoked > 0) {
      this.logger.log(`The link of work order ${workOrderId} was withdrawn`);
    }
  }

  /**
   * Chooses which of the issue's photographs the work order's link shows: the
   * reporter's photographs and the images a handler attached, by file. The
   * whole choice at once, replacing the one before; an empty one shows none.
   *
   * The contractor reads a file only through this choice (control H5), and a
   * file is chosen only while it is an image on this issue. Removing it from
   * the issue removes it from the choice by its cascade.
   */
  async choosePhotos(
    handlerPersonId: string,
    issueId: string,
    workOrderId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    this.requireEnabled();
    const wanted = [...new Set(fileIds)];
    if (wanted.length > WORK_ORDER_LINK_CHOSEN_PHOTOS) {
      throw new IssueError(
        "Too many photographs for one work order.",
        "work-order-photo-not-found",
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await lockIssueForHandling(tx, issueId);
      const issue = await this.requireHandledForWrite(
        tx,
        issueId,
        handlerPersonId,
      );
      if (issue.type.ringFenced) {
        throw new IssueError(
          "Nothing about an issue of this type may reach a contractor.",
          "work-order-ring-fenced",
        );
      }
      await this.lockWorkOrder(tx, issueId, workOrderId);
      // The wait for the work order's lock may have outlasted the handler's
      // role or board seat: asked again now that it is held. The ring-fence
      // read above still holds, as it changes only under the type's lock.
      await this.requireHandledForWrite(tx, issueId, handlerPersonId);
      const choosable = new Set(
        (await this.choosableOf(tx, issueId)).map((photo) => photo.fileId),
      );
      if (wanted.some((fileId) => !choosable.has(fileId))) {
        throw new IssueError(
          "That photograph is not an image on this issue.",
          "work-order-photo-not-found",
        );
      }
      await tx.workOrderPhoto.deleteMany({ where: { workOrderId } });
      if (wanted.length > 0) {
        await tx.workOrderPhoto.createMany({
          data: wanted.map((fileId, sortOrder) => ({
            workOrderId,
            fileId,
            sortOrder,
          })),
        });
        // A photograph chosen while a link opens the work order is shown from
        // now on. One chosen with none opening it (ended by an answer, by an
        // expiry, by a protected household, or never issued) was never shown,
        // and is not counted: the access report names recipients that were
        // given a photograph, and states nothing else (GDPR art. 15(1)(c)).
        // The test is the lookup's own, on the database's clock.
        const { live } = await liveWorkOrderLinksOfIssue(
          tx,
          issueId,
          this.enabled,
        );
        if (live.has(workOrderId)) {
          await this.recordExposure(tx, workOrderId, wanted);
        }
      }
      await this.audit.record(
        {
          action: "ISSUE_WORK_ORDER_PHOTOS_CHOSEN",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          // How many, and never which: the files' names are free text, and
          // the work order's own rows say which.
          context: { workOrderId, photos: wanted.length },
        },
        tx,
      );
    });
  }

  /**
   * Records that these photographs are shown to the work order's contractor,
   * once each however often they are chosen again, for the data subject access
   * report (GDPR art. 15(1)(c)). Written by the handler's act that exposes
   * them, never by a read of the link, which writes nothing (ADR 0055).
   */
  private async recordExposure(
    tx: Prisma.TransactionClient,
    workOrderId: string,
    fileIds: readonly string[],
  ): Promise<void> {
    if (fileIds.length === 0) {
      return;
    }
    await tx.workOrderPhotoExposure.createMany({
      data: fileIds.map((fileId) => ({ workOrderId, fileId })),
      skipDuplicates: true,
    });
  }

  /**
   * What the handlers' record shows of each work order's link, by work order,
   * read in the caller's transaction: where the link stands, the answer, the
   * notes, the contractor's photographs and the photographs chosen. And
   * whether somebody the issue concerns has protected personal data, which
   * ends every link to it as `resolve` does on every request: such a link is
   * `ended` here, so the record never says it opens what the contractor is
   * refused.
   *
   * Not the switch: a link the switch holds shut is `live` here, as it would
   * open again were the switch turned on within its 30 days, and the handlers
   * can withdraw it while the switch is off (`revoke`). The answer's
   * `linksEnabled` says whether it opens now.
   */
  async recordViews(
    tx: Prisma.TransactionClient,
    issueId: string,
    workOrderIds: readonly string[],
  ): Promise<{
    protectedHousehold: boolean;
    views: Map<string, WorkOrderLinkRecordView>;
  }> {
    const { protectedHousehold, live } = await liveWorkOrderLinksOfIssue(
      tx,
      issueId,
      true,
    );
    const ordered = await tx.workOrder.findMany({
      where: { id: { in: [...workOrderIds] }, issueId },
      select: {
        id: true,
        answer: true,
        answeredAt: true,
        _count: { select: { links: true } },
        chosenPhotos: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: { fileId: true },
        },
        notes: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, body: true, redactedAt: true, createdAt: true },
        },
        files: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: {
            id: true,
            createdAt: true,
            file: {
              select: { id: true, fileName: true, width: true, height: true },
            },
          },
        },
      },
    });
    const views = new Map(
      ordered.map((order): [string, WorkOrderLinkRecordView] => {
        const expiresAt = live.get(order.id);
        return [
          order.id,
          {
            link: {
              state:
                expiresAt !== undefined
                  ? "live"
                  : order._count.links > 0
                    ? "ended"
                    : "none",
              expiresAt: expiresAt?.toISOString() ?? null,
            },
            answer: order.answer,
            answeredAt: order.answeredAt?.toISOString() ?? null,
            chosenFileIds: order.chosenPhotos.map((photo) => photo.fileId),
            notes: order.notes.map((note) => ({
              id: note.id,
              body: note.body,
              redactedAt: note.redactedAt?.toISOString() ?? null,
              createdAt: note.createdAt.toISOString(),
            })),
            files: order.files.map((file) => ({
              id: file.id,
              url: mediaUrl(file.file.id),
              fileName: file.file.fileName,
              width: file.file.width,
              height: file.file.height,
              createdAt: file.createdAt.toISOString(),
            })),
          },
        ];
      }),
    );
    return { protectedHousehold, views };
  }

  /**
   * The photographs of an issue a handler may choose for a link: the
   * reporter's, and the images the handlers attached. A document is never one.
   */
  async choosableOf(
    db: Prisma.TransactionClient | PrismaService,
    issueId: string,
  ): Promise<ChoosablePhotoView[]> {
    const image = { contentType: { startsWith: "image/" } } as const;
    const fileSelect = { id: true, fileName: true } as const;
    const photos = await db.issuePhoto.findMany({
      where: { issueId, file: image },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { file: { select: fileSelect } },
    });
    const attachments = await db.issueAttachment.findMany({
      where: { issueId, file: image },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { file: { select: fileSelect } },
    });
    return [
      ...photos.map(({ file }) => ({ file, source: "report" as const })),
      ...attachments.map(({ file }) => ({ file, source: "handler" as const })),
    ].map(({ file, source }) => ({
      fileId: file.id,
      url: mediaUrl(file.id),
      fileName: file.fileName,
      source,
    }));
  }

  // -------------------------------------------------------------------------
  // The contractor's side. Each takes the token and nothing that names a row.
  // -------------------------------------------------------------------------

  /**
   * The page a token opens, or null for every token that opens nothing.
   *
   * Reads, and writes nothing at all. The token's form is checked before the
   * database is asked; a value that cannot be a token is answered as one that
   * is unknown. The link and what it opens are read from one snapshot, so a
   * revocation happened either before this read or after it.
   */
  async open(token: string): Promise<WorkOrderLinkPageView | null> {
    if (!hasWorkOrderLinkTokenForm(token)) {
      return null;
    }
    const digest = workOrderLinkDigest(token);
    return this.prisma.$transaction(
      async (tx) => {
        const link = await this.resolve(tx, digest);
        return link === null ? null : this.pageOf(tx, link);
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * A photograph through the link, or null: one the board chose for this work
   * order and still on its issue, or one the contractor added to it. Any other
   * identifier, of another work order, another issue, a photograph of the
   * report not chosen, or no file at all, is answered null alike (control
   * C3). Reads, and writes nothing.
   *
   * Served under the server's name for its type, never the stored one: a
   * photograph of the report is stored under the name the reporter's device
   * gave it, which is free text and may name the apartment or the person.
   */
  async photo(token: string, fileId: string): Promise<ServedFile | null> {
    if (!hasWorkOrderLinkTokenForm(token)) {
      return null;
    }
    const digest = workOrderLinkDigest(token);
    const granted = await this.prisma.$transaction(
      async (tx) => {
        const link = await this.resolve(tx, digest);
        if (link === null) {
          return false;
        }
        return this.grantCovers(tx, link, fileId);
      },
      { isolationLevel: "RepeatableRead" },
    );
    if (!granted) {
      return null;
    }
    const served = await this.media.openForWorkOrderLink(fileId);
    return served === null
      ? null
      : { ...served, fileName: workOrderPhotoName(served.contentType) };
  }

  /**
   * The contractor's answer: accept, decline or done.
   *
   * Under the issue type's lock and the issue's, with the work order's row
   * locked, the token is resolved again. A decline and done end the link:
   * from the next request it answers as every dead link does. Done may follow
   * an acceptance or come without one; a decline after an acceptance is a
   * decline. Accepting an accepted work order writes nothing.
   */
  async answer(
    token: string,
    answer: WorkOrderLinkAnswer,
  ): Promise<WorkOrderLinkAnswerOutcome> {
    return this.write(token, "answer", async (tx, link) => {
      const order = await tx.workOrder.findUniqueOrThrow({
        where: { id: link.workOrderId },
        select: { answer: true },
      });
      const value =
        answer === "accept"
          ? ("ACCEPTED" as const)
          : answer === "decline"
            ? ("DECLINED" as const)
            : ("DONE" as const);
      if (order.answer === value) {
        return "unchanged" as const;
      }
      await tx.workOrder.update({
        where: { id: link.workOrderId },
        data: { answer: value, answeredAt: new Date() },
      });
      await this.recordLinkAct(tx, link, "ISSUE_WORK_ORDER_ANSWERED", {
        answer: value,
      });
      return "done" as const;
    });
  }

  /**
   * A note the contractor writes. The caller has read the body against the
   * form's rules; the identity-number scan is made there too, so the refusal
   * can say why. Bounded per work order, in the database.
   */
  async note(token: string, body: string): Promise<WorkOrderLinkOutcome> {
    const text = normalizeFreeText(body).trim();
    if (
      text === "" ||
      text.length > WORK_ORDER_LIMITS.note ||
      scanForPersonalIdentityNumbers(text).length > 0
    ) {
      throw new Error("A note reached the service the form refuses.");
    }
    return this.write(token, "activity", async (tx, link) => {
      const [counts] = await tx.$queryRaw<
        { lastHour: bigint; total: bigint }[]
      >`
        SELECT
          count(*) FILTER (WHERE "createdAt" > now() - interval '1 hour') AS "lastHour",
          count(*) AS "total"
        FROM "work_order_note"
        WHERE "workOrderId" = ${link.workOrderId}`;
      // The total first: it never drops, so it is the answer that stays true.
      if (Number(counts?.total ?? 0) >= WORK_ORDER_LINK_NOTES_PER_WORK_ORDER) {
        return "full" as const;
      }
      if (Number(counts?.lastHour ?? 0) >= WORK_ORDER_LINK_NOTES_PER_HOUR) {
        return "limited" as const;
      }
      const note = await tx.workOrderNote.create({
        data: { workOrderId: link.workOrderId, body: text },
        select: { id: true },
      });
      await this.recordLinkAct(tx, link, "ISSUE_WORK_ORDER_NOTE_ADDED", {
        noteId: note.id,
      });
      return "done" as const;
    });
  }

  /**
   * A photograph the contractor adds: the first upload in the product with no
   * account behind it (ADR 0055).
   *
   * In three steps, so nothing a stranger sends is read before it is known to
   * be wanted (control G1): the token is resolved and the work order's caps
   * counted first, and only then is the file read from the request, through
   * `readFile`. Its pixels are counted (G6) and it is stored through the media
   * layer, which identifies it from its bytes, strips its metadata and seals
   * it (G4, G5), under a name the server makes (G7), declared as showing
   * people (G8) and held `INTERNAL` under `issues:handle` (G9). Then, under
   * the locks and with the work order's row locked, the token is resolved and
   * the caps counted again (G2); a link revoked or a cap filled meanwhile
   * stores no row, and the file is removed again.
   */
  async upload(
    token: string,
    readFile: () => Promise<WorkOrderLinkUploadedFile | "too-large" | null>,
  ): Promise<WorkOrderLinkUploadOutcome> {
    if (!hasWorkOrderLinkTokenForm(token)) {
      return "not-found";
    }
    const digest = workOrderLinkDigest(token);

    const before = await this.prisma.$transaction(
      async (tx) => {
        const link = await this.resolve(tx, digest);
        return link === null
          ? ("not-found" as const)
          : this.photoRoom(tx, link.workOrderId, 0);
      },
      { isolationLevel: "RepeatableRead" },
    );
    if (before !== "room") {
      return before;
    }

    const file = await readFile();
    if (file === "too-large") {
      return "too-large";
    }
    if (file === null || file.bytes.length === 0) {
      return "refused";
    }
    const header = readImageHeader(file.bytes);
    if (header === null) {
      return "refused";
    }
    if (header.width * header.height > WORK_ORDER_LINK_MAX_PIXELS) {
      return "too-many-pixels";
    }

    let stored: { id: string; byteSize: number };
    try {
      stored = await this.media.upload({
        bytes: file.bytes,
        // The server's name, never the contractor's: the stored name is shown
        // to handlers and goes into the download's disposition (G7).
        fileName: workOrderPhotoName(header.contentType),
        visibility: "INTERNAL",
        requiredCapability: "issues:handle",
        // Nobody knows what a contractor photographed, so it is recorded as if
        // it shows somebody, as a reporter's photograph is (G8).
        showsIdentifiablePersons: true,
        uploadedByPersonId: null,
        channel: "LINK",
        recordFileName: false,
      });
    } catch (error) {
      if (error instanceof MediaError) {
        return "refused";
      }
      throw error;
    }

    let outcome: WorkOrderLinkUploadOutcome;
    try {
      outcome = await this.write<WorkOrderLinkUploadOutcome>(
        token,
        "activity",
        async (tx, link) => {
          const room = await this.photoRoom(
            tx,
            link.workOrderId,
            stored.byteSize,
          );
          if (room !== "room") {
            return room;
          }
          const placed = await tx.workOrderFile.count({
            where: { workOrderId: link.workOrderId },
          });
          await tx.workOrderFile.create({
            data: {
              workOrderId: link.workOrderId,
              fileId: stored.id,
              sortOrder: placed,
            },
          });
          await this.recordLinkAct(tx, link, "ISSUE_WORK_ORDER_PHOTO_ADDED", {
            fileId: stored.id,
          });
          return "done";
        },
      );
    } catch (error) {
      await this.discard(stored.id);
      throw error;
    }
    if (outcome !== "done") {
      await this.discard(stored.id);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------

  /**
   * One write through a link: the token resolved, the locks a handling write
   * takes, the work order's row locked, and the token resolved again under
   * them, so the write is decided against the link as it is now. A refusal at
   * either resolution is `not-found`. The handlers are told, with no free
   * text, of every act that changed something: of an answer every time, of a
   * note or a photograph once an hour (`IssueMailer.contractorInTransaction`).
   */
  private async write<T extends string>(
    token: string,
    notice: ContractorNoticeKind,
    act: (tx: Prisma.TransactionClient, link: LiveWorkOrderLink) => Promise<T>,
  ): Promise<T | "not-found"> {
    if (!hasWorkOrderLinkTokenForm(token)) {
      return "not-found";
    }
    const digest = workOrderLinkDigest(token);
    // Before the transaction opens: creating a queue is the queue backend's
    // own work, on its own connection.
    await this.mailer.ensureQueues();

    const result = await this.prisma.$transaction(async (tx) => {
      const first = await this.resolve(tx, digest);
      if (first === null) {
        return { outcome: "not-found" as const, issueId: null };
      }
      await lockIssueType(tx, first.typeId);
      await lockIssue(tx, first.issueId);
      await tx.$queryRaw`SELECT "id" FROM "work_order" WHERE "id" = ${first.workOrderId} FOR UPDATE`;
      const link = await this.resolve(tx, digest);
      if (link === null) {
        return { outcome: "not-found" as const, issueId: null };
      }
      const outcome = await act(tx, link);
      if (outcome === "done") {
        await this.mailer.contractorInTransaction(tx, link.issueId, notice);
      }
      return { outcome, issueId: link.issueId };
    });

    if (result.outcome === "done" && result.issueId !== null) {
      this.logger.log(
        `Issue ${result.issueId} has an answer through a work order's link`,
      );
    }
    return result.outcome;
  }

  /**
   * The live link a digest names, or null: the lookup, and the protected
   * household asked in the same transaction. Every refusal is the same null.
   */
  private async resolve(
    tx: Prisma.TransactionClient,
    digest: string,
  ): Promise<LiveWorkOrderLink | null> {
    const link = await liveWorkOrderLinkByDigest(tx, digest, this.enabled);
    if (link === null) {
      return null;
    }
    return (await showsProtectedHousehold(
      tx,
      link.issueId,
      localDayOf(new Date()),
    ))
      ? null
      : link;
  }

  /** Whether a file is one this link's grant covers. */
  private async grantCovers(
    tx: Prisma.TransactionClient,
    link: LiveWorkOrderLink,
    fileId: string,
  ): Promise<boolean> {
    const own = await tx.workOrderFile.findFirst({
      where: { fileId, workOrderId: link.workOrderId },
      select: { id: true },
    });
    if (own !== null) {
      return true;
    }
    // Chosen for this work order, and still a file of this issue: the choice
    // and the issue are both asked, so neither alone can widen the other.
    const chosen = await tx.workOrderPhoto.findFirst({
      where: {
        fileId,
        workOrderId: link.workOrderId,
        file: {
          OR: [
            { issuePhotos: { some: { issueId: link.issueId } } },
            { issueAttachment: { issueId: link.issueId } },
          ],
        },
      },
      select: { id: true },
    });
    return chosen !== null;
  }

  /**
   * Whether the work order has room for one more photograph of this size:
   * the total count and size first, which never drop, then the hour.
   */
  private async photoRoom(
    tx: Prisma.TransactionClient,
    workOrderId: string,
    adding: number,
  ): Promise<"room" | "full" | "limited"> {
    const [counts] = await tx.$queryRaw<
      { total: bigint; bytes: bigint | null; lastHour: bigint }[]
    >`
      SELECT
        count(*) AS "total",
        sum(m."byteSize") AS "bytes",
        count(*) FILTER (WHERE f."createdAt" > now() - interval '1 hour') AS "lastHour"
      FROM "work_order_file" f
      JOIN "media_file" m ON m."id" = f."fileId"
      WHERE f."workOrderId" = ${workOrderId}`;
    if (
      Number(counts?.total ?? 0) >= WORK_ORDER_LINK_PHOTOS_PER_WORK_ORDER ||
      Number(counts?.bytes ?? 0) + adding > WORK_ORDER_LINK_BYTES_PER_WORK_ORDER
    ) {
      return "full";
    }
    if (Number(counts?.lastHour ?? 0) >= WORK_ORDER_LINK_PHOTOS_PER_HOUR) {
      return "limited";
    }
    return "room";
  }

  /**
   * An act through the link, on the link's own channel and with no actor:
   * whoever holds the link did it. The entry names the work order and the
   * link, never the token or a word written (control J4).
   */
  private async recordLinkAct(
    tx: Prisma.TransactionClient,
    link: LiveWorkOrderLink,
    action:
      | "ISSUE_WORK_ORDER_ANSWERED"
      | "ISSUE_WORK_ORDER_NOTE_ADDED"
      | "ISSUE_WORK_ORDER_PHOTO_ADDED",
    context: Record<string, string>,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        channel: "LINK",
        actorPersonId: null,
        targetKind: "issue",
        targetId: link.issueId,
        context: {
          workOrderId: link.workOrderId,
          linkId: link.linkId,
          ...context,
        },
      },
      tx,
    );
  }

  /** Removes a stored file whose row was refused, and logs a failure to. */
  private async discard(fileId: string): Promise<void> {
    await this.media
      .remove(fileId, null, "LINK", { recordFileName: false })
      .catch((removal: unknown) => {
        this.logger.error(
          `Could not remove file ${fileId} after a work order's link refused it: ${failureName(removal)}`,
        );
      });
  }

  private async pageOf(
    tx: Prisma.TransactionClient,
    link: LiveWorkOrderLink,
  ): Promise<WorkOrderLinkPageView | null> {
    const order = await tx.workOrder.findUniqueOrThrow({
      where: { id: link.workOrderId },
      select: {
        createdAt: true,
        recipientName: true,
        body: true,
        answer: true,
        links: {
          where: { id: link.linkId },
          select: { expiresAt: true },
        },
        chosenPhotos: {
          where: {
            file: {
              OR: [
                { issuePhotos: { some: { issueId: link.issueId } } },
                { issueAttachment: { issueId: link.issueId } },
              ],
            },
          },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: { fileId: true },
        },
        files: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: { fileId: true },
        },
        notes: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, body: true, redactedAt: true, createdAt: true },
        },
      },
    });
    const expiresAt = order.links[0]?.expiresAt;
    // The lookup read both; null here only for a row changed under a snapshot
    // that cannot change, which is the lookup's refusal all the same.
    if (
      order.body === null ||
      order.recipientName === null ||
      expiresAt === undefined
    ) {
      return null;
    }
    const room = await this.photoRoom(tx, link.workOrderId, 0);
    return {
      sentAt: order.createdAt,
      recipientName: order.recipientName,
      body: order.body,
      accepted: order.answer === "ACCEPTED",
      expiresAt,
      photos: order.chosenPhotos.map((photo) => photo.fileId),
      ownPhotos: order.files.map((file) => file.fileId),
      notes: order.notes.map((note) => ({
        id: note.id,
        body: note.redactedAt === null ? note.body : "",
        redacted: note.redactedAt !== null,
        createdAt: note.createdAt,
      })),
      acceptsNotes: order.notes.length < WORK_ORDER_LINK_NOTES_PER_WORK_ORDER,
      acceptsPhotos: room !== "full",
    };
  }

  /**
   * The work order on this issue, locked for the rest of the transaction, or
   * the refusal of one that is not there.
   */
  private async lockWorkOrder(
    tx: Prisma.TransactionClient,
    issueId: string,
    workOrderId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "work_order" WHERE "id" = ${workOrderId} AND "issueId" = ${issueId} FOR UPDATE`;
    const order = await tx.workOrder.findFirst({
      where: { id: workOrderId, issueId },
      select: { answer: true, body: true, recipientName: true },
    });
    if (order === null) {
      throw new IssueError("No such work order.", "work-order-not-found");
    }
    return order;
  }

  /**
   * An issue this person handles and holds `issues:handle` for, or the refusal
   * that answers one that does not exist: one the writer may not open is not
   * one they may learn of. Read under the locks of the write that asks, with
   * the clock read here once they are held (`requireHandledIssueForWrite`).
   */
  private async requireHandledForWrite(
    tx: Prisma.TransactionClient,
    issueId: string,
    handlerPersonId: string,
  ) {
    return requireHandledIssueForWrite(
      tx,
      issueId,
      handlerPersonId,
      {
        type: { select: { ringFenced: true } },
        status: { select: { meaning: true } },
      },
      new Date(),
    );
  }

  /** Every act on a link is refused, as not found, while the switch is off. */
  private requireEnabled(): void {
    if (!this.enabled) {
      throw new IssueError(
        "Contractors' links are switched off on this instance.",
        "work-order-links-off",
      );
    }
  }
}

/** The address of the page a token opens: the instance's own, token in the path. */
export function workOrderLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}${WORK_ORDER_LINK_PATH}/${token}`;
}

/**
 * The name the server gives a photograph on a link's side, from its identified
 * type: what a contractor's upload is stored under (control G7), and what every
 * photograph read through a link is served as, so no name somebody chose, the
 * reporter's included, reaches the contractor.
 */
export function workOrderPhotoName(contentType: string): string {
  const extension = extensionOf(contentType);
  return extension === undefined
    ? "work-order-photo"
    : `work-order-photo.${extension}`;
}
