import { Module } from "@nestjs/common";

import { MemberChargePurgeService } from "./member-charge-purge.service";
import { MemberChargeService } from "./member-charge.service";
import { MemberChargesController } from "./member-charges.controller";

/**
 * Charges to members (debiteringar mot medlem): what the association put on a
 * member or on an apartment, and the debiting list it is handed over as.
 *
 * One service, because recording a charge and reading the list of them are one
 * subject - the list is what the charges are recorded for. The file the board
 * hands over is a serialisation of the same rows and lives in `debiting-list.ts`
 * as a pure module rather than as a second service, so the screen and the file
 * cannot state different things.
 *
 * One controller and one capability, because there is one audience. Unlike the
 * booking and event modules there is no resident-facing half to be shut out of:
 * a member learns what they are charged from the notice the accounting system
 * sends, and Open BRF holds the basis rather than the ledger.
 *
 * The purge is here rather than in the retention module, for the reason the
 * booking and sign-up purges are in theirs: how long a charge is kept is part of
 * recording one at all, not something bolted on afterwards.
 *
 * The database, the audit log, the job queue and the principal the controller
 * reads all come from global modules, which is why nothing is imported here.
 *
 * The service is exported for the data subject access report, which has a
 * section of its own for charges and reads the retention window from the same
 * place this purge does.
 */
@Module({
  controllers: [MemberChargesController],
  providers: [MemberChargeService, MemberChargePurgeService],
  exports: [MemberChargeService],
})
export class ChargesModule {}
