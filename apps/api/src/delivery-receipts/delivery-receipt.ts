import type { Prisma } from "../generated/prisma/client";

/**
 * A delivery receipt as the board's documents and a plugin's reads state it.
 *
 * One shape for both, read with one select, so the fee notice document, the
 * debiting list and `host.finances` cannot disagree about what a receipt says.
 * It holds no person and no payment: see the model comment on
 * `DeliveryReceipt`.
 */
export interface DeliveryReceiptRow {
  id: string;
  /** The plugin that recorded it. */
  pluginId: string;
  /** The route, in that plugin's own word for it. */
  channel: string;
  /** What the receiving system calls the delivery. */
  reference: string;
  /** When the plugin says it delivered. An ISO 8601 instant. */
  deliveredAt: string;
  /** When the receipt was recorded. An ISO 8601 instant. */
  recordedAt: string;
}

/** The columns a receipt is read with, wherever it is read. */
export const DELIVERY_RECEIPT_FIELDS = {
  id: true,
  pluginId: true,
  channel: true,
  reference: true,
  deliveredAt: true,
  createdAt: true,
} as const;

/**
 * The order receipts are listed in: when they were delivered, then stably. A
 * fresh list on each call, because the client takes a mutable one.
 */
export function deliveryReceiptOrder(): Prisma.DeliveryReceiptOrderByWithRelationInput[] {
  return [{ deliveredAt: "asc" }, { id: "asc" }];
}

export function deliveryReceiptOf(row: {
  id: string;
  pluginId: string;
  channel: string;
  reference: string;
  deliveredAt: Date;
  createdAt: Date;
}): DeliveryReceiptRow {
  return {
    id: row.id,
    pluginId: row.pluginId,
    channel: row.channel,
    reference: row.reference,
    deliveredAt: row.deliveredAt.toISOString(),
    recordedAt: row.createdAt.toISOString(),
  };
}

/**
 * A route, in the characters a plugin id is written in: lowercase letters and
 * digits in hyphen-separated runs, at most 32. The migration holds the same.
 */
export const DELIVERY_CHANNEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DELIVERY_CHANNEL_LENGTH = 32;
export const MAX_DELIVERY_REFERENCE_LENGTH = 128;
