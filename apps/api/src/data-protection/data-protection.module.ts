import { Module } from "@nestjs/common";

import { BreachReminderService } from "./breach-reminder.service";
import { BreachService } from "./breach.service";
import { DataProtectionController } from "./data-protection.controller";
import { DataProtectionSeedService } from "./data-protection-seed.service";
import { ProcessingActivityService } from "./processing-activity.service";
import { ProcessorAgreementService } from "./processor-agreement.service";
import { ProcessorFactsService } from "./processor-facts.service";
import { DataSubjectRequestController } from "./data-subject-request.controller";
import { DataSubjectRequestService } from "./data-subject-request.service";

/**
 * Data protection (dataskydd): what the association owes as controller.
 *
 * The retention module beside this one answers "how long is this kept, and what
 * suspends that". This one answers the questions a supervisory authority asks:
 * what processing does the association perform and on what basis (GDPR art.
 * 30), what happened when something went wrong (art. 33), who receives the data
 * and under what agreement (art. 28), and what has it decided when somebody
 * asked about their own data (art. 17, 18 and 21).
 *
 * Separate from the retention module although the two meet at the purge,
 * because the audiences differ: retention is machinery the product runs on its
 * own schedule, and this is a record the board keeps and answers for. They meet
 * in one place - a granted erasure request, which the purge reads - and that
 * meeting is one direction only: the purge reads the request table, and nothing
 * here reaches into the purge.
 *
 * Exported rather than private, because three other modules need one service
 * each and none of them should need the whole subject: the move flow closes a
 * standing erasure request when somebody moves back in, the plugin module
 * records what an installed plugin receives, and setup seeds the record of
 * processing when an instance is first configured.
 */
@Module({
  controllers: [DataProtectionController, DataSubjectRequestController],
  providers: [
    BreachService,
    BreachReminderService,
    DataSubjectRequestService,
    ProcessingActivityService,
    ProcessorFactsService,
    ProcessorAgreementService,
    DataProtectionSeedService,
  ],
  exports: [
    DataSubjectRequestService,
    ProcessingActivityService,
    ProcessorAgreementService,
    // The plugin module records a recipient and a processing on install, and
    // both need to know what this instance is configured to hand data to.
    ProcessorFactsService,
    DataProtectionSeedService,
  ],
})
export class DataProtectionModule {}
