import { Module } from "@nestjs/common";

import { SupportAccessController } from "./support-access.controller";
import { SupportAccessService } from "./support-access.service";
import { SupportSessionController } from "./support-session.controller";

/**
 * Support access the administrator opens (ADR 0028): opening and closing it
 * from the settings, the sign-in link the host asks for, and the support
 * session a supporter signs in to.
 *
 * Not global. The authorization guard resolves a support session's cookie
 * through the service, and the management listener issues sign-in links with
 * it, so AuthorizationModule and ManagementModule import this module - and a
 * plugin, which resolves only what global modules export, reaches neither.
 */
@Module({
  controllers: [SupportAccessController, SupportSessionController],
  providers: [SupportAccessService],
  exports: [SupportAccessService],
})
export class SupportModule {}
