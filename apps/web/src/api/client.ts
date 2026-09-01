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
  locations?: unknown;
  /**
   * The limit a quota refusal reached, by field name.
   *
   * Named here because a refusal that publishes it is not actionable without
   * it: a weekly allowance that has been spent is waited out, and a cap on how
   * much of the future one household may hold at once is fixed by cancelling
   * something. Which fields a refusal may publish is the endpoint's decision;
   * this list is the client agreeing to carry them.
   */
  quota?: unknown;
  /**
   * The calendar dates a refusal is about, as "YYYY-MM-DD".
   *
   * The association's own calendar rather than anybody's data. The event module
   * refuses a change that would move or remove dates people have signed up to,
   * and it names those dates because the board's next act is to go and deal with
   * them one date at a time. Which of them somebody signed up to is not said,
   * and who did is never said.
   *
   * The filter that serialises a refusal leaves out any field it has nothing for,
   * so a refusal carrying dates carries no `locations` key at all and the
   * coalescing below reaches this one.
   */
  dates?: unknown;
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
  // The body and its header are added only when there is one. A GET carrying a
  // body key at all - even an undefined one - is invalid, and passing the
  // content type without content is a lie about the request.
  return send<T>(
    path,
    body === undefined
      ? { method, credentials: "same-origin" }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          // Belt and braces: same-origin is already fetch's default, and the
          // session is an http-only cookie that has to travel with every call.
          credentials: "same-origin",
        },
  );
}

/**
 * Sends one file, with the fields that describe it.
 *
 * A multipart body rather than JSON, so the bytes travel as bytes: encoding a
 * file into JSON would inflate it by a third and force the server to hold the
 * whole thing before it could tell how big it was. The content type is left to
 * the browser, which has to append the multipart boundary it generated.
 *
 * The fields go first and the file last. A multipart body is parsed in order
 * and the server stops at the file, so a field written after it is one the
 * handler is not guaranteed to have seen by the time it reads them.
 */
export async function apiUpload<T>(
  method: "POST" | "PUT",
  path: string,
  file: File,
  fields: Readonly<Record<string, string>> = {},
): Promise<ApiResult<T>> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  form.append("file", file);

  return send<T>(path, { method, body: form, credentials: "same-origin" });
}

async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;

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
        detail:
          error.findings ??
          error.issues ??
          error.locations ??
          error.quota ??
          error.dates,
      },
    };
  }

  return { ok: true, value: payload as T };
}
