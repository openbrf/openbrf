import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  SUPPORT_ACCESS_HOURS,
  SUPPORT_REASON_MAX_LENGTH,
} from "@openbrf/shared";
import { z } from "zod";

import { webActor } from "../audit/actor-context";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  SupportAccessService,
  type SupportAccessOverview,
  type SupportAccessView,
} from "./support-access.service";

/** Any control character. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The line breaks and the tab a textarea sends, which a reason may carry. */
const TEXTAREA_WHITESPACE = /[\n\r\t]/gu;

/** Whether a reason carries a control character a textarea would not send. */
function unprintable(reason: string): boolean {
  return CONTROL_CHARACTER.test(reason.replace(TEXTAREA_WHITESPACE, ""));
}

const openSchema = z.object({
  hours: z.literal(SUPPORT_ACCESS_HOURS),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(SUPPORT_REASON_MAX_LENGTH)
    .refine((reason) => !unprintable(reason)),
});

/**
 * Support access, from the instance's settings (ADR 0028).
 *
 * Read with association:read, so the board can see whether a supporter may be
 * looking and who has, as it can see the retention policy: it answers for the
 * association's data whoever administers the instance. Opening and closing are
 * an administrator's, association:manage, because the access is the
 * administrator's instruction to the host.
 *
 * Any administrator closes the open access, not only the one who opened it.
 */
@Controller("api/support-access")
@RequireCapability("association:read")
export class SupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Get()
  async overview(): Promise<SupportAccessOverview> {
    return this.support.overview();
  }

  /** Opens support access for the hours chosen, with the reason given. */
  @Post()
  @RequireCapability("association:manage")
  async open(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<SupportAccessView> {
    return this.support.open(webActor(request), openSchema.parse(body));
  }

  /** Closes the open access; every session under it ends on its next request. */
  @Post(":id/close")
  @RequireCapability("association:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async close(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
  ): Promise<void> {
    await this.support.close(webActor(request), id);
  }
}
