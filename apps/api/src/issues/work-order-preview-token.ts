import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * What a sending must show to prove it is the work order a handler previewed.
 *
 * The preview names the recipient - the contractor's name and address as the
 * list holds them at that moment - and shows the text. The sending reads the
 * list again, and the board may have changed the address in between; without
 * a binding, the mail would go to an address the handler never saw. So the
 * preview signs what it showed, and the sending is refused unless what it
 * would send is what was signed (`WorkOrderService.send`).
 *
 * Signed, not stored: the token is an HMAC over the issue, the handler, the
 * contractor, digests of the recipient's name and address and of the text,
 * and an expiry, keyed from the instance's own secret. Nothing in it is
 * readable - the address and the text are digests - and nothing is kept on
 * the server between the preview and the sending.
 */

/** How long a preview may be sent from. Long enough to read it twice. */
export const WORK_ORDER_PREVIEW_TTL_MS = 30 * 60 * 1000;

/** What a preview showed, and what the sending is checked against. */
export interface PreviewedWorkOrder {
  issueId: string;
  readerPersonId: string;
  contractorId: string;
  recipientName: string;
  recipientEmail: string;
  /** The text as folded and stored, not as typed. */
  body: string;
}

/**
 * The key a preview is signed with: derived from the instance's secret under
 * a label of its own, so a token here can never be read as anything the
 * secret signs elsewhere.
 */
export function previewKey(secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("openbrf:work-order-preview:v1")
    .digest();
}

export function signPreview(
  key: Buffer,
  order: PreviewedWorkOrder,
  now: Date,
): string {
  const expiresAt = now.getTime() + WORK_ORDER_PREVIEW_TTL_MS;
  return `${String(expiresAt)}.${mac(key, order, expiresAt).toString("base64url")}`;
}

/** Whether a token was signed for exactly this work order and is not expired. */
export function previewMatches(
  key: Buffer,
  token: string,
  order: PreviewedWorkOrder,
  now: Date,
): boolean {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (match === null) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) {
    return false;
  }
  const given = Buffer.from(match[2] ?? "", "base64url");
  const expected = mac(key, order, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function mac(
  key: Buffer,
  order: PreviewedWorkOrder,
  expiresAt: number,
): Buffer {
  // Each part a fixed-length digest or an identifier with no separator in it,
  // joined by one, so no two different work orders sign the same string.
  const parts = [
    order.issueId,
    order.readerPersonId,
    order.contractorId,
    digest(order.recipientName),
    digest(order.recipientEmail),
    digest(order.body),
    String(expiresAt),
  ];
  return createHmac("sha256", key).update(parts.join("\n")).digest();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
