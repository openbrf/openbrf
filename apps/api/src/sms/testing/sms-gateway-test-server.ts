import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An SMS gateway, in this process.
 *
 * The HTTP driver is tested against a real HTTP conversation rather than a stub
 * of its own method, for the reason the S3 driver is: what can go wrong is the
 * conversation. The method, the content type, the shape of the body and the
 * bearer header are the whole of the contract this driver publishes, and a
 * stubbed client would pass with every one of them wrong.
 *
 * It runs in-process so the suite needs no infrastructure and cannot reach the
 * network, and it answers 401 to a wrong or missing credential exactly as a
 * real gateway would, so a driver that failed to present one fails the round
 * trip instead of quietly passing.
 */
export interface SmsGatewayTestServer {
  /** Where the driver should be pointed. */
  endpoint: string;
  token: string;
  /** Every message the gateway accepted, in order. */
  accepted: { to: string; message: string; from?: string }[];
  /** Every request it saw, accepted or not. */
  requests: {
    method: string;
    contentType: string;
    authorization: string;
    body: string;
  }[];
  /** Answers the next request with this status instead of accepting it. */
  refuseNextWith: (status: number, body?: string) => void;
  close: () => Promise<void>;
}

const TOKEN = "gateway-token-for-the-local-server";

export async function startSmsGatewayTestServer(): Promise<SmsGatewayTestServer> {
  const accepted: SmsGatewayTestServer["accepted"] = [];
  const requests: SmsGatewayTestServer["requests"] = [];
  let refusal: { status: number; body: string } | null = null;

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      /*
       * Answered here rather than left to reject. A socket that goes away while
       * the body is read would otherwise surface as an unhandled rejection, and
       * the runner attributes one of those to whichever test happens to be
       * running rather than to the request that caused it.
       */
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
      contentType: header(request, "content-type"),
      authorization,
      body,
    });

    if (refusal !== null) {
      const { status, body: refusedBody } = refusal;
      refusal = null;
      response.writeHead(status).end(refusedBody);
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    if (authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end("unauthorized");
      return;
    }

    /*
     * The fourth half of the contract this server exists to hold a driver to.
     * Without it a driver could post the right body as text/plain and still
     * pass, which is exactly the kind of agreement a real gateway would refuse
     * and this suite is supposed to catch first.
     */
    const contentType = String(request.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().startsWith("application/json")) {
      response.writeHead(415).end("application/json is required");
      return;
    }

    const parsed = JSON.parse(body) as {
      to?: unknown;
      message?: unknown;
      from?: unknown;
    };
    if (typeof parsed.to !== "string" || typeof parsed.message !== "string") {
      response.writeHead(400).end("to and message are required");
      return;
    }

    accepted.push({
      to: parsed.to,
      message: parsed.message,
      ...(typeof parsed.from === "string" ? { from: parsed.from } : {}),
    });
    response.writeHead(202, { "content-type": "application/json" }).end("{}");
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/send`,
    token: TOKEN,
    accepted,
    requests,
    refuseNextWith: (status, body = "refused") => {
      refusal = { status, body };
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
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
