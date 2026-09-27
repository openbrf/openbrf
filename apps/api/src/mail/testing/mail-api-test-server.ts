import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An HTTP mail API, in this process.
 *
 * The HTTP mail driver is tested against a real HTTP conversation rather than a
 * stub of its own method, for the reason the SMS gateway's driver is: what can
 * go wrong is the conversation. The method, the path, the bearer key, the
 * idempotency key, the content type and the shape of the JSON are the whole of
 * the contract the driver publishes, and a stubbed client would pass with every
 * one of them wrong.
 *
 * It holds the driver to the rules a service of this shape enforces rather than
 * accepting anything: a wrong or missing key is a 401, a body that is not JSON a
 * 415, and a header the service owns - Message-ID first among them - a 422. So a
 * driver that started sending one fails the round trip instead of quietly
 * passing. What it answers is the service's own id, which is the local part of
 * the Message-ID the service writes.
 *
 * It runs in-process so the suites need no infrastructure and cannot reach the
 * network.
 */

/** Headers a service of this shape owns and refuses from the caller. */
const OWNED_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "return-path",
  "sender",
  "received",
  "dkim-signature",
]);

/** One request as it arrived. */
export interface MailApiRequest {
  method: string;
  path: string;
  authorization: string;
  contentType: string;
  idempotencyKey: string;
  body: string;
}

/** One message the service accepted, and the id it answered with. */
export interface AcceptedMail {
  id: string;
  payload: {
    from: string;
    to: string[];
    subject: string;
    html?: string;
    text?: string;
    reply_to?: string[];
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface MailApiTestServer {
  /** The base address to configure; the driver posts to `<this>/emails`. */
  baseUrl: string;
  key: string;
  /** The host the base address names, as a screen or a record shows it. */
  host: string;
  /** Every message accepted, in order. */
  accepted: AcceptedMail[];
  /** Every request seen, accepted or not. */
  requests: MailApiRequest[];
  /** Answers the next request with this status and body instead. */
  answerNextWith: (
    status: number,
    body?: string,
    headers?: Record<string, string>,
  ) => void;
  /** Leaves the next request without an answer, for the driver's bound. */
  silenceNext: () => void;
  close: () => Promise<void>;
}

const KEY = "mail-api-key-for-the-local-server";

export async function startMailApiTestServer(): Promise<MailApiTestServer> {
  const accepted: AcceptedMail[] = [];
  const requests: MailApiRequest[] = [];
  let override: {
    status: number;
    body: string;
    headers: Record<string, string>;
  } | null = null;
  let silence = false;

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      // Answered here rather than left to reject, for the reason the SMS
      // gateway's test server gives: a runner attributes an unhandled
      // rejection to whichever test happens to be running.
      try {
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      } catch {
        response.destroy();
      }
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);
    const authorization = header(request, "authorization");
    requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "",
      authorization,
      contentType: header(request, "content-type"),
      idempotencyKey: header(request, "idempotency-key"),
      body,
    });

    if (silence) {
      silence = false;
      // No answer at all. The socket is destroyed when the server closes.
      return;
    }

    if (override !== null) {
      const { status, body: answer, headers } = override;
      override = null;
      response.writeHead(status, headers).end(answer);
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/emails") {
      response.writeHead(404).end();
      return;
    }
    if (authorization !== `Bearer ${KEY}`) {
      response.writeHead(401).end('{"name":"invalid_api_key"}');
      return;
    }
    if (
      !header(request, "content-type")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      response.writeHead(415).end();
      return;
    }

    let payload: AcceptedMail["payload"];
    try {
      payload = JSON.parse(body) as AcceptedMail["payload"];
    } catch {
      response.writeHead(400).end('{"name":"invalid_json"}');
      return;
    }

    const owned = Object.keys(payload.headers ?? {}).filter((name) =>
      OWNED_HEADERS.has(name.toLowerCase()),
    );
    if (
      owned.length > 0 ||
      typeof payload.from !== "string" ||
      !Array.isArray(payload.to) ||
      typeof payload.subject !== "string"
    ) {
      response
        .writeHead(422, { "content-type": "application/json" })
        .end('{"name":"validation_error"}');
      return;
    }

    const id = randomUUID();
    accepted.push({ id, payload });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ id }));
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const host = `127.0.0.1:${String(address.port)}`;

  return {
    baseUrl: `http://${host}/v1`,
    key: KEY,
    host,
    accepted,
    requests,
    answerNextWith: (status, body = "", headers = {}) => {
      override = { status, body, headers };
    },
    silenceNext: () => {
      silence = true;
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  // A request left unanswered on purpose still holds its socket.
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim();
}
