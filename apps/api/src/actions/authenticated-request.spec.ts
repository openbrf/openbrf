import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vite-plus/test";

import {
  isAnsweredRequest,
  isAuthenticatedRequest,
  markAuthenticated,
} from "./authenticated-request";

/**
 * How long the mark lasts, against a real response rather than a stand-in.
 *
 * The guard hands the mark the Node response under Fastify's reply. What these
 * tests settle is that the events the mark ends on are the ones that response
 * emits: a mark that outlived the response would leave a kept request speaking
 * for its person, and one that ended early would refuse a route its own
 * dispatch.
 */
describe("the mark on a request", () => {
  it("holds while the route is serving it", async () => {
    const app = Fastify();
    let during: boolean | undefined;
    app.get("/", (request, reply) => {
      markAuthenticated(request, reply.raw);
      during = isAuthenticatedRequest(request);
      return { ok: true };
    });

    await app.inject({ url: "/" });

    expect(during).toBe(true);
  });

  it("ends once the response is sent", async () => {
    const app = Fastify();
    let kept: FastifyRequest | undefined;
    app.get("/", (request, reply) => {
      markAuthenticated(request, reply.raw);
      kept = request;
      return { ok: true };
    });

    await app.inject({ url: "/" });

    expect(kept).toBeDefined();
    expect(isAuthenticatedRequest(kept as object)).toBe(false);
    expect(isAnsweredRequest(kept as object)).toBe(true);
  });

  it("was never answered for an object core did not mark", () => {
    // Which refusal a kept request gets is read from this, so a forgery must
    // not read as a request that was once real.
    expect(isAnsweredRequest({})).toBe(false);
  });
});
