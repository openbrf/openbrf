import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";

/**
 * The bridge, driven through the controller rather than through the functions
 * it is built from.
 *
 * What matters is the Request that reaches the sign-in library, and the
 * translation is only correct as a whole: the content type is copied by one
 * function and the body encoded by another, and the failure these assertions
 * exist for is the two disagreeing. A test of either one alone would have
 * passed while a form arrived as JSON.
 */

interface Captured {
  controller: AuthController;
  taken: () => Request;
}

function controllerCapturing(response = new Response(null)): Captured {
  let seen: Request | undefined;
  const auth = {
    handler: (request: Request) => {
      seen = request;
      return Promise.resolve(response);
    },
  } as unknown as AuthService;

  return {
    controller: new AuthController(auth),
    taken: () => {
      if (seen === undefined) {
        throw new Error("the handler was never called");
      }
      return seen;
    },
  };
}

function fastifyRequest(
  overrides: Partial<FastifyRequest> & { headers?: Record<string, unknown> },
): FastifyRequest {
  return {
    method: "POST",
    url: "/api/auth/oauth2/token",
    protocol: "https",
    headers: { host: "brf.example" },
    body: undefined,
    ...overrides,
  } as unknown as FastifyRequest;
}

/** Enough of a reply to accept what the controller sends it. */
function reply(): FastifyReply {
  const raw = { setHeader: () => undefined };
  const self = {
    raw,
    header: () => self,
    status: () => self,
    send: () => Promise.resolve(),
  };
  return self as unknown as FastifyReply;
}

describe("AuthController body encoding", () => {
  it("re-encodes a parsed form as a form, not as JSON", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        headers: {
          host: "brf.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: {
          grant_type: "authorization_code",
          code: "abc123",
          redirect_uri: "https://client.example/cb",
        },
      }),
      reply(),
    );

    const body = await taken().text();
    expect(body).toBe(
      "grant_type=authorization_code&code=abc123&redirect_uri=https%3A%2F%2Fclient.example%2Fcb",
    );
    // The failure this guards against is not a rejection but a misreading: a
    // JSON document under a form content type parses to one parameter whose
    // name is the whole document.
    expect(body.startsWith("{")).toBe(false);
  });

  it("keeps a repeated parameter repeated", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        headers: {
          host: "brf.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        // A signed authorization query carries ba_param more than once, and
        // the signature is taken over the repetition.
        body: { ba_param: ["ba_iat", "resource"], sig: "s" },
      }),
      reply(),
    );

    const parsed = new URLSearchParams(await taken().text());
    expect(parsed.getAll("ba_param")).toEqual(["ba_iat", "resource"]);
  });

  it("honours the charset parameter on the content type", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        headers: {
          host: "brf.example",
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: { token: "t" },
      }),
      reply(),
    );

    expect(await taken().text()).toBe("token=t");
  });

  it("still encodes a JSON body as JSON", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        url: "/api/auth/sign-in/email",
        headers: { host: "brf.example", "content-type": "application/json" },
        body: { email: "ordforande@brf.example", password: "secret" },
      }),
      reply(),
    );

    expect(await taken().text()).toBe(
      '{"email":"ordforande@brf.example","password":"secret"}',
    );
  });

  it("sends no body on a GET", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        method: "GET",
        url: "/api/auth/get-session",
        body: undefined,
      }),
      reply(),
    );

    expect(taken().body).toBeNull();
  });

  it("rebuilds the URL from the incoming host", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        method: "GET",
        url: "/api/auth/get-session",
        headers: { host: "brf.example" },
      }),
      reply(),
    );

    expect(taken().url).toBe("https://brf.example/api/auth/get-session");
  });

  it("forwards the content type unchanged", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        headers: {
          host: "brf.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: { token: "t" },
      }),
      reply(),
    );

    expect(taken().headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("drops the headers that describe the bytes it received", async () => {
    const { controller, taken } = controllerCapturing();

    await controller.handle(
      fastifyRequest({
        headers: {
          host: "brf.example",
          "content-type": "application/x-www-form-urlencoded",
          // The body below re-encodes to a different length, so forwarding
          // these would describe bytes that no longer exist.
          "content-length": "9999",
          "content-encoding": "gzip",
        },
        body: { token: "t" },
      }),
      reply(),
    );

    const headers = taken().headers;
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).not.toBe("9999");
  });
});
