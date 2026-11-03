import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ISSUE_CLOSING_OUTCOMES,
  ISSUE_HANDLED_BY,
  ISSUE_PRIORITIES,
  ISSUE_REPORT_LIMITS,
  ISSUE_REPORTER_GROUPS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  ISSUE_TYPE_LIMITS,
  ISSUE_WAITING_REASONS,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import { actingPersonId } from "../registers/acting-person";
import {
  type ConfiguredIssueTypeView,
  type IssueHandlerChoice,
  type IssueTypeView,
  IssueTypeService,
  type ReportableIssueTypeView,
} from "./issue-type.service";
import {
  type IssueResidentChoice,
  IssueResidentsService,
} from "./issue-residents.service";
import {
  type IssueApartmentView,
  type IssueHandlerView,
  type IssuePhotoView,
  IssueService,
  type IssueTimelineStep,
  type OwnIssueView,
  type QueuedIssueView,
} from "./issue.service";

const reportSchema = z.object({
  typeId: z.string().min(1),
  apartmentId: z.string().min(1).nullish(),
  location: z.string().max(ISSUE_REPORT_LIMITS.location).nullish(),
  /** The limit is shared with the form; see `ISSUE_REPORT_LIMITS`. */
  description: z.string().min(1).max(ISSUE_REPORT_LIMITS.description),
  /** The post in the feed the report is made from, when it is. */
  postId: z.string().min(1).max(64).nullish(),
});

/**
 * A move to another status. The reason and the outcome are checked against
 * the target's meaning in the service, which is the only place that reads it.
 */
const statusMoveSchema = z.object({
  statusId: z.string().min(1).max(64),
  waitingReason: z.enum(ISSUE_WAITING_REASONS).optional(),
  outcome: z.enum(ISSUE_CLOSING_OUTCOMES).optional(),
});

/**
 * A handler's opening of an issue (decision 14).
 *
 * Strict, so a field this route no longer reads - a resident named by person
 * and apartment, as the address book named one - is refused rather than
 * dropped: dropped, it would file an internal issue for a handler who meant
 * to name somebody.
 */
const openSchema = z.strictObject({
  typeId: z.string().min(1).max(64),
  /** A residency the resident picker offered; absent for an internal issue. */
  residencyId: z.string().min(1).max(64).nullish(),
  location: z.string().max(ISSUE_REPORT_LIMITS.location).nullish(),
  description: z.string().trim().min(1).max(ISSUE_REPORT_LIMITS.description),
});

const assignSchema = z.object({
  assigneePersonId: z.string().min(1).max(64).nullable(),
});

const prioritySchema = z.object({ priority: z.enum(ISSUE_PRIORITIES) });

