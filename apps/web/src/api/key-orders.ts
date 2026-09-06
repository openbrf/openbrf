import { apiRequest, type ApiResult } from "./client";

/**
 * The key order endpoints (nyckelbestallning).
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Two properties of the contract are load-bearing and invisible in the types.
 *
 * Ordering is a resident's, not a member's: no statute gives anybody a right to
 * a key, so `keyOrders:place` is derived from residency the way `bookings:book`
 * is - and the server asks the register which apartment the caller actually
 * lives in, because an administrator holds every capability and no residency.
 *
 * Nothing here carries a price. What a key costs the member is a charge
 * (debitering) with its own model and its own export to whoever keeps the
 * association's books, and a second place holding a sum would be a second answer
 * to what the member owes.
 */

export type KeyOrderKind = "KEY" | "TAG";

export type KeyOrderStatus =
  "SUBMITTED" | "HANDED_OVER" | "DECLINED" | "WITHDRAWN";

/** An apartment as the resident and the board are told which one it is. */
export interface KeyOrderApartment {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

/** An order as the resident who placed it reads it back. */
export interface OwnKeyOrder {
  id: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: KeyOrderApartment | null;
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
  status: KeyOrderStatus;
  submittedAt: string;
  closedAt: string | null;
  boardNote: string | null;
}

/**
 * Who ordered, as the board is told.
 *
 * `protected` is a person with protected personal data, whose name the queue
 * withholds even though the board's own address book prints it - the apartment
 * is still stated, because the key is for a door and the board has to know
 * which. `unknown` is a reference that no longer resolves to a person.
 */
export type KeyOrderer =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** An order as the board reads it in the queue. */
export interface QueuedKeyOrder extends OwnKeyOrder {
  orderer: KeyOrderer;
  closedByPersonId: string | null;
}

export interface KeyOrderIntake {
  /** The apartments this caller lives in, today. */
  apartments: KeyOrderApartment[];
  orders: OwnKeyOrder[];
}

export interface KeyOrderQueue {
  orders: QueuedKeyOrder[];
}

// --- a resident's own intake -------------------------------------------------

export function fetchKeyOrderIntake(): Promise<ApiResult<KeyOrderIntake>> {
  return apiRequest("GET", "/api/key-orders/mine");
}

export function placeKeyOrder(input: {
  apartmentId: string;
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
}): Promise<ApiResult<{ id: string }>> {
  return apiRequest("POST", "/api/key-orders", input);
}

/**
 * Changes a standing order, while the board has not answered.
 *
 * What is ordered and how much of it, and not the apartment: an order for a
 * different door is a different order, and the server refuses to rewrite one.
 * Every edit goes through the same personal identity number scan the first order
 * did.
 */
export function reviseKeyOrder(input: {
  orderId: string;
  kind: KeyOrderKind;
  quantity: number;
  note: string | null;
}): Promise<ApiResult<OwnKeyOrder>> {
  const { orderId, ...body } = input;
  return apiRequest(
    "PUT",
    `/api/key-orders/${encodeURIComponent(orderId)}`,
    body,
  );
}

export function withdrawKeyOrder(input: {
  orderId: string;
}): Promise<ApiResult<OwnKeyOrder>> {
  return apiRequest(
    "POST",
    `/api/key-orders/${encodeURIComponent(input.orderId)}/withdrawal`,
  );
}

// --- the queue the board works ----------------------------------------------

export function fetchKeyOrderQueue(): Promise<ApiResult<KeyOrderQueue>> {
  return apiRequest("GET", "/api/key-order-queue");
}

/**
 * Records the handover, or that the board declined the order.
 *
 * One call with a boolean rather than two, because it is one act with two
 * outcomes. There is a decline here where the motion queue has none, and that is
 * the difference between the two: nothing gives a resident a right to a key.
 */
export function answerKeyOrder(input: {
  orderId: string;
  handedOver: boolean;
  note: string | null;
}): Promise<ApiResult<QueuedKeyOrder>> {
  const { orderId, ...body } = input;
  return apiRequest(
    "POST",
    `/api/key-order-queue/${encodeURIComponent(orderId)}/answer`,
    body,
  );
}
