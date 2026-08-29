import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import { LegalHoldService, type LegalHoldView } from "./legal-hold.service";

/**
 * Bounded like every other free text the board types into the register, and
 * required: a hold with no reason cannot be reviewed, and an exception to the
 * association's own retention promise has to be reviewable.
 */
const placeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const releaseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * Legal hold (rattsligt bevarandekrav) on one person's service data.
 *
 * Gated on `addressBook:write` beside `addressBook:read`: a hold decides
 * whether a person's data is erased, which is a register decision of the same
 * weight as entering a move-out, and it is the board's rather than an
 * administrator's alone. Reading the holds needs the same gate, because the
 * reason names why a named person's data is being kept.
 *
 * The person's current hold also travels on the address book's person payload,
 * which is what the panel renders; this controller is what changes it, and the
 * history below is what the board reads when it wants to know why a hold
 * stood between two dates.
 */
@Controller("api/legal-holds")
@RequireCapability("addressBook:read", "addressBook:write")
export class LegalHoldController {
  constructor(private readonly holds: LegalHoldService) {}

  @Get("persons/:personId")
  async history(@Param("personId") personId: string): Promise<LegalHoldView[]> {
    return this.holds.history(personId);
  }

  @Post("persons/:personId")
  @HttpCode(201)
  async place(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<LegalHoldView> {
    const input = placeSchema.parse(body);
    return this.holds.place({
      personId,
      reason: input.reason,
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Releases the standing hold.
   *
   * A POST rather than a DELETE: nothing is deleted. The hold row stays with a
   * release date on it, because the record that it stood between two dates is
   * what explains why the purge did not run for that person in that period.
   */
  @Post("persons/:personId/release")
  @HttpCode(200)
  async release(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<LegalHoldView> {
    const input = releaseSchema.parse(body ?? {});
    return this.holds.release({
      personId,
      reason: input.reason,
      actorPersonId: actingPersonId(request),
    });
  }
}
