import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { PrismaService } from "../database/prisma.service";
import { IMPORT_FIELDS } from "./import-columns";
import {
  type ImportApplyResult,
  type ImportPreview,
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

const mappingSchema = z.object({
  mapping: z.array(z.enum(IMPORT_FIELDS).nullable()).max(200),
  /** Used for rows with no role column. Never guessed. */
  defaultRole: z.enum(["MEMBER", "RESIDENT"]).nullish(),
  defaultMovedInOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .nullish(),
});

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("use-person"), personId: z.string().min(1) }),
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("skip") }),
]);

const applySchema = mappingSchema.extend({
  decisions: z.record(z.string(), decisionSchema).default({}),
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
   * What the mapping would do.
   *
   * A POST although it changes nothing: the mapping is a structure rather than
   * a couple of parameters, and putting a whole column mapping in a query string
   * would put the file's column titles in every proxy log.
   */
  @Post("sessions/:id/preview")
  @HttpCode(200)
  async preview(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportPreview> {
    const input = mappingSchema.parse(body);
    return this.imports.preview(id, {
      mapping: input.mapping,
      defaultRole: input.defaultRole ?? null,
      defaultMovedInOn: input.defaultMovedInOn ?? null,
    });
  }

  @Post("sessions/:id/apply")
  @HttpCode(200)
  async apply(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportApplyResult> {
    const input = applySchema.parse(body);
    return this.imports.apply(id, {
      mapping: input.mapping,
      defaultRole: input.defaultRole ?? null,
      defaultMovedInOn: input.defaultMovedInOn ?? null,
      decisions: input.decisions,
    });
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
