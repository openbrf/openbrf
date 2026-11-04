import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { ISSUE_TEXT_RETENTION_YEARS } from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import {
  type IssueLegalHoldView,
  IssueRedactionService,
} from "./issue-redaction.service";
import {
  type IssueRetentionView,
  IssueRetentionSettingService,
} from "./issue-retention-setting.service";

/**
 * A redaction names what it reaches: the description or the location alone,
 * or a message, a note, a photograph or a handler's file by its identifier.
 * Strict, so a field for replacement text is refused rather than ignored: a
 * redaction takes nothing in place of what it removes (ADR 0057).
 */
const redactionSchema = z.discriminatedUnion("target", [
  z.strictObject({ target: z.enum(["description", "location"]) }),
  z.strictObject({
    target: z.enum(["message", "note", "photo", "attachment"]),
    id: z.string().min(1).max(64),
  }),
]);

const legalHoldSchema = z.strictObject({ held: z.boolean() });

const retentionSchema = z.strictObject({
  years: z
    .number()
    .int()
    .min(ISSUE_TEXT_RETENTION_YEARS.min)
    .max(ISSUE_TEXT_RETENTION_YEARS.max),
});

/**
 * A handler's redaction of an issue's free text, and the legal hold on an
 * issue (ADR 0057). Under issues:handle, as every other act on an issue in the
 * queue is, for an issue the handler's type and the issue let in, which the
 * service decides on every request.
 */
@Controller("api/issue-queue")
@RequireCapability("issues:handle")
export class IssueRedactionController {
  constructor(private readonly redaction: IssueRedactionService) {}

  @Post(":id/redactions")
  @HttpCode(204)
  async redact(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.redaction.redact(
      actingPersonId(request),
      id,
      redactionSchema.parse(body),
    );
  }

  @Post(":id/legal-hold")
  async setLegalHold(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueLegalHoldView> {
    return this.redaction.setLegalHold(
      actingPersonId(request),
      id,
      legalHoldSchema.parse(body).held,
    );
  }
}

/**
 * How many years after closing an issue's free text is kept (decision 33).
 * issues:configure, as the type catalogue is: the board decides it.
 */
@Controller("api/issue-retention")
@RequireCapability("issues:configure")
export class IssueRetentionController {
  constructor(private readonly setting: IssueRetentionSettingService) {}

  @Get()
  async read(): Promise<IssueRetentionView> {
    return this.setting.read();
  }

  @Put()
  async update(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueRetentionView> {
    return this.setting.set(
      actingPersonId(request),
      retentionSchema.parse(body).years,
    );
  }
}
