/**
 * The API client.
 *
 * Every call comes back as a result rather than a thrown error, and a failure
 * carries a machine-readable `reason` rather than the server's prose. That is
 * the same rule the sign-in screen already follows: the API answers in English
 * while the interface is Swedish by default, and how much a failure explains is
 * a decision for the screen rather than for a translation.
 *
 * Requests are relative and same-origin. Sessions are http-only cookies, so
 * pointing this at an absolute API origin would make the browser treat every
 * call as cross-site and drop the cookie.
 */

export interface ApiFailure {
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  /**
   * The endpoint's own code for what went wrong, or one of the two the client
   * itself produces: "offline" and "unexpected".
   */
  reason: string;
  /** Extra detail some endpoints attach, e.g. the failing contrast pairs. */
  detail?: unknown;
}

export type ApiResult<T> =
  { ok: true; value: T } | { ok: false; failure: ApiFailure };

interface ErrorBody {
  reason?: unknown;
  findings?: unknown;
  issues?: unknown;
}

/**
 * Calls the API.
 *
 * A body is sent as JSON; pass undefined for a request without one. The caller
 * states the expected response type: these endpoints are ours and their shapes
 * are declared in api/instance.ts, so validating them again in the browser
 * would only duplicate the server's own contract.
 */
export async function apiRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;

  // The body and its header are added only when there is one. A GET carrying a
  // body key at all - even an undefined one - is invalid, and passing the
  // content type without content is a lie about the request.
  const init: RequestInit =
    body === undefined
      ? { method, credentials: "same-origin" }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          // Belt and braces: same-origin is already fetch's default, and the
          // session is an http-only cookie that has to travel with every call.
          credentials: "same-origin",
        };

  try {
    response = await fetch(path, init);
  } catch {
    // A network failure is not a server answer, and the distinction matters:
    // "try again" is the right advice here and the wrong advice for a 409.
    return { ok: false, failure: { status: 0, reason: "offline" } };
  }

  if (response.status === 204) {
    return { ok: true, value: undefined as T };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload ?? {}) as ErrorBody;
    return {
      ok: false,
      failure: {
        status: response.status,
        reason: typeof error.reason === "string" ? error.reason : "unexpected",
        detail: error.findings ?? error.issues,
      },
    };
  }

  return { ok: true, value: payload as T };
}
