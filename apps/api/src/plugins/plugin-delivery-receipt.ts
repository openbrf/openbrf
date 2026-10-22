import type { PluginDeliveryReceipt } from "@openbrf/plugin-sdk";

import type { DeliveryReceiptRow } from "../delivery-receipts/delivery-receipt";

/**
 * A receipt as a plugin is handed it: its reference withheld where the row it
 * is on is, and wherever another plugin wrote it.
 *
 * The reference is free text a plugin wrote, possibly before the household was
 * protected or a person restricted their processing, and a name in it reaches
 * every plugin that reads the finances, one installed later included. So it is
 * withheld by the register as it stands at the read, as the names beside it
 * are.
 *
 * Another plugin's reference is withheld on every row. It is that plugin's
 * account of its own delivery - a voucher number in somebody else's
 * accounting system, a message id at somebody else's mail provider - and the
 * board consented to each plugin reading the books, not to each reading what
 * the others wrote about them. The receipt itself stays, with the plugin and
 * the route, so a plugin can still tell that the row went and not send it
 * again.
 *
 * The board's own screen reads the row, not this, and keeps every reference.
 */
export function pluginReceiptOf(
  row: DeliveryReceiptRow,
  reader: string,
  withheld: boolean,
): PluginDeliveryReceipt {
  return {
    id: row.id,
    pluginId: row.pluginId,
    channel: row.channel,
    reference:
      withheld || row.pluginId !== reader
        ? { state: "withheld" }
        : { state: "visible", text: row.reference },
    deliveredAt: row.deliveredAt,
    recordedAt: row.recordedAt,
  };
}
