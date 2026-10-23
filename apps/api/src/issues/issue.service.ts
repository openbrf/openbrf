import { Injectable, Logger } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { type IssueLinkOutcome, linkIssueToPost } from "../feed/feed-issue";
import { Prisma } from "../generated/prisma/client";
import type { IssueAudience, IssueStatus } from "../generated/prisma/enums";
import { failureName } from "../logging/failure";
import { mediaUrl, MediaService } from "../media/media.service";
import { residencyHeldOn } from "../registers/held-on";
import { IssueTypeService } from "./issue-type.service";
import { lockIssue } from "./issue-lock";
import { IssueError } from "./issue.error";

/**
 * How many photographs one report may carry.
 *
 * A bound on one report, and only on one report: every file is held in memory
 * while it is identified and checksummed, and a hundred images on a single
 * issue report are neither readable by whoever has to work it nor free to
 * serve.
 *
 * It is deliberately not a defence against filling the data volume, and reading
 * it as one would be a mistake: nothing caps how many reports an account may
 * file, so a resident who wanted the space could take it six photographs at a
 * time without ever meeting this number.
 */
export const MAX_PHOTOS_PER_ISSUE = 6;

export interface IssuePhotoView {
  id: string;
  /** A path on this instance's own origin, never an address at a bucket. */
  url: string;
  fileName: string;
  width: number | null;
  height: number | null;
}

export interface IssueApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a handler knows which entrance without a second call. */
  address: string;
}

/**
 * Who reported an issue, as whoever handles it may be told.
 *
 * Four cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it: that register has a statutory reason to, and an issue
 * queue - which an external property manager reads - has none. A handler who
 * has to reach them goes through the board. Their apartment is withheld with
 * the name, for the reason `QueuedIssueView` gives. It carries no personId
 * either: a handler who saw the same person unmasked earlier, as a resident
 * reporter, could otherwise link them to every later protected row.
 *
 * `unknown` is a reporter reference that no longer resolves to a person. Issue
 * data is service tier and a person can be purged out from under it, so the
 * queue has to be able to say "we no longer know" rather than break.
 */
export type IssueReporterView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected" }
  | { kind: "external"; name: string | null; email: string | null }
  | { kind: "unknown" };

export interface OwnIssueView {
  id: string;
  status: IssueStatus;
  typeId: string;
  typeName: string;
  location: string | null;
  description: string;
  apartment: IssueApartmentView | null;
  photos: IssuePhotoView[];
  createdAt: string;
  updatedAt: string;
}

/**
 * An issue as whoever handles it reads it.
 *
 * `apartment` is null when the reporter has protected personal data, whatever
 * the report was filed against. A signed-in resident can only file against an
 * apartment they live in, so on a protected reporter's report the apartment is
 * their home address, and withholding the name beside it would withhold
 * nothing. The location and the description stay: the reporter wrote those
 * themselves.
 *
 * The same row for every handler, the board included. The queue is one view
 * under one capability, and the board already has the address book, which has
 * a statutory reason to print the apartment. A board member who has to send
 * someone to the door looks there.
 */
export type QueuedIssueView = OwnIssueView & {
  audience: IssueAudience;
  /** When it was last moved to DONE, or null while it is open. */
  closedAt: string | null;
} & (
    | { reporter: Exclude<IssueReporterView, { kind: "protected" }> }
    | {
        reporter: Extract<IssueReporterView, { kind: "protected" }>;
        apartment: null;
      }
  );

/**
 * Whether a read of the queue shows the issues a reporter with protected
 * personal data filed, or leaves them out altogether.
 *
 * An argument of `pageOfQueue` and `queuedIssue` rather than a default, so
 * each caller states which it is. The board's own screen (`listQueue`) shows
 * them, with the reporter withheld as `IssueReporterView` describes. A read
 * handed to a caller outside the instance (`mcp`, `ai`) leaves them out:
 * Beslutslogg 64 puts protected personal data outside every token and every
 * prompt, and a report from such a person is about their own home whoever's
 * name is withheld from it. Left out here, inside the service, because an
 * action may bind a read only where the omission happens in the service method
 * it calls (docs/actions.md, "What an action that names a person must
 * satisfy").
 */
