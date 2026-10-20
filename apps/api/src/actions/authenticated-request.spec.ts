import type { ServerResponse } from "node:http";

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

interface Serving {
  request: FastifyRequest;
  response: ServerResponse;
  /** Lets the route return, which sends the response. */
  answer: () => void;
  /** Settles once the response is sent. */
  sent: Promise<unknown>;
}

/**
 * A route held open until the test lets it answer.
 *
 * The route only hands out what it was given; the test marks the request, as
 * the guard would, while the route is still serving it.
 */
async function serving(): Promise<Serving> {
  const app = Fastify();
  let answer = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const arrived = new Promise<{
    request: FastifyRequest;
    response: ServerResponse;
  }>((arrive) => {
    app.get("/", async (request, reply) => {
      arrive({ request, response: reply.raw });
      await held;
      return { ok: true };
    });
  });

  const sent = app.inject({ url: "/" });
  const { request, response } = await arrived;
  return { request, response, answer, sent };
}

describe("the mark on a request", () => {
  it("holds while the route is serving it, and ends once the response is sent", async () => {
    const { request, response, answer, sent } = await serving();
    markAuthenticated(request, response);

    expect(isAuthenticatedRequest(request)).toBe(true);
    expect(isAnsweredRequest(request)).toBe(false);

    answer();
    await sent;

    expect(isAuthenticatedRequest(request)).toBe(false);
    expect(isAnsweredRequest(request)).toBe(true);
  });

  it("was never answered for an object core did not mark", () => {
    // Which refusal a kept request gets is read from this, so a forgery must
    // not read as a request that was once real.
    expect(isAnsweredRequest({})).toBe(false);
  });
});
