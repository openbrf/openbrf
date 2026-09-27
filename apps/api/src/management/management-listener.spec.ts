import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashOpaqueToken } from "../auth/opaque-token";
import type { Env } from "../config/env";
import {
  MANAGEMENT_CALLS_PER_MINUTE,
  ManagementListener,
} from "./management-listener";
import type { ManagementSummary } from "./management-summary";
import type { ManagementSummaryService } from "./management-summary.service";
import * as managementToken from "./management-token";

vi.mock("./management-token", async (importOriginal) => {
  const original = await importOriginal<typeof import("./management-token")>();
  return {
    ...original,
    presentedManagementToken: vi.fn(original.presentedManagementToken),
    matchingManagementDigest: vi.fn(original.matchingManagementDigest),
  };
});

/**
 * The management API's listener (ADR 0021), through Fastify's inject.
 *
 * One route, and everything else a 404 before the token is looked at; a token
 * checked against the configured digests; a budget charged after that; and a
 * server that goes down with the application.
 */

const TOKEN = "management-token-for-the-listener-spec-00001";
const ROTATED = "management-token-being-rotated-away-00000002";

/** Enough of a document to see it arrive; the int-spec reads the real one. */
const SUMMARY = { schema: 1, version: "0.0.0" } as ManagementSummary;

function build(
  digests: readonly string[] | undefined = [
    hashOpaqueToken(TOKEN),
    hashOpaqueToken(ROTATED),
  ],
) {
  const read = vi.fn().mockResolvedValue(SUMMARY);
  const env = {
    NODE_ENV: "test",
    PORT: 3000,
    OPENBRF_MANAGEMENT_PORT: 3001,
    OPENBRF_MANAGEMENT_TOKEN_DIGEST: digests,
  } as unknown as Env;
  const listener = new ManagementListener(
    { read } as unknown as ManagementSummaryService,
    env,
  );
  return { listener, read };
}

function get(
  listener: ManagementListener,
  url: string,
  headers: Record<string, string> = {},
) {
  return listener.server.inject({ method: "GET", url, headers });
}

let listeners: ManagementListener[] = [];

function track(listener: ManagementListener): ManagementListener {
  listeners.push(listener);
  return listener;
}

beforeEach(() => {
  vi.mocked(managementToken.presentedManagementToken).mockClear();
  vi.mocked(managementToken.matchingManagementDigest).mockClear();
});

afterEach(async () => {
  for (const listener of listeners) {
    await listener.onApplicationShutdown();
  }
  listeners = [];
  vi.restoreAllMocks();
});