export type ProtectedReporters = "show" | "omit";

/** What a read of the queue may be narrowed to. */
export interface IssueQueueFilter {
  status?: IssueStatus;
  typeId?: string;
  /** The audience of the issue's type. */
  audience?: IssueAudience;
}

/**
 * How many issues one page of the queue answers with.
 *
 * The bound the motion queue has, for the motion queue's reason: an
 * association accumulates one queue for as long as it exists, and a
 * description runs to four thousand characters. A page comes with a cursor, so
 * the bound hides nothing.
 */
export const ISSUES_PER_PAGE = 50;

/**
 * The order the queue is read in, written out.
 *
 * As for the motion queue: Prisma compares an enum column for equality and
 * membership and not with `gt`, so the status half of a cursor is resolved
 * here. The order is the enum's own, which is the order `status: "asc"` reads
 * it in, and `satisfies` stops the two drifting apart silently.
 */
const QUEUE_STATUS_ORDER = [
  "NEW",
  "IN_PROGRESS",
  "DONE",
] as const satisfies readonly IssueStatus[];

/**
 * Where a page of the queue ends: the last issue's own sort key.
 *
 * Three halves for the reason `MotionQueueCursor` gives - the status, then the
 * instant, then the identifier to break a tie on the instant - and values
 * rather than a row, because an issue is purged on its own clock and a cursor
 * naming a purged row would answer a page silently empty. An issue moved to
 * another status between two pages sorts again and can be read twice, which is
 * the reader's to merge by id.
 */
export interface IssueQueueCursor {
  status: IssueStatus;
  createdAt: Date;
  id: string;
}

/** Separates the halves; none of them can contain it. */
const CURSOR_SEPARATOR = "|";

/** The cursor for the page ending at this issue. */
export function issueQueueCursor(row: IssueQueueCursor): string {
  return [row.status, row.createdAt.toISOString(), row.id].join(
    CURSOR_SEPARATOR,
  );
}

/**
 * The cursor a reader handed back, or null when it is not one this service
 * issued. Null rather than a lenient reading: answering a cursor nobody issued
 * with the first page would hand a reader the issues already in front of it.
 */
export function parseIssueQueueCursor(value: string): IssueQueueCursor | null {
  const [status, instant = "", id = "", ...rest] =
    value.split(CURSOR_SEPARATOR);
  const createdAt = new Date(instant);
  if (
    rest.length > 0 ||
    !(QUEUE_STATUS_ORDER as readonly (string | undefined)[]).includes(status) ||
    id === "" ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    return null;
  }
  return { status: status as IssueStatus, createdAt, id };
}

/** One page of the queue. */
export interface IssueQueuePage {
  issues: QueuedIssueView[];
  /** Handed back as `after` for the page behind this one; null at the end. */
  nextCursor: string | null;
}

export interface ReportIssueInput {
  typeId: string;
  /** The reporter's own apartment, when the issue is in one. */
  apartmentId?: string | null;
  location?: string | null;
  description: string;
  /**
   * The post in the feed the report is made from ("Gör felanmälan"), when it
   * is. The post then names the report, and shows its status to whoever may
   * read the report.
   */
  postId?: string | null;
}

/**
 * A report filed from the association's public website, by nobody in
 * particular.
 *
 * No apartment: the form is served before any sign-in and must not offer a
 * picker that enumerates the building to whoever loads the page (decision 28).
 * The free-text location covers everything an apartment number would have.
 *
 * No photograph either, and that is the same argument one step further: an
 * anonymous upload surface is a place to put files on somebody else's server,
 * and a passer-by reporting a broken door does not need one.
 *
 * The contact details are optional. Somebody who reports a fault in the street
 * owes the association nothing, and a form that refused the report without a
 * name would collect fewer reports rather than better ones.
 */
