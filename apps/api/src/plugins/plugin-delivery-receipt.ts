import type { PluginDeliveryReceipt } from "@openbrf/plugin-sdk";

import type { DeliveryReceiptRow } from "../delivery-receipts/delivery-receipt";

/**
 * A receipt as a plugin is handed it, its reference withheld where the row it
 * is on is.
 *
 * The reference is free text a plugin wrote, possibly before the household was
 * protected or a person restricted their processing, and a name in it reaches
 * every plugin that reads the finances, one installed later included. So it is
 * withheld by the register as it stands at the read, as the names beside it
 * are. The board's own screen reads the row, not this, and keeps the reference.
 */
export function pluginReceiptOf(
  row: DeliveryReceiptRow,
  withheld: boolean,
): PluginDeliveryReceipt {
  return {
    id: row.id,
    pluginId: row.pluginId,
    channel: row.channel,
    reference: withheld
      ? { state: "withheld" }
      : { state: "visible", text: row.reference },
    deliveredAt: row.deliveredAt,
    recordedAt: row.recordedAt,
  };
}
