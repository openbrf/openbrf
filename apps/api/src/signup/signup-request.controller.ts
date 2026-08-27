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
import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { SignupRequestService } from "./signup-request.service";

const submitSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().min(3).max(320),
  phone: z.string().max(40).optional(),
  // Free text: the form must not enumerate the register before sign-in.
  claimedAddress: z.string().min(1).max(200),
  claimedApartmentNumber: z.string().min(1).max(20),
});

const approveSchema = z.object({
  apartmentId: z.string().min(1),
  role: z.enum(["MEMBER", "RESIDENT"]).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

/**
 * The visitor-facing form. Public because the person has no account yet, and
 * gated by the association's self-signup toggle inside the service.
 */
@Public()
@Controller("api/signup-requests/submit")
export class SignupRequestSubmitController {
  constructor(private readonly requests: SignupRequestService) {}

  @Post()
  @HttpCode(202)
  async submit(@Body() body: unknown): Promise<{ id: string }> {
    return this.requests.submit(submitSchema.parse(body));
  }
}

/** The board's approval queue. */
@Controller("api/signup-requests")
@RequireCapability("signupRequest:decide")
export class SignupRequestController {
  constructor(private readonly requests: SignupRequestService) {}

  @Get()
  async listPending() {
    const pending = await this.requests.listPending();
    return pending.map((request) => ({
      ...request,
      createdAt: request.createdAt.toISOString(),
    }));
  }

  @Post(":id/approve")
  async approve(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ personId: string }> {
    const input = approveSchema.parse(body);
    return this.requests.approve({
      requestId: id,
      apartmentId: input.apartmentId,
      role: input.role,
      decidedByPersonId: request.principal?.personId ?? "",
    });
  }

  @Post(":id/reject")
  @HttpCode(204)
  async reject(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const input = rejectSchema.parse(body);
    await this.requests.reject({
      requestId: id,
      reason: input.reason,
      decidedByPersonId: request.principal?.personId ?? "",
    });
  }
}
