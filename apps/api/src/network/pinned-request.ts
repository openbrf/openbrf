import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import { pinnedLookup, type ResolvedAddress } from "./outbound-address";

/**
 * One HTTPS request to addresses already judged, answered in full.
 *
 * The connection half of the outbound address rules for something that needs
 * the answer as well as the status: the request is opened to one of
 * `addresses` whatever the name resolves to by then (see
 * {@link pinnedLookup}), on a connection of its own rather than one from the
 * shared pool, and a redirect is handed back rather than followed. Whether to
 * follow one, and where to, is the caller's decision, because the caller knows
 * which origins it may reach.
 */

export interface PinnedRequest {
  url: URL;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer | null;
  /** Answers {@link resolvePublicAddresses} gave for the URL's host. */
  addresses: readonly ResolvedAddress[];
  signal: AbortSignal;
  /** The most of the answer's body read before it is refused. */
  maxResponseBytes: number;
}

export interface PinnedResponse {
  status: number;
  /** Lowercased names; a repeated header is joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
}

export type PinnedRequester = (
  request: PinnedRequest,
) => Promise<PinnedResponse>;

/** The answer's body was longer than the caller would read. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super("the response is longer than the host reads");
    this.name = "ResponseTooLargeError";
  }
}

/**
 * The requester, over `node:https` or a stand-in with its shape.
 *
 * The stand-in is for a suite: it cannot hold a certificate a public authority
 * signed, so it serves plain HTTP on the loopback address and passes
 * `node:http`'s `request` here. Nothing else does.
 */
export function pinnedRequester(
  send: typeof httpsRequest = httpsRequest,
): PinnedRequester {
  return (pinned) =>
    new Promise<PinnedResponse>((resolve, reject) => {
      const request = send(
        pinned.url,
        {
          method: pinned.method,
          headers: {
            ...pinned.headers,
            ...(pinned.body === null
              ? {}
              : { "content-length": pinned.body.byteLength }),
          },
          agent: false,
          lookup: pinnedLookup(pinned.addresses),
          signal: pinned.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > pinned.maxResponseBytes) {
              response.destroy(new ResponseTooLargeError());
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: flatHeaders(response.headers),
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on("error", reject);
      request.end(pinned.body ?? undefined);
    });
}

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}