export interface ReportPublicIssueInput {
  typeId: string;
  location?: string | null;
  description: string;
  reporterName?: string | null;
  reporterEmail?: string | null;
}

/**
 * Reported issues: filing one, reading one's own, and the triage queue.
 *
 * Two properties are enforced here rather than left to the screens.
 *
 * The audience filter decides which type a report may be filed under, and it is
 * the same filter that decided which types to offer - a caller who posts an
 * identifier they were never shown is answered as if that type did not exist.
 *
 * A reporter reads their own reports and nobody else's. Everything else about
 * an issue - who else reported what, the internal ones - needs issues:handle,
 * which is the external property manager's single capability besides their own
 * account (decision 11).
 *
 * The description is free text and is deliberately neither scanned nor refused.
 * An issue report is exactly where health data and a third party's details turn
 * up without anyone intending it - a leak in a bathroom, a neighbour's
 * behaviour - and the answer to that is the warning the form carries, not a
 * refusal that would turn away the reports the module exists for. Nothing here
 * is published, and the publication guardrails that scan text apply to the
 * association's website, not to its private queue.
 */
@Injectable()
export class IssueService {
  private readonly logger = new Logger(IssueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly types: IssueTypeService,
    private readonly media: MediaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Files a report for a signed-in resident.
   *
   * ## From a post
   *
   * A report made from a post in the feed is filed and linked to the post in
   * one transaction, so a report never exists that its post was refused, and a
   * post never names a report that was not filed. Which posts may carry one,
   * and who may make it, is the feed's answer (`linkIssueToPost`): the post's
   * writer or a board seat holder, from a post they may read, once. Its
   * refusals are this module's, so the form has one set of reasons to read.
   * What the report says is still the reporter's own - the form starts from the
   * post's text and photographs, and the reporter files what they choose.
   */
  async report(
    principal: Principal,
    input: ReportIssueInput,
  ): Promise<{ id: string }> {
    const type = await this.types.requireReportable(principal, input.typeId);

    const apartmentId =
      input.apartmentId == null
        ? null
        : await this.requireOwnApartment(principal.personId, input.apartmentId);

    const data = {
      typeId: type.id,
      reporterPersonId: principal.personId,
      apartmentId,
      location: input.location ?? null,
      description: input.description,
    };
    const postId = input.postId ?? null;

    const issue =
      postId === null
        ? await this.prisma.issue
            .create({ data, select: { id: true } })
            .catch(typeRemoved)
        : await this.prisma.$transaction(async (tx) => {
            const filed = await tx.issue
              .create({ data, select: { id: true } })
              .catch(typeRemoved);
            refuseUnlinked(
              await linkIssueToPost(
                tx,
                principal,
                postId,
                filed.id,
                new Date(),
              ),
            );
            return filed;
          });

    // The identifier and the type only. The description is the resident's own
    // account of their home and has no business in a log line.
    this.logger.log(`Reported issue ${issue.id} as ${type.audience}`);
    return issue;
  }

  /**
   * Files a report that arrived through the public website.
   *
   * The type is resolved through the same filter that decided which types to
   * offer the form, called with no principal: a caller posting an identifier
   * that was never on the page is answered as if that type did not exist, and
   * an association with public reporting switched off is refused here rather
   * than merely not shown a form. The switch is the rule; the missing form is
   * its consequence.
   *
   * The reporter's details are encrypted exactly as a sign-up request's are,
   * and the address carries a blind index so a second report from the same
   * person is recognisable as theirs.
   */
  async reportPublicly(input: ReportPublicIssueInput): Promise<{ id: string }> {
    const type = await this.types.requireReportable(null, input.typeId);

    const name =
      input.reporterName == null || input.reporterName === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterName",
            input.reporterName,
          );
    const email =
      input.reporterEmail == null || input.reporterEmail === ""
        ? null
        : await this.encryption.encrypt(
            "issue.reporterEmail",
            input.reporterEmail,
          );

    const filing = this.prisma.issue.create({
      data: {
        typeId: type.id,
        // No account behind it. The reporter reference stays null and the
        // contact fields carry whatever the person chose to leave.
        reporterPersonId: null,
        reporterNameCipher: name?.cipher ?? null,
        reporterEmailCipher: email?.cipher ?? null,
        reporterEmailIndex: email?.index ?? null,
        // Empty is nothing, exactly as it is for the name and the address
        // above: the form's location field is optional, so a visitor who
        // touched it and thought better of it must not leave the board an
        // issue whose location is present and blank.
        location:
          input.location == null || input.location === ""
            ? null
            : input.location,
        description: input.description,
      },
      select: { id: true },
    });
    const issue = await filing.catch(typeRemoved);

    // The identifier and the type. What a passer-by wrote about the building,
    // and who they said they were, has no business in a log line.
    this.logger.log(`Reported issue ${issue.id} from the public form`);
    return issue;
  }

