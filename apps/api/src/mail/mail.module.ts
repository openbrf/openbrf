import { Global, Module } from "@nestjs/common";

import { MailSettingsResolver } from "./mail-settings";
import { MailService } from "./mail.service";

/**
 * Correspondence is infrastructure: invitations, sign-in links and the move
 * flows all send mail, so the service is provided globally alongside the
 * database, crypto, audit and translation modules.
 *
 * The resolver is exported beside it, because the settings screen and the
 * record of processing activities have to name the mail the service actually
 * sends through, and a second reading of the configuration could disagree.
 */
@Global()
@Module({
  providers: [MailSettingsResolver, MailService],
  exports: [MailSettingsResolver, MailService],
})
export class MailModule {}
