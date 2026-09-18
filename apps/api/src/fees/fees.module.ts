import { Module } from "@nestjs/common";

import { FeeNotificationService } from "./fee-notification.service";
import { FeePurgeService } from "./fee-purge.service";
import { FeeService } from "./fee.service";
import { FeeNotificationsController, FeesController } from "./fees.controller";

/**
 * The fees the apartments pay (avgifter), and the notices issued from them.
 *
 * A module of its own rather than a second half of the charges module, and
 * `apps/api/src/charges/` is not touched by it. A debitering records that
 * something happened once - which is why that table refuses a row dated into
 * the future - while a fee is a rate that stands until the board changes it,
 * which BRL 9 kap. 13 § makes the board's own standing task. Two concepts, two
 * tables, two capabilities, and the word "charge" appears nowhere here.
 *
 * Two services, because recording what an apartment pays and billing a period
 * are two acts with two different rules about what may be changed afterwards: a
 * rate is superseded and corrected, while a run and its notices are
 * rakenskapsinformation that bokforingslagen 7 kap. 1 § forbids altering at all.
 * Keeping them apart is what stops the second rule leaking into the first.
 *
 * The document is a pure module in `fee-notice.ts` rather than a third service,
 * on `charges/debiting-list.ts`'s precedent, so the screen and the file cannot
 * state different things.
 *
 * The purge is here rather than in the retention module, for the reason the
 * charge, booking and sign-up purges are in theirs: how long a fee is kept is
 * part of recording one at all, not something bolted on afterwards.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * Both services are exported for the data subject access report, which has a
 * section of its own for fees and reads the retention window from the same
 * place this purge does.
 */
@Module({
  controllers: [FeesController, FeeNotificationsController],
  providers: [FeeService, FeeNotificationService, FeePurgeService],
  exports: [FeeService, FeeNotificationService],
})
export class FeesModule {}
