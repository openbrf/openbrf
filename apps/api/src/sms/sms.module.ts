import { Global, Module } from "@nestjs/common";

import { SmsService } from "./sms.service";

/**
 * Text messaging, behind one interface and whichever driver the board
 * configured.
 *
 * Global alongside mail, for the same reason: reaching the members is
 * infrastructure rather than one feature's private business, and a second
 * feature that needs to text somebody must not have to import the news module
 * to do it.
 */
@Global()
@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
