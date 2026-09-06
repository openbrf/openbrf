import { Module } from "@nestjs/common";

import { KeyOrderPurgeService } from "./key-order-purge.service";
import { KeyOrderService } from "./key-order.service";
import {
  KeyOrderIntakeController,
  KeyOrderQueueController,
} from "./key-orders.controller";

/**
 * Key orders (nyckelbestallning): what a resident asks the association for, the
 * queue the board works it from, and what becomes of the record that they asked.
 *
 * The intake, the queue and the purge in one module because they are one subject
 * read at three ends. An order is a household asking for a way into the
 * building; the queue is the board answering; and the record of the order is
 * personal data, whose retention window is part of taking orders at all rather
 * than something bolted on afterwards.
 *
 * Two controllers, one capability each, because the audiences are different: a
 * resident orders and reads their own, and the board reads everybody's and
 * answers them. One controller carrying both capabilities would be a route open
 * to the wrong half of them.
 *
 * The database, the audit log, the job queue and the principal the controllers
 * read all come from global modules, which is why nothing is imported here.
 *
 * Nothing here talks to the charges module, and that is deliberate rather than
 * unfinished. What a key costs the member is a charge (debitering) with an
 * amount, a date, a reason and a VAT treatment, exported to whoever keeps the
 * association's books - and a second place holding a sum would be a second
 * answer to what the member owes. A handover recorded here is the basis such a
 * charge would be raised from; the join runs from the charge to the order, so
 * this module holds no amount and no reference to one.
 */
@Module({
  controllers: [KeyOrderIntakeController, KeyOrderQueueController],
  providers: [KeyOrderService, KeyOrderPurgeService],
  exports: [KeyOrderService],
})
export class KeyOrdersModule {}