/** A calendar date, or null for none; the service reads it as one. */
const targetDateSchema = z.object({
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

const accessSchema = z.object({ boardOnly: z.boolean() });

/** Strict: the ring-fence is changed by a request that names it and nothing else. */
const ringFenceSchema = z.strictObject({ ringFenced: z.boolean() });

const typeSchema = z.object({
  name: z.string().trim().min(1).max(ISSUE_TYPE_LIMITS.name),
  reporters: z.array(z.enum(ISSUE_REPORTER_GROUPS)).max(3),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  handledBy: z.enum(ISSUE_HANDLED_BY).optional(),
  defaultPriority: z.enum(ISSUE_PRIORITIES).optional(),
  defaultAssigneePersonId: z.string().min(1).max(64).nullable().optional(),
});

/** A status's label: the board's own text, and never only whitespace. */
const statusLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(ISSUE_STATUS_LIMITS.label);

const addStatusSchema = z.object({
  meaning: z.enum(ISSUE_STATUS_MEANINGS),
  label: statusLabelSchema,
});

const changeStatusSchema = z.object({
  label: statusLabelSchema,
  active: z.boolean().optional(),
  isDefault: z.literal(true).optional(),
  sortOrder: z.coerce
    .number()
    .int()
    .min(0)
    .max(ISSUE_STATUS_LIMITS.sortOrder)
    .optional(),
});

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so
 * reaching this throw means the guard stopped doing that - and a 500 naming the
 * guard is the honest answer, rather than a database lookup for the empty id.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * Reporting an issue, and reading one's own.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. There is deliberately no @Public() route
 * anywhere in this module: the website's form is server-rendered by the site
 * layer, which calls the services directly, so the application exposes no
 * unauthenticated write surface for issues at all.
 */
@Controller("api/issues")
@RequireCapability("issues:report")
export class IssueReportController {
  constructor(
    private readonly issues: IssueService,
    private readonly types: IssueTypeService,
  ) {}

  /**
   * The types this account may report under.
   *
   * Filtered on the server for the principal asking. The list a resident gets
   * back is the list they may post against, and posting anything else is
   * answered as if that type did not exist.
   */
  @Get("types")
  async reportableTypes(
    @Req() request: RequestWithPrincipal,
  ): Promise<ReportableIssueTypeView[]> {
    return this.types.listReportable(requirePrincipal(request));
  }

  /** The reporter's own apartments, for the picker on the form. */
  @Get("apartments")
  async ownApartments(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueApartmentView[]> {
    return this.issues.ownApartments(requirePrincipal(request).personId);
  }

  @Get("mine")
  async listOwn(@Req() request: RequestWithPrincipal): Promise<OwnIssueView[]> {
    return this.issues.listOwn(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async report(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    return this.issues.report(
      requirePrincipal(request),
      reportSchema.parse(body),
    );
  }

  /**
   * Attaches a photograph to one's own report.
   *
   * Multipart rather than JSON, like the logo upload: the bytes travel as
   * bytes, and the size limit is enforced by the parser as they arrive rather
   * than after the whole body is in the process.
   */
  @Post(":id/photos")
  @HttpCode(201)
  async attachPhoto(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssuePhotoView> {
    const principal = requirePrincipal(request);

    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });

    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    return this.issues.attachPhoto({
      issueId: id,
      reporterPersonId: principal.personId,
      bytes: file.bytes,
      fileName: file.fileName,
    });
  }
}

/**
 * The triage queue.
 *
 * Its own base path rather than a route under the reporting controller, because
 * the capability covers the whole class: one @RequireCapability("issues:report")
 * and one @RequireCapability("issues:handle") on the same controller would be a
 * route that is open to the wrong half of the house.
 */
@Controller("api/issue-queue")
@RequireCapability("issues:handle")
export class IssueQueueController {
  constructor(
    private readonly issues: IssueService,
    private readonly types: IssueTypeService,
    private readonly residents: IssueResidentsService,
  ) {}

  /**
   * Every type the reader handles, with its statuses, which is what a handler
   * moves an issue between and opens one under.
   *
   * Under issues:handle rather than the catalogue's issues:configure, because
   * moving an issue needs its type's statuses and the property manager, who
   * handles issues, does not configure them. It reads what `issue_type_list`
   * already gives the same holder (ADR 0040): the board's names for its
   * categories and their statuses, and counts. A type the board keeps to
   * itself is left out for the property manager (ADR 0054).
   */
  @Get("types")
  async listTypes(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueTypeView[]> {
    return this.issues.handledTypes(actingPersonId(request));
  }

  /** The queue, or the part of it whose status has one meaning. */
  @Get()
  async list(
    @Req() request: RequestWithPrincipal,
    @Query("meaning") meaning?: string,
  ): Promise<QueuedIssueView[]> {
    const filter = z.enum(ISSUE_STATUS_MEANINGS).optional().parse(meaning);
    return this.issues.listQueue(actingPersonId(request), { meaning: filter });
  }

  /** Opens an issue for a named resident, or with no reporter (decision 14). */
  @Post()
  @HttpCode(201)
  async open(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<QueuedIssueView> {
    return this.issues.open(requirePrincipal(request), openSchema.parse(body));
  }

  /**
   * The apartments a handler names a resident from, by designation (the
   * resident picker, ADR 0054).
   */
  @Get("apartments")
  async apartments(
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueApartmentView[]> {
    return this.residents.apartments(actingPersonId(request));
  }

  /**
   * Who lives in one apartment today, by name, a protected resident's
   * withheld, keyed by residency. No search, and nobody who has moved out or
   * not yet in. Audited.
   */
  @Get("apartments/:apartmentId/residents")
  async residentsOf(
    @Param("apartmentId") apartmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueResidentChoice[]> {
    return this.residents.residents(actingPersonId(request), apartmentId);
  }

  /** Who the issue may be assigned to: names, and nothing else. */
  @Get(":id/handlers")
  async handlers(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueHandlerView[]> {
    return this.issues.handlers(actingPersonId(request), id);
  }

  /** Who did what to the issue, and when (decision 16). */
  @Get(":id/timeline")
  async timeline(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueTimelineStep[]> {
    return this.issues.timeline(actingPersonId(request), id);
  }

  @Post(":id/assignee")
  async assign(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.assign(
      id,
      assignSchema.parse(body).assigneePersonId,
      actingPersonId(request),
    );
  }

  @Post(":id/priority")
  async setPriority(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setPriority(
      id,
      prioritySchema.parse(body).priority,
      actingPersonId(request),
    );
  }

  @Post(":id/target-date")
  async setTargetDate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setTargetDate(
      id,
      targetDateSchema.parse(body).targetDate,
      actingPersonId(request),
    );
  }

  /** Closes the issue to all but the board, or opens it again (decision 13). */
  @Post(":id/access")
  async setAccess(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setBoardOnly(
      id,
      accessSchema.parse(body).boardOnly,
      actingPersonId(request),
    );
  }

  @Post(":id/status")
  async setStatus(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<QueuedIssueView> {
    return this.issues.setStatus(
      id,
      statusMoveSchema.parse(body),
      actingPersonId(request),
    );
  }
}

/**
 * The board's own catalogue of issue types.
 *
 * issues:configure rather than association:manage: which problems residents are
 * asked to sort their reports into is the board's vocabulary for its building,
 * the way the retention policy is the board's decision about its data.
 */
@Controller("api/issue-types")
@RequireCapability("issues:configure")
export class IssueTypeAdminController {
  constructor(private readonly types: IssueTypeService) {}

  @Get()
  async list(): Promise<ConfiguredIssueTypeView[]> {
    return this.types.listConfigured();
  }

  /**
   * Who a type's issues may be given to by default: every handler, by name
   * and nothing else, each marked with whether the board keeps them on a type
   * handled by the board only.
   */
  @Get("handlers")
  async handlers(): Promise<IssueHandlerChoice[]> {
    return this.types.handlerChoices();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<ConfiguredIssueTypeView> {
    return this.types.create(typeSchema.parse(body));
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.update(
      id,
      typeSchema.parse(body),
      actingPersonId(request),
    );
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.types.remove(id);
  }

  /** Ring-fences a type from contractors, or lifts its ring-fence. */
  @Put(":id/ring-fence")
  async setRingFence(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.setRingFence(
      id,
      ringFenceSchema.parse(body).ringFenced,
      actingPersonId(request),
    );
  }

  /** Adds a status to a type, under one of the four meanings. */
  @Post(":id/statuses")
  @HttpCode(201)
  async addStatus(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.addStatus(id, addStatusSchema.parse(body));
  }

  /**
   * Renames a status, switches it on or off, moves it, or makes it the default
   * of its meaning. There is no route that removes one: a status is switched
   * off, so the issues that stood in it keep saying where they stood.
   */
  @Put(":id/statuses/:statusId")
  async changeStatus(
    @Param("id") id: string,
    @Param("statusId") statusId: string,
    @Body() body: unknown,
  ): Promise<ConfiguredIssueTypeView> {
    return this.types.updateStatus(
      id,
      statusId,
      changeStatusSchema.parse(body),
    );
  }
}
