import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { LICENCE_FILE_MAX_BYTES } from "@openbrf/plugin-sdk";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { requirePersonId } from "../authorization/require-principal";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  LicenceAdminService,
  type LicencesOverview,
  type LicenceView,
} from "./licence-admin.service";

/**
 * The file as text, which is how a licence file is written. Bounded loosely
 * here: the service bounds it in bytes and refuses a larger file as
 * `too-large`, which says more to the board than a malformed request would.
 */
const enterSchema = z.object({
  licence: z
    .string()
    .min(1)
    .max(LICENCE_FILE_MAX_BYTES * 4),
});

const idSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * The licence screen's routes (ADR 0042), under the capability that installs
 * plugins: a licence is what a paid plugin reads, and entering one is the same
 * authority that installed it.
 *
 * The capability sits on the class so a route added here later inherits it.
 */
@Controller("api/licences")
@RequireCapability("association:manage")
export class LicencesController {
  constructor(private readonly licences: LicenceAdminService) {}

  @Get()
  async overview(): Promise<LicencesOverview> {
    return this.licences.overview();
  }

  @Post()
  async enter(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<LicenceView> {
    const { licence } = enterSchema.parse(body);
    return this.licences.enter(Buffer.from(licence, "utf8"), {
      personId: requirePersonId(request),
      channel: "WEB",
    });
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() request: RequestWithPrincipal,
    @Param() params: unknown,
  ): Promise<void> {
    await this.licences.remove(idSchema.parse(params).id, {
      personId: requirePersonId(request),
      channel: "WEB",
    });
  }
}
