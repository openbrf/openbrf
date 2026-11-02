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
  type IssueTypeView,
  IssueTypeService,
  type ReportableIssueTypeView,
} from "./issue-type.service";
import {
  type IssueApartmentView,
  type IssuePhotoView,
  IssueService,
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

const typeSchema = z.object({
  name: z.string().trim().min(1).max(ISSUE_TYPE_LIMITS.name),
  reporters: z.array(z.enum(ISSUE_REPORTER_GROUPS)).max(3),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
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
  ) {}

  /**
   * Every type with its statuses, which is what a handler moves an issue
   * between.
   *
   * Under issues:handle rather than the catalogue's issues:configure, because
   * moving an issue needs its type's statuses and the property manager, who
   * handles issues, does not configure them. It reads what `issue_type_list`
   * already gives the same holder (ADR 0040): the board's names for its
   * categories and their statuses, and counts.
   */
  @Get("types")
  async listTypes(): Promise<IssueTypeView[]> {
    return this.types.listAll();
  }

  /** The queue, or the part of it whose status has one meaning. */
  @Get()
  async list(@Query("meaning") meaning?: string): Promise<QueuedIssueView[]> {
    const filter = z.enum(ISSUE_STATUS_MEANINGS).optional().parse(meaning);
    return this.issues.listQueue({ meaning: filter });
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
  async list(): Promise<IssueTypeView[]> {
    return this.types.listAll();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<IssueTypeView> {
    return this.types.create(typeSchema.parse(body));
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<IssueTypeView> {
    return this.types.update(id, typeSchema.parse(body));
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.types.remove(id);
  }

  /** Adds a status to a type, under one of the four meanings. */
  @Post(":id/statuses")
  @HttpCode(201)
  async addStatus(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<IssueTypeView> {
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
  ): Promise<IssueTypeView> {
    return this.types.updateStatus(
      id,
      statusId,
      changeStatusSchema.parse(body),
    );
  }
}
