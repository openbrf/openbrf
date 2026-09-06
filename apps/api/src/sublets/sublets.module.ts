import { Module } from "@nestjs/common";

import { SubletPurgeService } from "./sublet-purge.service";
import { SubletService } from "./sublet.service";
import {
  SubletIntakeController,
  SubletQueueController,
} from "./sublets.controller";

/**
 * Subletting applications (andrahandsupplatelse): what a member asks the board's
 * consent for, the queue the board answers it from, and what becomes of the
 * record that they asked.
 *
 * The intake, the queue and the purge in one module because they are one subject
 * read at three ends. An application is a bostadsrattshavare asking for
 * something BRL 7 kap. 10 § conditions on the board's consent; the queue is the
 * board answering for it; and the record of the request is personal data, whose
 * retention window is part of taking applications at all rather than something
 * bolted on afterwards.
 *
 * Two controllers, one capability each, because the audiences are different: a
 * member applies and reads their own, and the board reads everybody's and
 * answers them. One controller carrying both capabilities would be a route open
 * to the wrong half of them.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * The service is exported for the screens and endpoints that read the queue
 * without being the ones that write it.
 *
 * Nothing here talks to the charges module, and that is deliberate rather than
 * unfinished. BRL 7 kap. 14 § lets the association charge an avgift for
 * andrahandsupplatelse where the bylaws say so, capped per apartment at ten per
 * cent of the prisbasbelopp a year and pro-rated by calendar month for a part
 * year - a sum, a period and a bylaws clause, which is the charges feature's
 * subject and not this one's. A consent recorded here is the basis such a charge
 * would be raised from; the join runs from the charge to the application, so
 * this module holds no amount and no reference to one.
 */
@Module({
  controllers: [SubletIntakeController, SubletQueueController],
  providers: [SubletService, SubletPurgeService],
  exports: [SubletService],
})
export class SubletsModule {}
