import { apiRequest, type ApiResult } from "./client";

/**
 * The board's inbox for the website's contact form.
 *
 * Read-only plus one flag. The form at the other end of this queue is on the
 * association's own website, is rendered by the server as plain HTML and is
 * submitted without this client being involved at all - which is why there is
 * no submit function here to match the sign-up module's.
 *
 * The wire type is mirrored rather than imported, like every other in this
 * client.
 */

export interface ContactSubmission {
  id: string;
  /** What the sender called themselves, when they gave a name. */
  name: string | null;
  /** Decrypted for the board, because answering it is the point of the form. */
  email: string;
  message: string;
  handled: boolean;
  /** ISO timestamp, or null while the message is still waiting. */
  handledAt: string | null;
  createdAt: string;
}

/** One page of the inbox, and what is behind it. */
export interface ContactInboxPage {
  submissions: ContactSubmission[];
  /** Every unhandled message, on this page or not. */
  unhandled: number;
  /** Every message the inbox holds. */
  total: number;
  /** Where the next page starts, or null when this is the last one. */
  nextCursor: string | null;
}

/** A page of the inbox: the first, or the one after the cursor. */
export function fetchContactSubmissions(
  cursor?: string,
): Promise<ApiResult<ContactInboxPage>> {
  return apiRequest(
    "GET",
    cursor === undefined
      ? "/api/contact-submissions"
      : `/api/contact-submissions?cursor=${encodeURIComponent(cursor)}`,
  );
}

/**
 * Removes a message for good.
 *
 * The one way these rows leave the instance, and the only bounded retention
 * they have: a message is a stranger's name, address and free text, and the
 * purge that erases a former resident's service data is keyed on a person the
 * association holds a record of - which most senders are not.
 */
export function deleteContactSubmission(
  id: string,
): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/contact-submissions/${encodeURIComponent(id)}`,
  );
}

/**
 * Removes several messages for good, and answers how many were there. The
 * server takes at most `MAX_CONTACT_SUBMISSIONS_PER_REMOVAL` at a time.
 */
export function deleteContactSubmissions(
  ids: readonly string[],
): Promise<ApiResult<{ removed: number }>> {
  return apiRequest("POST", "/api/contact-submissions/remove", { ids });
}

/**
 * Marks a message dealt with, or puts it back.
 *
 * Both directions, because a board member who ticks the wrong row has to be
 * able to untick it: the flag is the board's note to itself about its own
 * inbox, not a record of anything that happened.
 */
export function setContactSubmissionHandled(
  id: string,
  handled: boolean,
): Promise<ApiResult<ContactSubmission>> {
  return apiRequest(
    "PUT",
    `/api/contact-submissions/${encodeURIComponent(id)}/handled`,
    { handled },
  );
}
