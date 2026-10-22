import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  pinnedRequester,
  type PinnedRequest,
  ResponseTooLargeError,
} from "./pinned-request";

/**
 * One request to addresses already judged.
 *
 * Over plain HTTP on the loopback address, passed in where `node:https`
 * would be: a suite cannot hold a certificate a public authority signed,
 * and what is under test - the pin, the size cap, the redirect handed back -
 * is the same on both.
 */

describe("pinnedRequester", () => {
  let server: Server;
  let port: number;
  let seen: { host: string | undefined; body: string; method: string }[];

  beforeEach(async () => {
    seen = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          host: request.headers.host,
          body: Buffer.concat(chunks).toString(),
          method: request.method ?? "",
        });
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "https://elsewhere.example/" });
          response.end();
          return;
        }
        if (request.url === "/large") {
          response.end("x".repeat(2048));
          return;
        }
        response.setHeader("set-cookie", ["a=1", "b=2"]);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("answer");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  /** A name nothing resolves, pinned to the loopback server. */
  function pinned(path: string, overrides: Partial<PinnedRequest> = {}) {
    return {
      url: new URL(`http://recipient.invalid:${String(port)}${path}`),
      method: "GET",
      headers: {},
      body: null,
      addresses: [{ address: "127.0.0.1", family: 4 as const }],
      signal: new AbortController().signal,
      maxResponseBytes: 1024,
      ...overrides,
    } satisfies PinnedRequest;
  }

  const send = pinnedRequester(
    httpRequest as unknown as Parameters<typeof pinnedRequester>[0],
  );

  it("connects to the address judged, under the name it was asked for", async () => {
    const response = await send(
      pinned("/", { method: "POST", body: Buffer.from("payload") }),
    );

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("answer");
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.headers["set-cookie"]).toBe("a=1, b=2");
    expect(seen).toEqual([
      {
        host: `recipient.invalid:${String(port)}`,
        body: "payload",
        method: "POST",
      },
    ]);
  });

  it("hands a redirect back rather than following it", async () => {
    const response = await send(pinned("/redirect"));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://elsewhere.example/");
    expect(seen).toHaveLength(1);
  });

  it("refuses an answer longer than the caller reads", async () => {
    await expect(send(pinned("/large"))).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      send(pinned("/", { signal: controller.signal })),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});
