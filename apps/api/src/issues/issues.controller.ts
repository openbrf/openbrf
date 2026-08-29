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
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
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

const AUDIENCES = ["NON_MEMBER", "MEMBER", "BOARD"] as const;
const STATUSES = ["NEW", "IN_PROGRESS", "DONE"] as const;

const reportSchema = z.object({
  typeId: z.string().min(1),
  apartmentId: z.string().min(1).nullish(),
  location: z.string().max(200).nullish(),
  /**
   * Bounded but generous. A resident describing a leak writes a paragraph, and
   * a cap short enough to truncate one would push the detail into a second
   * report.
   */
  description: z.string().min(1).max(4000),
});

const statusSchema = z.object({ status: z.enum(STATUSES) });

const typeSchema = z.object({
  name: z.string().min(1).max(100),
  audience: z.enum(AUDIENCES),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
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
  constructor(private readonly issues: IssueService) {}

  @Get()
  async list(@Query("status") status?: string): Promise<QueuedIssueView[]> {
    const filter = z.enum(STATUSES).optional().parse(status);
    return this.issues.listQueue({ status: filter });
  }

  @Post(":id/status")
  async setStatus(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<QueuedIssueView> {
    const input = statusSchema.parse(body);
    return this.issues.setStatus(id, input.status);
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
}
