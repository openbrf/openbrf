import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { calendarDateSchema } from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { PrismaService } from "../database/prisma.service";
import { IMPORT_FIELDS } from "./import-columns";
import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from "./import-limits";
import type { ImportPreviewRun } from "./import-preview.service";
import type { ImportRunView } from "./import-run";
import {
  type ImportSessionView,
  ImportService,
  MAX_UPLOAD_BYTES,
} from "./import.service";

/**
 * Base64 grows by four bytes for every three, so the encoded ceiling is a third
 * larger than the decoded one. Checked here as well as after decoding, so an
 * oversized upload is refused before it is turned into a buffer.
 */
const MAX_ENCODED_LENGTH = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8;

const uploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  /** The file itself, base64 encoded. */
  content: z.string().min(1).max(MAX_ENCODED_LENGTH),
});

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("use-person"), personId: z.string().min(1) }),
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("skip") }),
]);

/**
 * Keyed by a data row's number, which counts from 1. A file holds at most
 * MAX_IMPORT_ROWS of them, so there are never more decisions than that.
 */
const decisionsSchema = z
  .record(z.string().regex(/^[1-9]\d{0,5}$/), decisionSchema)
  .refine((decisions) => Object.keys(decisions).length <= MAX_IMPORT_ROWS)
  .default({});

const previewSchema = z.object({
  mapping: z.array(z.enum(IMPORT_FIELDS).nullable()).max(MAX_IMPORT_COLUMNS),
  /** Used for rows with no role column. Never guessed. */
  defaultRole: z.enum(["MEMBER", "RESIDENT"]).nullish(),
  defaultMovedInOn: calendarDateSchema.nullish(),
  /**
   * What the board has decided so far. Sent when the screen previews again
   * because a decision changed what later rows match.
   */
  decisions: decisionsSchema,
});

/**
 * What the board answered for the rows the preview could not resolve.
 *
 * The mapping is deliberately not part of this: the apply runs the mapping the
 * preview was taken with, which is the one the board looked at. The token names
 * that preview, so a later one cannot take its place.
 */
const applySchema = z.object({
  previewToken: z.string().min(1).max(100),
  decisions: decisionsSchema,
});

/**
 * Importing a member list.
 *
 * Every route needs the right to write the address book as well as to read it:
 * an import creates people and writes the statutory member register, and that
 * register cannot be corrected by editing afterwards. Residents hold neither
 * capability.
 */
@Controller("api/import")
@RequireCapability("addressBook:read", "addressBook:write")
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The template, in the caller's own language.
   *
   * Served as a download rather than as JSON so the board can open it straight
   * in the spreadsheet they already use.
   */
  @Get("template")
  @Header("content-type", "text/csv; charset=utf-8")
  @Header("content-disposition", 'attachment; filename="openbrf-import.csv"')
  async template(@Req() request: RequestWithPrincipal): Promise<string> {
    const person = await this.prisma.person.findUnique({
      where: { id: actorOf(request) },
      select: { preferredLocale: true },
    });
    return this.imports.template(person?.preferredLocale);
  }

  @Post("sessions")
  async upload(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ImportSessionView> {
    const input = uploadSchema.parse(body);
    return this.imports.upload({
      fileName: input.fileName,
      content: input.content,
      actorPersonId: actorOf(request),
    });
  }

  /**
   * The import that is running, or the last one that ran.
   *
   * Answered without a session id because the screen that asks has none after a
   * reload: it is how a board member who closed the tab finds out what happened
   * to the import they started.
   */
  @Get("sessions/active")
  async active(): Promise<ImportRunView | null> {
    return this.imports.activeRun();
  }

  /**
   * Asks what the mapping would do.
   *
   * A POST, and one that records the mapping: it is a structure rather than a
   * couple of parameters, putting a whole column mapping in a query string
   * would put the file's column titles in every proxy log, and the apply runs
   * what this step previewed. Accepted rather than done, like the apply: the
   * preview is planned by a background job, and this answers with the id to
   * poll it by.
   */
  @Post("sessions/:id/preview")
  @HttpCode(202)
  async preview(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportPreviewRun> {
    const input = previewSchema.parse(body);
    return this.imports.preview(id, {
      mapping: input.mapping,
      defaultRole: input.defaultRole ?? null,
      defaultMovedInOn: input.defaultMovedInOn ?? null,
      decisions: input.decisions,
    });
  }

  /**
   * How far the preview has got, and the preview once it is ready. Polled by
   * the screen until it is.
   */
  @Get("sessions/:id/preview/:previewId")
  async previewRun(
    @Param("id") id: string,
    @Param("previewId") previewId: string,
  ): Promise<ImportPreviewRun> {
    return this.imports.previewRun(id, previewId);
  }

  /**
   * Stops a preview the screen no longer waits for, so the job planning it
   * frees the worker for the next one. Sent as the page is left too, so it
   * answers with nothing and the same whatever the preview's state.
   */
  @Delete("sessions/:id/preview/:previewId")
  @HttpCode(204)
  async cancelPreview(
    @Param("id") id: string,
    @Param("previewId") previewId: string,
  ): Promise<void> {
    await this.imports.cancelPreview(id, previewId);
  }

  /**
   * Starts the import.
   *
   * Accepted rather than done: the register write is a background job, and this
   * answers with the run to watch rather than with a result that does not exist
   * yet.
   */
  @Post("sessions/:id/apply")
  @HttpCode(202)
  async apply(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportRunView> {
    const input = applySchema.parse(body);
    return this.imports.apply(id, {
      decisions: input.decisions,
      previewToken: input.previewToken,
    });
  }

  /** How far the import has got. Polled by the screen while it runs. */
  @Get("sessions/:id/run")
  async run(@Param("id") id: string): Promise<ImportRunView> {
    return this.imports.run(id);
  }
}

function actorOf(request: RequestWithPrincipal): string {
  const personId = request.principal?.personId;
  if (personId === undefined) {
    throw new Error(
      "No principal on the request. The authorization guard must run before " +
        "this controller.",
    );
  }
  return personId;
}
