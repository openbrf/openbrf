import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { droppedSubmissionId, isHoneypotFilled } from "../http/honeypot";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { SignupRequestService } from "./signup-request.service";

const submitSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  // Format-checked here rather than only at index time: the service raises
  // invalid-email only when the blind index comes back null, so a malformed
  // address would otherwise be stored and fail much later, when the board
  // approves the request and the invitation cannot be delivered.
  email: z.email().max(320),
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
 * Twenty requests a minute from one client address.
 *
 * Generous on purpose. One address is a household, a shared connection or a
 * whole building behind one line, and several residents asking for accounts in
 * one sitting is the ordinary case this form exists for - being turned away
 * then is a worse failure than a script taking a minute longer. It still bounds
 * what a script can put in the board's queue, which is the point: every entry
 * there is read by a person.
 */
const SUBMISSIONS_PER_MINUTE = 20;

/**
 * The visitor-facing form. Public because the person has no account yet, and
 * gated by the association's self-signup toggle inside the service.
 */
@Public()
@Controller("api/signup-requests/submit")
export class SignupRequestSubmitController {
  private readonly logger = new Logger(SignupRequestSubmitController.name);

  constructor(private readonly requests: SignupRequestService) {}

  @Post()
  @HttpCode(202)
  @PublicRateLimit({ perMinute: SUBMISSIONS_PER_MINUTE })
  async submit(@Body() body: unknown): Promise<{ id: string }> {
    if (isHoneypotFilled(body)) {
      /*
       * Dropped, and answered exactly as a stored request would be - same
       * status, same body, an identifier of the same shape. A script learns
       * nothing about which field gave it away, and nothing reaches the board's
       * queue.
       *
       * Logged without a word of what was submitted, because this is the only
       * trace a dropped submission leaves: if the decoy ever catches a real
       * person, this line is how that gets noticed.
       */
      this.logger.log("Dropped a signup request that filled the honeypot.");
      return { id: droppedSubmissionId() };
    }
    // The schema does not name the honeypot field, so it is stripped here along
    // with anything else that was sent and not asked for.
    return this.requests.submit(submitSchema.parse(body));
  }
}

/**
 * Whether the form above is open.
 *
 * Its own class rather than a second route on the queue below, because the
 * capability there applies to the whole class: one @Public() and one
 * @RequireCapability() on the same controller is the mistake that silently
 * opens a route rather than closing it.
 */
@Public()
@Controller("api/signup-requests/state")
export class SignupRequestStateController {
  constructor(private readonly requests: SignupRequestService) {}

  @Get()
  async state(): Promise<{ enabled: boolean }> {
    return this.requests.state();
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
