import { Module } from "@nestjs/common";

import { DeliveryReceiptService } from "./delivery-receipt.service";

/**
 * Delivery receipts against fee notices and charges.
 *
 * Written by the plugin host and by nothing else, and read by the fees and
 * charges modules straight off their own rows, so the write service is the
 * whole module. Not global, for the reason `FinanceEventsModule` gives.
 */
@Module({
  providers: [DeliveryReceiptService],
  exports: [DeliveryReceiptService],
})
export class DeliveryReceiptsModule {}
