import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Translating between Fastify and the Web Fetch pair the sign-in library
 * speaks.
 *
 * Its own module because two controllers need the same translation and they
 * must not differ: the OAuth discovery routes have to sit at the root of the
 * origin rather than under the sign-in base path, so they are a separate
 * controller answering from the same library instance. A second, slightly
 * different copy of this translation is how one of them would start accepting
 * a body the other rejects.
 *
 * Four details matter and are easy to get wrong:
 *
 *   The request URL is rebuilt from the incoming host rather than from a
 *   configured base, so the library sees the origin the browser actually used.
 *
 *   Fastify has already parsed the body by the time we get here, so it is
 *   re-serialized. Passing the parsed object would give the library nothing to
 *   read.
 *
 *   It is re-serialized in the encoding it arrived in, because the incoming
 *   content type is forwarded unchanged. A form-encoded body turned into JSON
 *   under a form content type is not rejected, it is misread, and the OAuth
 *   endpoints are form-encoded by RFC 6749.
 *
 *   Set-Cookie must be copied with getSetCookie(), which preserves multiple
 *   cookies. Iterating headers normally collapses them into one comma-joined
 *   value, and a browser then silently drops the session.
 */

/** Headers that describe the incoming transfer and never survive re-encoding. */
const TRANSPORT_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

/**
 * The incoming headers, as a Headers object.
 *
 * Exported because a request forwarded to a different endpoint of the same
 * library still has to carry the browser's own cookie and Origin: the library
 * refuses a state-changing request that presents a cookie and no Origin, which
 * a browser always sends and a hand-built request easily forgets.
 */
export function forwardHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
      // These describe the bytes Fastify received, not the bytes below:
      // serializeBody re-encodes an already-parsed body, so the original
      // length and encoding no longer hold and would misdescribe the request.
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

/** The origin this request arrived on, to build a URL against. */
export function originOf(request: FastifyRequest): string {
  const host = request.headers.host ?? "localhost";
  return `${request.protocol}://${host}`;
}

export function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, originOf(request));
  const headers = forwardHeaders(request);

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? serializeBody(request.body as unknown, request.headers["content-type"])
    : undefined;

  return new Request(url, {
    method,
    headers,
    body,
  });
}

/**
 * Re-encodes a body Fastify has already parsed, in the encoding it arrived in.
 *
 * The content type is forwarded unchanged above, so the encoding here has to
 * match it. Fastify parses `application/x-www-form-urlencoded` into an object,
 * and stringifying that as JSON would produce a JSON document labelled as a
 * form: not a 415 but a silently wrong body, which is the harder failure to
 * find. The OAuth token, revoke and introspect endpoints are form-encoded by
 * RFC 6749, so this is the ordinary path for them rather than an edge case.
 *
 * A Fastify content-type parser would be the other way to do it, but it is
 * registered globally and would change how every other route in the
 * application reads its body. This branch reaches only what passes through
 * this controller.
 */
function serializeBody(
  body: unknown,
  contentType: string | undefined,
): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  if (contentType?.startsWith("application/x-www-form-urlencoded") === true) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>,
    )) {
      // A repeated parameter parses to an array and has to stay repeated:
      // `ba_param` arrives more than once in a signed authorization query, and
      // collapsing it would break the signature over it.
      if (Array.isArray(value)) {
        for (const item of value) {
          appendScalar(params, key, item);
        }
      } else {
        appendScalar(params, key, value);
      }
    }
    return params.toString();
  }
  return JSON.stringify(body);
}

/**
 * Appends one form value, and drops anything that is not one.
 *
 * A form body parses to strings and arrays of strings, so the skipped case
 * does not arise from the parser this bridge sits behind. It is written out
 * because the alternative to skipping is coercing, and coercing an object
 * yields the literal text "[object Object]" - a parameter the library would
 * then read as though the client had sent it. Dropping a value the endpoint
 * requires fails as a missing parameter, which says what happened.
 */
function appendScalar(
  params: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    params.append(key, value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    params.append(key, String(value));
  }
}

export async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<void> {
  const setCookies = response.headers.getSetCookie();

  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      return;
    }
    void reply.header(name, value);
  });

  if (setCookies.length > 0) {
    // Set through the raw response so each cookie stays its own header.
    reply.raw.setHeader("set-cookie", setCookies);
  }

  void reply.status(response.status);
  const text = await response.text();
  await reply.send(text === "" ? null : text);
}
