import { apiRequest, type ApiResult } from "./client";

/**
 * The board's queue of brokers' update requests.
 *
 * Read, and dismiss. The form that fills the queue is on the association's own
 * broker page, rendered by the server and posted without this client, and the
 * board answers a request by confirming or saving the facts on the website's
 * screen - which is why there is neither a submit nor an answer here.
 *
 * The wire types are mirrored rather than imported, like every other in this
 * client.
 */

export interface BrokerUpdateRequest {
  id: string;
  /** Decrypted for the board, because answering the broker is the point. */
  name: string | null;
  email: string;
  brokerage: string | null;
  /**
   * The apartment as the broker wrote it, in capitals, or null when they named
   * none. Never matched against the register, so it is the broker's text.
   */
  apartmentReference: string | null;
  note: string | null;
  createdAt: string;
  /** ISO timestamp of the confirmation that answered it, or null while open. */
  answeredAt: string | null;
}

export interface BrokerUpdateRequestQueue {
  /** Oldest first. */
  open: BrokerUpdateRequest[];
  /** Most recently answered first, for as long as they are kept. */
  answered: BrokerUpdateRequest[];
  /** Every open request, whether or not the list above holds them all. */
  openTotal: number;
}

export function fetchBrokerUpdateRequests(): Promise<
  ApiResult<BrokerUpdateRequestQueue>
> {
  return apiRequest("GET", "/api/broker-update-requests");
}

/** Dismisses a request, which deletes it for good. */
export function dismissBrokerUpdateRequest(
  id: string,
): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/broker-update-requests/${encodeURIComponent(id)}`,
  );
}