  /** The reporter's own issues, newest first. */
  async listOwn(personId: string): Promise<OwnIssueView[]> {
    const issues = await this.prisma.issue.findMany({
      where: { reporterPersonId: personId },
      orderBy: { createdAt: "desc" },
      include: ISSUE_INCLUDE,
    });

    return issues.map((issue) => toOwnView(issue));
  }

  /**
   * The triage queue. Reached with issues:handle.
   *
   * Open issues first and oldest first within a status, because the queue is
   * worked from the top and the thing that has been waiting longest is the
   * thing to look at.
   */
  async listQueue(filter?: {
    status?: IssueStatus;
  }): Promise<QueuedIssueView[]> {
    const issues = await this.prisma.issue.findMany({
      where: queueWhere({ status: filter?.status }),
      orderBy: QUEUE_ORDER,
      include: ISSUE_INCLUDE,
    });

    return this.queuedViews(issues, "show");
  }

  /**
   * One page of the triage queue. Reached with issues:handle.
   *
   * The queue `listQueue` reads, in the same order and built into the same
   * rows, a page at a time and narrowed by status, type or audience. One more
   * row than the page holds is read, which is how "there is a page after this
   * one" is answered without a second statement about a second moment.
   *
   * With `omit`, an issue a reporter with protected personal data filed is not
   * on the page at all, and neither is anything about it. It is left out of the
   * query, so a page is not short for it, and left out again once the reporters
   * are read, so a person whose data became protected between the two reads is
   * not shown either. A row dropped that late leaves a gap, which is filled by
   * reading on from the last row read until the page and the one row behind it
   * are rows that were kept. The cursor is then the last row on the page: a
   * cursor naming a dropped row would hand its identifier, its status and the
   * moment it was filed to a caller the issue itself is withheld from.
   */
  async pageOfQueue(
    filter: IssueQueueFilter & {
      /** At most {@link ISSUES_PER_PAGE}; absent takes the whole page. */
      limit?: number;
      after?: IssueQueueCursor | null;
    },
    protectedReporters: ProtectedReporters,
  ): Promise<IssueQueuePage> {
    const limit = Math.min(filter.limit ?? ISSUES_PER_PAGE, ISSUES_PER_PAGE);
    const kept: QueuedIssueView[] = [];
    let readFrom = filter.after ?? null;

    /*
     * Each read either keeps a row or moves past the rows it read, and a read
     * that comes back short is the end of the queue, so this stops. It reads
     * once unless a reporter's data became protected during it.
     */
    for (;;) {
      const take = limit + 1 - kept.length;
      const rows = await this.prisma.issue.findMany({
        where: {
          AND: [
            queueWhere(filter),
            readFrom === null ? {} : afterInQueue(readFrom),
            protectedReporters === "omit"
              ? await this.notReportedByProtectedPersons()
              : {},
          ],
        },
        orderBy: QUEUE_ORDER,
        take,
        include: ISSUE_INCLUDE,
      });
      kept.push(...(await this.queuedViews(rows, protectedReporters)));

      const lastRead = rows.at(-1);
      if (kept.length > limit || rows.length < take || lastRead === undefined) {
        break;
      }
      readFrom = lastRead;
    }

    const page = kept.slice(0, limit);
    const last = page.at(-1);
    return {
      issues: page,
      nextCursor:
        last !== undefined && kept.length > page.length
          ? issueQueueCursor({
              status: last.status,
              createdAt: new Date(last.createdAt),
              id: last.id,
            })
          : null,
    };
  }

