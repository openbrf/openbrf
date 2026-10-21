import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vite-plus/test";

import {
  authenticatedFacts as factsOf,
  isAuthenticatedRequest as isMarked,
  markAuthenticated as putMark,
  releaseAuthenticated as dropMark,
} from "../actions/authenticated-request";
import { registerReleaseOfAuthenticatedRequest } from "./release-authenticated-request";

function server() {
  const app = Fastify();
  registerReleaseOfAuthenticatedRequest(app);
  const held: FastifyRequest[] = [];
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const mark = (request: FastifyRequest) => {
    putMark(request, {
      personId: "person-1",
      token: null,
      requestId: request.id,
    });
    // What a plugin's route that keeps the request would do.
    held.push(request);
  };
  app.get("/answers", (request) => {
    mark(request);
    return { marked: isMarked(request) };
  });
  app.get("/never-answers", (request) => {
    mark(request);
    reached();
    return new Promise(() => {});
  });
  // The body is read and parsed before the route runs, so the request has
  // ended long before the client leaves.
  app.post("/never-answers", (request) => {
    mark(request);
    reached();
    return new Promise(() => {});
  });

  /*
   * A guard that awaits the session before it marks, as the authorization
   * guard does. Nest runs its guards inside the route's handler, so this one
   * does too, and the mark is written only once `authenticate` is called.
   */
  let authenticate: () => void = () => {};
  const authenticating = new Promise<void>((resolve) => {
    authenticate = resolve;
  });
  // Wrapped, since a promise resolved with a promise waits for it.
  let waiting: (response: { gone: Promise<void> }) => void = () => {};
  const awaitingSession = new Promise<{ gone: Promise<void> }>((resolve) => {
    waiting = resolve;
  });
  app.get("/slow-session", async (request, reply) => {
    waiting({
      gone: new Promise<void>((resolve) => {
        reply.raw.once("close", () => resolve());
      }),
    });
    await authenticating;
    mark(request);
    reached();
    return new Promise(() => {});
  });
  return {
    app,
    held,
    arrived,
    authenticate,
    awaitingSession,
  };
}

async function listening(app: ReturnType<typeof server>["app"]) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as AddressInfo).port;
}

describe("a request's mark when its response ends", () => {
  it("is carried while the route serves the request", async () => {
    const { app } = server();

    const response = await app.inject({ url: "/answers" });

    expect(response.json()).toEqual({ marked: true });
  });

  it("is dropped once the response has been sent", async () => {
    const { app, held } = server();

    await app.inject({ url: "/answers" });

    const [kept] = held;
    expect(kept).toBeDefined();
    expect(isMarked(kept!)).toBe(false);
    expect(factsOf(kept!)).toBeUndefined();
  });

  it("is dropped when the client leaves before an answer", async () => {
    const { app, held, arrived } = server();
    try {
      const port = await listening(app);
      const outgoing = httpRequest({
        port,
        host: "127.0.0.1",
        path: "/never-answers",
      });
      outgoing.on("error", () => {});
      outgoing.end();
      await arrived;
      const [kept] = held;
      expect(kept).toBeDefined();
      expect(isMarked(kept!)).toBe(true);

      outgoing.destroy();

      await expect.poll(() => isMarked(kept!)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("is dropped when the client leaves after its body was read", async () => {
    const { app, held, arrived } = server();
    try {
      const port = await listening(app);
      const outgoing = httpRequest({
        port,
        host: "127.0.0.1",
        path: "/never-answers",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      outgoing.on("error", () => {});
      outgoing.end("{}");
      await arrived;
      const [kept] = held;
      expect(kept).toBeDefined();
      expect(isMarked(kept!)).toBe(true);

      outgoing.destroy();

      await expect.poll(() => isMarked(kept!)).toBe(false);
      expect(factsOf(kept!)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("is never written when the client leaves before the guard marks", async () => {
    const { app, held, arrived, authenticate, awaitingSession } = server();
    try {
      const port = await listening(app);
      const outgoing = httpRequest({
        port,
        host: "127.0.0.1",
        path: "/slow-session",
      });
      outgoing.on("error", () => {});
      outgoing.end();
      const { gone } = await awaitingSession;

      outgoing.destroy();
      await gone;
      authenticate();
      await arrived;

      const [kept] = held;
      expect(kept).toBeDefined();
      expect(isMarked(kept!)).toBe(false);
      expect(factsOf(kept!)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("a released request", () => {
  it("is not marked again", () => {
    const request = {};
    dropMark(request);

    putMark(request, { personId: "person-1", token: null, requestId: "r-1" });

    expect(isMarked(request)).toBe(false);
  });
});
