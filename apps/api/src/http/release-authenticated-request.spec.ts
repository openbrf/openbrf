import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vite-plus/test";

import {
  authenticatedFacts,
  isAuthenticatedRequest,
  markAuthenticated,
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
    markAuthenticated(request, {
      personId: "person-1",
      token: null,
      requestId: request.id,
    });
    // What a plugin's route that keeps the request would do.
    held.push(request);
  };
  app.get("/answers", (request) => {
    mark(request);
    return { marked: isAuthenticatedRequest(request) };
  });
  app.get("/never-answers", (request) => {
    mark(request);
    reached();
    return new Promise(() => {});
  });
  return { app, held, arrived };
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
    expect(isAuthenticatedRequest(kept!)).toBe(false);
    expect(authenticatedFacts(kept!)).toBeUndefined();
  });

  it("is dropped when the client leaves before an answer", async () => {
    const { app, held, arrived } = server();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as AddressInfo;
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
      expect(isAuthenticatedRequest(kept!)).toBe(true);

      outgoing.destroy();

      await expect.poll(() => isAuthenticatedRequest(kept!)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