  /**
   * One issue from the triage queue. Reached with issues:handle.
   *
   * With `omit`, an issue a reporter with protected personal data filed is
   * answered exactly as an issue that does not exist, with the same reason and
   * the same sentence, so the answer does not say that there is one.
   */
  async queuedIssue(
    issueId: string,
    protectedReporters: ProtectedReporters,
  ): Promise<QueuedIssueView> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      include: ISSUE_INCLUDE,
    });
    const [view] =
      issue === null ? [] : await this.queuedViews([issue], protectedReporters);
    if (view === undefined) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    return view;
  }

  /** Moves an issue between the three states. Reached with issues:handle. */
  async setStatus(
    issueId: string,
    status: IssueStatus,
    actorPersonId: string,
  ): Promise<QueuedIssueView> {
    /*
     * The read and the write in one transaction, under the row's own lock. The
     * closing date below is derived from what the row already holds, so a
     * reopen and a close arriving together would otherwise both read the same
     * value and the later write would commit a date neither decided on - which
     * the retention clock then runs on.
     */
    const issue = await this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, issueId);

      const existing = await tx.issue.findUnique({
        where: { id: issueId },
        select: { id: true, status: true, closedAt: true },
      });
      if (existing === null) {
        throw new IssueError("No such issue.", "issue-not-found");
      }

      /*
       * Who moved it, and between which statuses, in the transaction that moves
       * it. A request that names the status the issue already has changes
       * nothing and records nothing. Never the description or the location,
       * which are the reporter's own words.
       */
      if (existing.status !== status) {
        await this.audit.record(
          {
            action: "ISSUE_STATUS_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issue",
            targetId: issueId,
            context: { from: existing.status, to: status },
          },
          tx,
        );
      }

      return tx.issue.update({
        where: { id: issueId },
        data: {
          status,
          /*
           * The day the issue was closed, and null again if it is reopened.
           *
           * Its own column rather than updatedAt, which is what the retention
           * clock on a public-form report has to run on: detaching a reporter
           * from a neighbouring issue is an update, so a clock reading updatedAt
           * would push its own purge date away every night the purge ran.
           *
           * Set on the move into DONE and not on every request that names it.
           * A board member clicking twice, or a retry, would otherwise put a new
           * date on an issue nobody reopened, and a clock that resets when
           * somebody presses the same button again is not a clock: the reporter's
           * contact details would be kept past the window the policy states.
           */
          closedAt:
            status === "DONE" ? (existing.closedAt ?? new Date()) : null,
        },
        include: ISSUE_INCLUDE,
      });
    });

    this.logger.log(`Issue ${issue.id} moved to ${status}`);

    const reporterId = issue.reporterPersonId;
    const persons =
      reporterId === null
        ? []
        : await this.prisma.person.findMany({
            where: { id: reporterId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });

    return toQueuedView(
      issue,
      await this.reporterOf(
        issue,
        new Map(persons.map((person) => [person.id, person])),
      ),
    );
  }

  /**
   * Attaches a photograph to one's own report.
   *
   * The file goes through the media layer like every other, so it is identified
   * from its own bytes, given a generated key and served from this instance's
   * origin. It is recorded INTERNAL, which means no session, no file.
   *
   * It is narrowed to `issues:handle`, which the database requires of every
   * INTERNAL file: whoever handles issues reads it with that capability, and
   * the reporter, who holds none, reads it through the issue that links it
   * (MediaService.open). What keeps a photo private beyond that is that nothing
   * hands out its identifier: it is reachable only through an issue payload,
   * and those are filtered to the reporter and to whoever handles issues.
   */
  async attachPhoto(input: {
    issueId: string;
    reporterPersonId: string;
    bytes: Buffer;
    fileName: string;
  }): Promise<IssuePhotoView> {
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: input.issueId,
        reporterPersonId: input.reporterPersonId,
      },
      select: { id: true, _count: { select: { photos: true } } },
    });
    if (issue === null) {
      throw new IssueError("No such issue.", "issue-not-found");
    }
    if (issue._count.photos >= MAX_PHOTOS_PER_ISSUE) {
      throw new IssueError(
        "This report already carries as many photographs as it may.",
        "too-many-photos",
      );
    }

    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      visibility: "INTERNAL",
      // Whoever handles issues, and the reporter, through the issue: see
      // MediaService.open.
      requiredCapability: "issues:handle",
      /*
       * Declared true without asking, which is the safe direction.
       *
       * The declaration is the input the publication guardrails need: a person
       * may appear on a public page only with a recorded publication consent,
       * and a file nobody declared cannot be checked against that rule. Nobody
       * knows whether a photograph of a stairwell caught a neighbour on it, and
       * an issue photograph is never published anyway - so it is recorded as if
       * it shows someone, and a later path that wanted to publish it would have
       * to answer for that.
       */
      showsIdentifiablePersons: true,
      uploadedByPersonId: input.reporterPersonId,
      channel: "WEB",
    });

    /*
     * Counted again under the issue's lock. The count above only spares the
     * disk an upload that was going to be refused; uploads sent together all
     * pass it, and only a count that each of them takes in turn holds the cap
     * and gives every photograph its own place in the order.
     */
    let photo: { id: string };
    try {
      photo = await this.prisma.$transaction(async (tx) => {
        await lockIssue(tx, issue.id);
        const photos = await tx.issuePhoto.count({
          where: { issueId: issue.id },
        });
        if (photos >= MAX_PHOTOS_PER_ISSUE) {
          throw new IssueError(
            "This report already carries as many photographs as it may.",
            "too-many-photos",
          );
        }
        return tx.issuePhoto.create({
          data: { issueId: issue.id, fileId: file.id, sortOrder: photos },
          select: { id: true },
        });
      });
    } catch (cause) {
      // The upload is already in the audit log, and so is this removal. That
      // pair is the honest record of what happened.
      //
      // The media service logs a failure to remove the stored file, but not
      // one of its own database transaction, which would leave the file behind
      // with nothing in the logs to say so. The original failure is still the
      // one raised.
      await this.media
        .remove(file.id, input.reporterPersonId, "WEB")
        .catch((removal: unknown) => {
          this.logger.error(
            `Could not remove file ${file.id} after its photograph was refused: ` +
              failureName(removal),
          );
        });
      throw cause;
    }

    return {
      id: photo.id,
      url: file.url,
      fileName: file.fileName,
      width: file.width,
      height: file.height,
    };
  }

  /**
   * The apartments the reporter may file against: their own, today.
   *
   * A picker over the whole register would enumerate the building, and an issue
   * filed against somebody else's home is a report about a neighbour rather
   * than about the building. The free-text location covers everything that is
   * not an apartment.
   */
  async ownApartments(personId: string): Promise<IssueApartmentView[]> {
    const residencies = await this.prisma.residency.findMany({
      where: { personId, ...residencyHeldOn(localDayOf(new Date())) },
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: { movedInOn: "asc" },
    });

    const seen = new Set<string>();
    const apartments: IssueApartmentView[] = [];
    for (const residency of residencies) {
      if (seen.has(residency.apartment.id)) {
        continue;
      }
      seen.add(residency.apartment.id);
      apartments.push(toApartmentView(residency.apartment));
    }
    return apartments;
  }

  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
  ): Promise<string> {
    const apartments = await this.ownApartments(personId);
    if (!apartments.some((apartment) => apartment.id === apartmentId)) {
      // Deliberately the same answer as an apartment that is not in the
      // register: otherwise this endpoint enumerates the building.
      throw new IssueError("No such apartment.", "apartment-not-found");
    }
    return apartmentId;
  }

  /**
   * Queue rows for these issues, with their reporters read in one query.
   *
   * The one place a list of rows becomes the queue's view, so a page and the
   * screen's whole list cannot disagree about what a row carries; with `omit`,
   * the rows whose reporter has protected personal data are dropped here.
   */
  private async queuedViews(
    issues: readonly (IssueRecord & {
      reporterPersonId: string | null;
      reporterNameCipher: string | null;
      reporterEmailCipher: string | null;
    })[],
    protectedReporters: ProtectedReporters,
  ): Promise<QueuedIssueView[]> {
    const personIds = [
      ...new Set(
        issues
          .map((issue) => issue.reporterPersonId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const persons = await this.prisma.person.findMany({
      where: { id: { in: personIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    const byId = new Map(persons.map((person) => [person.id, person]));

    const views = await Promise.all(
      issues.map(async (issue) =>
        toQueuedView(issue, await this.reporterOf(issue, byId)),
      ),
    );
    return protectedReporters === "omit"
      ? views.filter((view) => view.reporter.kind !== "protected")
      : views;
  }

  /**
   * The issues no person with protected personal data reported.
   *
   * `reporterPersonId` is a plain column rather than a relation (see the
   * schema), so the protected persons are named rather than joined. They are
   * few in any association. A null reporter is kept explicitly, because `NOT
   * IN` is not true of a null column.
   */
  private async notReportedByProtectedPersons(): Promise<Prisma.IssueWhereInput> {
    const persons = await this.prisma.person.findMany({
      where: { protectedPersonalData: true },
      select: { id: true },
    });
    if (persons.length === 0) {
      return {};
    }
    return {
      OR: [
        { reporterPersonId: null },
        { reporterPersonId: { notIn: persons.map((person) => person.id) } },
      ],
    };
  }

  private async reporterOf(
    issue: {
      reporterPersonId: string | null;
      reporterNameCipher: string | null;
      reporterEmailCipher: string | null;
    },
    persons: ReadonlyMap<
      string,
      {
        id: string;
        firstName: string;
        lastName: string;
        protectedPersonalData: boolean;
      }
    >,
  ): Promise<IssueReporterView> {
    const personId = issue.reporterPersonId;

    if (personId !== null) {
      const person = persons.get(personId);
      if (person === undefined) {
        return { kind: "unknown" };
      }
      if (person.protectedPersonalData) {
        return { kind: "protected" };
      }
      return {
        kind: "resident",
        personId: person.id,
        name: `${person.firstName} ${person.lastName}`.trim(),
      };
    }

    if (
      issue.reporterNameCipher === null &&
      issue.reporterEmailCipher === null
    ) {
      return { kind: "unknown" };
    }

    return {
      kind: "external",
      name:
        issue.reporterNameCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterName",
              issue.reporterNameCipher,
            ),
      email:
        issue.reporterEmailCipher === null
          ? null
          : await this.encryption.decrypt(
              "issue.reporterEmail",
              issue.reporterEmailCipher,
            ),
    };
  }
}

const APARTMENT_SELECT = {
  id: true,
  number: true,
  address: { select: { street: true, number: true } },
} as const;

const ISSUE_INCLUDE = {
  type: { select: { id: true, name: true, audience: true } },
  apartment: { select: APARTMENT_SELECT },
  photos: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      file: { select: { id: true, fileName: true, width: true, height: true } },
    },
  },
} as const;

/**
 * Open issues first and oldest first within a status, because the queue is
 * worked from the top. The identifier makes the order total, which a cursor
 * needs: rows written in one transaction share an instant exactly.
 */
const QUEUE_ORDER = [
  { status: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssueOrderByWithRelationInput[];

function queueWhere(filter: IssueQueueFilter): Prisma.IssueWhereInput {
  return {
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.typeId === undefined ? {} : { typeId: filter.typeId }),
    ...(filter.audience === undefined
      ? {}
      : { type: { audience: filter.audience } }),
  };
}

/**
 * Everything in the queue strictly after one point in it, written out for the
 * reason `afterInQueue` in the motion service gives: the query builder's own
 * cursor names a row, and a purged row would answer a page silently empty.
 */
function afterInQueue(cursor: IssueQueueCursor): Prisma.IssueWhereInput {
  const later = QUEUE_STATUS_ORDER.slice(
    QUEUE_STATUS_ORDER.indexOf(
      cursor.status as (typeof QUEUE_STATUS_ORDER)[number],
    ) + 1,
  );
  return {
    OR: [
      {
        status: cursor.status,
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
      { status: { in: [...later] } },
    ],
  };
}

interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

function toApartmentView(apartment: ApartmentRecord): IssueApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

/**
 * Refuses a report whose post would not take it, which takes the report back
 * with the transaction it was filed in.
 */
function refuseUnlinked(outcome: IssueLinkOutcome): void {
  switch (outcome) {
    case "linked":
      return;
    case "post-not-found":
      throw new IssueError("No such post.", "post-not-found");
    case "not-reportable":
      throw new IssueError(
        "Only its writer or the board makes a report from a post.",
        "post-not-reportable",
      );
    case "already-reported":
      throw new IssueError(
        "A report has already been made from this post.",
        "post-already-reported",
      );
  }
}

/**
 * A report whose type was removed after it was read.
 *
 * Both reporting paths read the type before they write, so a board removing it
 * at the same moment makes the insert raise P2003 against the restrictive key.
 * That is a type that does not exist, and is answered as one rather than with
 * a 500. The apartment's key cannot be the one: the reporter's residency holds
 * the apartment in the register.
 */
function typeRemoved(cause: unknown): never {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2003"
  ) {
    throw new IssueError("No such issue type.", "type-not-found");
  }
  throw cause;
}

interface IssueRecord {
  id: string;
  status: IssueStatus;
  location: string | null;
  description: string;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  type: { id: string; name: string; audience: IssueAudience };
  apartment: ApartmentRecord | null;
  photos: {
    id: string;
    file: {
      id: string;
      fileName: string;
      width: number | null;
      height: number | null;
    };
  }[];
}

/**
 * The one way a queue row is built, so the listing and the answer to a status
 * change cannot disagree about what a protected reporter's row carries.
 */
function toQueuedView(
  issue: IssueRecord,
  reporter: IssueReporterView,
): QueuedIssueView {
  const view = toOwnView(issue);
  const audience = issue.type.audience;
  const closedAt = issue.closedAt?.toISOString() ?? null;
  if (reporter.kind === "protected") {
    return { ...view, apartment: null, audience, reporter, closedAt };
  }
  return { ...view, audience, reporter, closedAt };
}

function toOwnView(issue: IssueRecord): OwnIssueView {
  return {
    id: issue.id,
    status: issue.status,
    typeId: issue.type.id,
    typeName: issue.type.name,
    location: issue.location,
    description: issue.description,
    apartment:
      issue.apartment === null ? null : toApartmentView(issue.apartment),
    photos: issue.photos.map((photo) => ({
      id: photo.id,
      url: mediaUrl(photo.file.id),
      fileName: photo.file.fileName,
      width: photo.file.width,
      height: photo.file.height,
    })),
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}
