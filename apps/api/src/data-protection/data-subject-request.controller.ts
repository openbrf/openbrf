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
import type { DataSubjectRequestView } from "./data-subject-request";
import { DataSubjectRequestService } from "./data-subject-request.service";

/**
 * Bounded like every other free text the board types into the register.
 *
 * The person's own ground is required: a request with no ground cannot be
 * decided, and the record has to say what was asked for as well as what was
 * answered.
 */
const recordSchema = z.object({
  kind: z.enum(["ERASURE", "OBJECTION", "RESTRICTION"]),
  requestedOn: z.iso.date(),
  ground: z.string().trim().min(1).max(500),
  erasureGround: z
    .enum([
      "NO_LONGER_NECESSARY",
      "CONSENT_WITHDRAWN",
      "OBJECTION_UPHELD",
      "UNLAWFUL_PROCESSING",
      "LEGAL_OBLIGATION_TO_ERASE",
    ])
    .optional(),
  issueId: z.string().trim().min(1).max(64).optional(),
});

const decideSchema = z.object({
  decision: z.enum(["GRANTED", "REFUSED"]),
  ground: z.string().trim().min(1).max(500),
  erasureException: z
    .enum(["NONE", "LEGAL_OBLIGATION_TO_KEEP", "LEGAL_CLAIMS"])
    .optional(),
});

const closeSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * What one person has asked about their own data (GDPR art. 17, 18 and 21).
 *
 * Gated on `addressBook:write` beside `addressBook:read`, exactly as the legal
 * hold is and for the same reason: deciding whether a named person's data is
 * erased, or stops being used, is a register decision of that weight. It is
 * deliberately not `dataProtection:manage`, which gates the association's own
 * records - the breach register, the record of processing, the agreements.
 * Those describe what the association does; this describes what happens to one
 * named person, and the address book is where that decision belongs.
 *
 * The board's overview of every open request is served from the data protection
 * screen, which is where the deadlines are watched; this controller is what
 * changes one.
 */
@Controller("api/data-subject-requests")
@RequireCapability("addressBook:read", "addressBook:write")
export class DataSubjectRequestController {
  constructor(private readonly requests: DataSubjectRequestService) {}

  @Get("persons/:personId")
  async forPerson(
    @Param("personId") personId: string,
  ): Promise<DataSubjectRequestView[]> {
    return this.requests.forPerson(personId);
  }

  @Post("persons/:personId")
  async record(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<DataSubjectRequestView> {
    const input = recordSchema.parse(body);
    return this.requests.record({
      personId,
      kind: input.kind,
      // A date column: the day the person asked, not the moment it was typed.
      requestedOn: new Date(`${input.requestedOn}T00:00:00.000Z`),
      ground: input.ground,
      erasureGround: input.erasureGround ?? null,
      issueId: input.issueId ?? null,
      actorPersonId: actingPersonId(request),
    });
  }

  @Post(":requestId/decision")
  @HttpCode(200)
  async decide(
    @Req() request: RequestWithPrincipal,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
  ): Promise<DataSubjectRequestView> {
    const input = decideSchema.parse(body);
    return this.requests.decide(requestId, {
      decision: input.decision,
      ground: input.ground,
      erasureException: input.erasureException ?? null,
      actorPersonId: actingPersonId(request),
    });
  }

  @Post(":requestId/close")
  @HttpCode(200)
  async close(
    @Req() request: RequestWithPrincipal,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
  ): Promise<DataSubjectRequestView> {
    const input = closeSchema.parse(body);
    return this.requests.close(requestId, {
      reason: input.reason ?? null,
      actorPersonId: actingPersonId(request),
    });
  }
}
