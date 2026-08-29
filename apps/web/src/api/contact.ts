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

export function fetchContactSubmissions(): Promise<
  ApiResult<ContactSubmission[]>
> {
  return apiRequest("GET", "/api/contact-submissions");
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
