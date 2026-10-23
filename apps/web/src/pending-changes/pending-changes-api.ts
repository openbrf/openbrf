import type { ActionErrorSpec, ActionEffect } from "@openbrf/plugin-sdk";
import type { AuditChannelName } from "@openbrf/shared";

import { apiRequest, type ApiResult } from "../api/client";

/**
 * A person's own pending changes, and confirming or rejecting one (ADR 0039).
 *
 * The shapes mirror the API's responses rather than restating its types, as
 * the other clients here do. Instants arrive as ISO strings and are formatted
 * by the screen in the association's zone.
 */

/** One pending change, as the person who proposed it reads it. */
export interface PendingChange {
  id: string;
  /**
   * The held action in the reader's language, or null when nothing on the
   * instance answers to its name any more and the change can only be rejected.
   */
  action: {
    title: string;
    description: string;
    effect: ActionEffect;
    needsConfirmation: boolean;
    /** The sentence for each refusal the action can raise when confirmed. */
    errors: ActionErrorSpec[];
  } | null;
  actionName: string;
  /** Exactly what will be sent when it is confirmed. */
  input: unknown;
  /**
   * What the change is to, read as the list was: the news item or page its
   * input names by id, as it stands now and as confirming would leave it. Null
   * for an action that names no such thing.
   */
  target: PendingChangeTarget | null;
  channel: AuditChannelName;
  clientHost: string | null;
  proposedAt: string;
  expiresAt: string;
}

/**
 * One fact about a target: what it is now, and what confirming sets it to. No
 * `after` for a fact the change leaves alone.
 */
export interface PendingChangeTargetFact {
  fact: string;
  now: string | boolean;
  after?: string | boolean;
}

/**
 * The thing a pending change is to. `missing` when nothing answers to its id
 * any more, and `withheld` when the person no longer holds what the action
 * needs and is not shown what stands there; `facts` is empty for both.
 */
export interface PendingChangeTarget {
  kind: "news" | "page";
  id: string;
  state: "found" | "missing" | "withheld";
  facts: PendingChangeTargetFact[];
}

export function fetchMyPendingChanges(): Promise<
  ApiResult<{ pendingChanges: PendingChange[] }>
> {
  return apiRequest("GET", "/api/pending-changes/mine");
}

/**
 * Carries a pending change out, as the person confirming it.
 *
 * A refusal here is either the queue's own (`pending-change-not-found`) or the
 * held action's, with the action's own reason; the change keeps waiting after
 * the second. `pending-change-failed-after-dispatch` is a failure after the
 * change was handed to its action: it may have been carried out, and it is no
 * longer waiting.
 */
export function confirmPendingChange(
  id: string,
): Promise<ApiResult<{ confirmed: true }>> {
  return apiRequest(
    "POST",
    `/api/pending-changes/mine/${encodeURIComponent(id)}/confirm`,
  );
}

export function rejectPendingChange(
  id: string,
): Promise<ApiResult<{ rejected: true }>> {
  return apiRequest(
    "POST",
    `/api/pending-changes/mine/${encodeURIComponent(id)}/reject`,
  );
}
