import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
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
 * Activation, reached from the emailed link.
 *
 * Public by necessity: the person has no account yet, so there is no session to
 * authenticate. The invitation token is the credential.
 */
@Public()
@Controller("api/invitations/accept")
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  async accept(@Body() body: unknown): Promise<{ personId: string }> {
    const input = acceptInvitationSchema.parse(body);
    return this.invitations.accept(input);
  }
}