describe("what the listener answers", () => {
  it("serves the summary to the configured token, uncached", async () => {
    const { listener, read } = build();
    track(listener);

    const response = await get(listener, "/v1/summary", {
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(SUMMARY);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("serves it to the token being rotated away from as well", async () => {
    const { listener } = build();
    track(listener);

    const response = await get(listener, "/v1/summary", {
      authorization: `Bearer ${ROTATED}`,
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["the root", "GET", "/"],
    ["the public address's path", "GET", "/api/management/v1/summary"],
    ["a version that does not exist", "GET", "/v2/summary"],
    ["a trailing slash", "GET", "/v1/summary/"],
    ["the health endpoint", "GET", "/health"],
    ["POST on the summary", "POST", "/v1/summary"],
    ["PUT on the summary", "PUT", "/v1/summary"],
    ["DELETE on the summary", "DELETE", "/v1/summary"],
    ["HEAD on the summary", "HEAD", "/v1/summary"],
    ["OPTIONS on the summary", "OPTIONS", "/v1/summary"],
    ["a path that cannot be decoded", "GET", "/v1/summary%zz"],
  ] as const)(
    "answers 404 for %s, before the token is looked at",
    async (_what, method, url) => {
      const { listener, read } = build();
      track(listener);

      const response = await listener.server.inject({
        method,
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
      if (method !== "HEAD") {
        expect(response.json()).toEqual({ reason: "not-found" });
      }
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(managementToken.presentedManagementToken).not.toHaveBeenCalled();
      expect(managementToken.matchingManagementDigest).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("answers 404 to a body it was sent, without reading it", async () => {
    const { listener } = build();
    track(listener);

    for (const [contentType, payload] of [
      ["application/json", JSON.stringify({ schema: 2 })],
      ["application/x-www-form-urlencoded", "schema=2"],
      ["application/octet-stream", "\u0000\u0001"],
    ] as const) {
      const response = await listener.server.inject({
        method: "POST",
        url: "/v1/summary",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": contentType,
        },
        payload,
      });
      expect(response.statusCode, contentType).toBe(404);
    }
  });
});

describe("the token", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: "Bearer not-the-management-token" }],
    ["another scheme", { authorization: `Basic ${TOKEN}` }],
    [
      "a lower-case scheme with a wrong credential",
      { authorization: "bearer not-the-management-token" },
    ],
    [
      "the digest instead of the token",
      { authorization: `Bearer ${hashOpaqueToken(TOKEN)}` },
    ],
  ] as const)("refuses %s with 401", async (_what, headers) => {
    const { listener, read } = build();
    track(listener);

    const response = await get(listener, "/v1/summary", headers);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ reason: "management-token-invalid" });
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses every token when no digest is configured", async () => {
    const { listener, read } = build([]);
    track(listener);

    const response = await get(listener, "/v1/summary", {
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses two Authorization headers on the wire", async () => {
    // Node keeps only the first of two in its parsed headers, and inject
    // cannot send two; a real connection shows the listener reads both.
    const { listener, read } = build();
    track(listener);
    await listener.start(0);
    const { port } = listener.server.server.address() as AddressInfo;

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/v1/summary",
          // Raw headers are sent as given, so the Host is named here too.
          headers: [
            "Host",
            `127.0.0.1:${String(port)}`,
            "Authorization",
            `Bearer ${TOKEN}`,
            "Authorization",
            "Bearer anything-at-all",
          ],
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the budget", () => {
  it("answers the eleventh call in a minute with 429 and Retry-After", async () => {
    const { listener, read } = build();
    track(listener);
    const headers = { authorization: `Bearer ${TOKEN}` };

    for (let call = 1; call <= MANAGEMENT_CALLS_PER_MINUTE; call += 1) {
      expect((await get(listener, "/v1/summary", headers)).statusCode).toBe(
        200,
      );
    }
    const refused = await get(listener, "/v1/summary", headers);

    expect(MANAGEMENT_CALLS_PER_MINUTE).toBe(10);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ reason: "rate-limited" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(read).toHaveBeenCalledTimes(MANAGEMENT_CALLS_PER_MINUTE);
  });

  it("is not spent by refused tokens", async () => {
    // Charged after the token matched and keyed on which digest it matched,
    // so a caller without the token opens no counter and spends nobody's.
    const { listener } = build();
    track(listener);

    for (let call = 0; call < 3 * MANAGEMENT_CALLS_PER_MINUTE; call += 1) {
      await get(listener, "/v1/summary", {
        authorization: `Bearer wrong-${String(call)}`,
      });
    }
    const response = await get(listener, "/v1/summary", {
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("a failure", () => {
  it("answers 500 and logs the class of the failure, never its message", async () => {
    const { listener, read } = build();
    track(listener);
    read.mockRejectedValueOnce(new TypeError("holds Astrid Lindqvist"));
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const response = await get(listener, "/v1/summary", {
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ reason: "summary-unavailable" });
    expect(response.body).not.toContain("Astrid");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Astrid");
    expect(String(logged.mock.calls[0]?.[0])).toContain("TypeError");
  });
});

describe("shutting down", () => {
  it("closes the server with the application", async () => {
    const { listener } = build();
    await listener.start(0);
    expect(listener.server.server.listening).toBe(true);

    await listener.onApplicationShutdown();

    expect(listener.server.server.listening).toBe(false);
  });
});
