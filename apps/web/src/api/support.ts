import type { SupportAccessHours } from "@openbrf/shared";

import { apiRequest, type ApiResult } from "./client";

/**
 * Support access the administrator opens (ADR 0028), as the browser sees it:
 * the settings panel that opens and closes it, and the page a supporter's
 * sign-in link lands on.
 */

/** Whether an access is open, and if not, why it stopped. */
export type SupportAccessState = "open" | "closed" | "ended" | "lapsed";

export interface SupportPersonView {
  personId: string;
  /** Null when the person is no longer in the register. */
  name: string | null;
}

export interface SupportSessionView {
  id: string;
  /** Who the host said it was sending. */
  supporter: string;
  issuedAt: string;
  /** Null while the link has not been used. */
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
}

export interface SupportAccessView {
  id: string;
  state: SupportAccessState;
  openedAt: string;
  openedBy: SupportPersonView;
  endsAt: string;
  closedAt: string | null;
  closedBy: SupportPersonView | null;
  sessions: SupportSessionView[];
}

export interface SupportAccessOverview {
  open: SupportAccessView | null;
  /** The latest accesses, newest first, the open one among them. */
  accesses: SupportAccessView[];
}

export function fetchSupportAccess(): Promise<
  ApiResult<SupportAccessOverview>
> {
  return apiRequest("GET", "/api/support-access");
}

export function openSupportAccess(input: {
  hours: SupportAccessHours;
  reason: string;
}): Promise<ApiResult<SupportAccessView>> {
  return apiRequest("POST", "/api/support-access", input);
}

export function closeSupportAccess(id: string): Promise<ApiResult<void>> {
  return apiRequest(
    "POST",
    `/api/support-access/${encodeURIComponent(id)}/close`,
  );
}

/** Uses a sign-in link's token, which starts the support session. */
export function startSupportSession(
  token: string,
): Promise<ApiResult<{ supporter: string; expiresAt: string }>> {
  return apiRequest("POST", "/api/support/session", { token });
}

/** Ends this browser's support session, and removes its cookie. */
export function endSupportSession(): Promise<ApiResult<void>> {
  return apiRequest("DELETE", "/api/support/session");
}
