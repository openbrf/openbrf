import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { hashOpaqueToken } from "../auth/opaque-token";
import type { Env } from "../config/env";
import type { SupportAccessService } from "../support/support-access.service";
import { SupportAccessClosedError } from "../support/support-errors";
import {
  MANAGEMENT_CALLS_PER_MINUTE,
  ManagementListener,
  SUPPORT_SESSION_BODY_LIMIT,
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
 * Two routes, and everything else a 404 before the token is looked at; a token
 * checked against the configured digests; a budget charged after that, shared
 * by both; a body read only once the token matched; and a server that goes
 * down with the application.
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
  const issueSignIn = vi.fn().mockResolvedValue(ISSUED);
  const env = {
    NODE_ENV: "test",
    PORT: 3000,
    OPENBRF_MANAGEMENT_PORT: 3001,
    OPENBRF_MANAGEMENT_TOKEN_DIGEST: digests,
  } as unknown as Env;
  const listener = new ManagementListener(
    { read } as unknown as ManagementSummaryService,
    { issueSignIn } as unknown as SupportAccessService,
    env,
  );
  return { listener, read, issueSignIn };
}

/** What the service answers for a link; the int-spec mints a real one. */
const ISSUED = {
  signInUrl: "https://brf.example/app/support#sign-in-token",
  expiresAt: new Date("2026-10-20T12:10:00.000Z"),
  accessEndsAt: new Date("2026-10-21T12:00:00.000Z"),
};

function askForLink(
  listener: ManagementListener,
  payload: string,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) {
  return listener.server.inject({
    method: "POST",
    url: "/v1/support-sessions",
    headers: { "content-type": "application/json", ...headers },
    payload,
  });
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
    ["GET on the sign-in links", "GET", "/v1/support-sessions"],
    ["PUT on the sign-in links", "PUT", "/v1/support-sessions"],
    ["DELETE on the sign-in links", "DELETE", "/v1/support-sessions"],
    ["one sign-in link by an id", "POST", "/v1/support-sessions/1"],
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

describe("asking for a support sign-in link", () => {
  it("answers 201 with the link, its end and the access's end, uncached", async () => {
    const { listener, issueSignIn } = build();
    track(listener);

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: "  Kim from the host  " }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      signInUrl: ISSUED.signInUrl,
      expiresAt: "2026-10-20T12:10:00.000Z",
      accessEndsAt: "2026-10-21T12:00:00.000Z",
    });
    // Trimmed, as the name is recorded.
    expect(issueSignIn).toHaveBeenCalledWith("Kim from the host");
  });

  it("answers 409 when no support access is open", async () => {
    const { listener, issueSignIn } = build();
    track(listener);
    issueSignIn.mockRejectedValueOnce(new SupportAccessClosedError());

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: "Kim" }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ reason: "support-access-closed" });
  });

  it("refuses a caller without the token before the body is read", async () => {
    const { listener, issueSignIn } = build();
    track(listener);
    const readBody = vi.spyOn(JSON, "parse");

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: "Kim" }),
      { authorization: "Bearer not-the-management-token" },
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ reason: "management-token-invalid" });
    expect(readBody).not.toHaveBeenCalledWith(
      expect.stringContaining("supporter"),
    );
    expect(issueSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", ""],
    ["a body that is not JSON", "supporter=Kim"],
    ["JSON that is not an object", JSON.stringify("Kim")],
    ["no supporter", JSON.stringify({ name: "Kim" })],
    ["a supporter that is not a string", JSON.stringify({ supporter: 7 })],
    ["a blank supporter", JSON.stringify({ supporter: "   " })],
    [
      "a supporter over 80 characters",
      JSON.stringify({ supporter: "K".repeat(81) }),
    ],
    ["a control character", JSON.stringify({ supporter: "Kim\nAdmin" })],
    [
      "a body over a kilobyte",
      JSON.stringify({
        supporter: "Kim",
        padding: "x".repeat(SUPPORT_SESSION_BODY_LIMIT),
      }),
    ],
  ] as const)("answers 400 for %s", async (_what, payload) => {
    const { listener, issueSignIn } = build();
    track(listener);

    const response = await askForLink(listener, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ reason: "invalid-body" });
    expect(issueSignIn).not.toHaveBeenCalled();
  });

  it("answers 400 over a real connection to a body over a kilobyte", async () => {
    // inject has no socket; a stream destroyed part way would take the real
    // one with it, and the caller would see a reset rather than the answer.
    const { listener, issueSignIn } = build();
    track(listener);
    await listener.start(0);
    const { port } = listener.server.server.address() as AddressInfo;

    for (const declared of [true, false]) {
      const answer = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/v1/support-sessions",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
                // Chunked when the length is not declared up front.
                ...(declared ? { "content-length": "200000" } : {}),
              },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk: Buffer) => {
                text += chunk.toString();
              });
              response.on("end", () => {
                resolve({ status: response.statusCode ?? 0, body: text });
              });
            },
          );
          request.on("error", reject);
          request.end("x".repeat(200_000));
        },
      );
      expect(answer.status, String(declared)).toBe(400);
      expect(JSON.parse(answer.body)).toEqual({ reason: "invalid-body" });
    }
    expect(issueSignIn).not.toHaveBeenCalled();
  });

  it("takes a name of exactly 80 characters, counted as characters", async () => {
    const { listener, issueSignIn } = build();
    track(listener);
    const name = "Å".repeat(80);

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: name }),
    );

    expect(response.statusCode).toBe(201);
    expect(issueSignIn).toHaveBeenCalledWith(name);
  });

  it("reads the body whatever content type it claims", async () => {
    const { listener } = build();
    track(listener);

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: "Kim" }),
      { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    );

    expect(response.statusCode).toBe(201);
  });

  it("spends the same budget as the summary", async () => {
    const { listener } = build();
    track(listener);
    const headers = { authorization: `Bearer ${TOKEN}` };

    for (let call = 1; call <= MANAGEMENT_CALLS_PER_MINUTE / 2; call += 1) {
      expect((await get(listener, "/v1/summary", headers)).statusCode).toBe(
        200,
      );
      expect(
        (await askForLink(listener, JSON.stringify({ supporter: "Kim" })))
          .statusCode,
      ).toBe(201);
    }
    const refused = await askForLink(
      listener,
      JSON.stringify({ supporter: "Kim" }),
    );

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ reason: "rate-limited" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("answers 500 and logs the class of a failure, never its message", async () => {
    const { listener, issueSignIn } = build();
    track(listener);
    issueSignIn.mockRejectedValueOnce(new TypeError("holds Astrid Lindqvist"));
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    const response = await askForLink(
      listener,
      JSON.stringify({ supporter: "Kim" }),
    );

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ reason: "support-session-unavailable" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Astrid");
    expect(String(logged.mock.calls[0]?.[0])).toContain("TypeError");
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
