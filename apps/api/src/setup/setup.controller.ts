import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { SetupService, type SetupState } from "./setup.service";

const administratorSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.email().max(320),
  // Matches the minimum Better Auth is configured with. Checked here as well so
  // a too-short password is a validation failure on this endpoint rather than an
  // error from inside the account creation, halfway through the flow.
  password: z.string().min(12).max(200),
  preferredLocale: z.enum(SUPPORTED_LOCALES).optional(),
});

/**
 * Ten attempts a minute from one client address.
 *
 * The wizard is filled in once, by one person, on an instance nobody has
 * claimed yet - but a rejected password or address is an attempt too, so the
 * budget leaves room for the retries that come with typing into a form. The
 * window this endpoint is open at all is the reason it is limited: whoever
 * reaches it first becomes the administrator of the instance.
 */
const ADMINISTRATOR_ATTEMPTS_PER_MINUTE = 10;

/**
 * The unauthenticated half of first boot.
 *
 * Two routes, both public by necessity: on a fresh instance there is no account
 * to authenticate with, which is the whole point of the wizard. The service
 * decides whether the instance is still unclaimed, and everything the wizard
 * does after this point sits behind association:manage on the settings and
 * address controllers.
 */
@Public()
@Controller("api/setup")
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /**
   * Whether first-boot setup is still open.
   *
   * The single boolean is the entire response. The client needs it to decide
   * whether to route a visitor to the wizard or to the sign-in screen, and
   * nothing else here is safe to hand an anonymous caller: the housing
   * cooperative's name, its addresses and its apartments all sit behind a login
   * (decision 28).
   */
  @Get("state")
  async state(): Promise<SetupState> {
    return this.setup.state();
  }

  @Post("administrator")
  @PublicRateLimit({ perMinute: ADMINISTRATOR_ATTEMPTS_PER_MINUTE })
  async createAdministrator(
    @Body() body: unknown,
  ): Promise<{ personId: string }> {
    return this.setup.createFirstAdministrator(administratorSchema.parse(body));
  }
}

/**
 * The authenticated half: finishing the wizard.
 *
 * Separate controller because the capability applies to the whole class, and
 * mixing it with the public routes above would mean one @Public() and one
 * @RequireCapability() on the same class - where a mistake silently opens a
 * route rather than closing it.
 */
@Controller("api/setup")
@RequireCapability("association:manage")
export class SetupCompletionController {
  constructor(private readonly setup: SetupService) {}

  @Post("complete")
  async complete(
    @Req() request: RequestWithPrincipal,
  ): Promise<{ completedAt: string }> {
    const result = await this.setup.complete(request.principal?.personId ?? "");
    return { completedAt: result.completedAt.toISOString() };
  }
}
