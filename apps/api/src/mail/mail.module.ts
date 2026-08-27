import { Global, Module } from "@nestjs/common";

import { MailService } from "./mail.service";

/**
 * Correspondence is infrastructure: invitations, sign-in links and the move
 * flows all send mail, so the service is provided globally alongside the
 * database, crypto, audit and translation modules.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
