import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { InvitationService } from "./invitation.service";

const sendInvitationSchema = z.object({
  personId: z.string().min(1),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  // Matches the minimum Better Auth is configured with.
  password: z.string().min(12),
});

/** Board-facing: sending invitations. */
@Controller("api/invitations")
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  @RequireCapability("invitation:send")
  @HttpCode(202)
  async send(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ expiresAt: string }> {
    const { personId } = sendInvitationSchema.parse(body);
    const result = await this.invitations.invite({
      personId,
      invitedByPersonId: request.principal?.personId ?? null,
    });
    return { expiresAt: result.expiresAt.toISOString() };
  }
}

/**
 * Ten activations a minute from one client address.
 *
 * A person activates once, from a link mailed to them, so the honest ceiling is
 * a household getting their accounts going in one sitting plus room for a
 * mistyped password. The token is a hashed random secret and guessing it is
 * hopeless with or without a budget; what this bounds is the cost of an
 * automated attempt to find that out.
 */
const ACTIVATIONS_PER_MINUTE = 10;

/**
 * Activation, reached from the emailed link.
 *
 * Public by necessity: the person has no account yet, so there is no session to
 * authenticate. The invitation token is the credential.
 */
@Public()
@Controller("api/invitations/accept")
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationService) {}

  /**
   * Answers with the address the account was created for.
   *
   * Deliberate, and safe: only a caller holding a valid, unexpired, unused
   * token - one that was mailed to that very address - ever reaches this line,
   * so the address is disclosed to the person who already had it. Returning it
   * lets the activation screen sign the new account in through the ordinary
   * password path rather than asking someone to retype the address they just
   * proved possession of. Every refusal above stays a bare `reason`, so no
   * failed attempt learns anything.
   */
  @Post()
  @PublicRateLimit({ perMinute: ACTIVATIONS_PER_MINUTE })
  async accept(
    @Body() body: unknown,
  ): Promise<{ personId: string; email: string }> {
    const input = acceptInvitationSchema.parse(body);
    return this.invitations.accept(input);
  }
}
