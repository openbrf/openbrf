import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { TokenRateLimiter } from "../auth/token-rate-limit";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { failureFrames, failureName } from "../logging/failure";
import { ManagementSummaryService } from "./management-summary.service";
import {
  matchingManagementDigest,
  presentedManagementToken,
} from "./management-token";

/** Summaries one token may read in a minute. */
export const MANAGEMENT_CALLS_PER_MINUTE = 10;

/** How long one request may take before the listener gives up on it. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The management API's listener (ADR 0021): a server of its own, on a port of
 * its own, answering one route.
 *
 * Not a route of the application. The public address has no management path
 * at all - `/api/management/...` there is the JSON 404 every unknown API path
 * gets - and this port is reachable only where the host's network puts it, so
 * a leaked token is worth nothing from the internet. The main listener's guard
 * never reads the management digests, the discovery documents do not mention
 * this listener, and nothing here is an OAuth resource or an action: the
 * caller is a machine credential and never a person, and every action is
 * taken by a person.
 *
 * `GET /v1/summary` is the whole surface. Any other path, and any other
 * method on this one, is 404 before the token is looked at. The request body
 * is never parsed: nothing here takes one. The token is checked against the
 * configured digests, then charged against a budget of ten a minute keyed on
 * which digest matched, then the summary is read, in that order - a budget
 * keyed on the presented value would let anybody open counters. Counted per
 * process, as every budget in this application is (ADR 0009).
 *
 * Off unless OPENBRF_MANAGEMENT_PORT and OPENBRF_MANAGEMENT_TOKEN_DIGEST are
 * both set: main.ts calls {@link start} after the application listens, and
 * only then. Closed on shutdown with the application, so the drain that
 * precedes a plugin install's restart and a container's SIGTERM take it down
 * too.
 */
@Injectable()
export class ManagementListener implements OnApplicationShutdown {
  private readonly logger = new Logger(ManagementListener.name);
  private readonly budget = new TokenRateLimiter(MANAGEMENT_CALLS_PER_MINUTE);

  /** The server. Built with the provider; bound to a port only by start(). */
  readonly server: FastifyInstance;

  constructor(
    private readonly summaries: ManagementSummaryService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.server = this.build();
  }

  /** Binds the listener on every interface of the container, at `port`. */
  async start(port: number): Promise<void> {
    await this.server.listen({ host: "0.0.0.0", port });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server.close();
  }

  private build(): FastifyInstance {
    const server = Fastify({
      logger: false,
      requestTimeout: REQUEST_TIMEOUT_MS,
      // HEAD is another method, and every other method is 404.
      exposeHeadRoutes: false,
      // A path that cannot even be decoded is a path that is not the route,
      // and answered as one rather than with the framework's own error.
      frameworkErrors: (_error, _request, reply) => {
        void refuse(reply, 404, "not-found");
      },
    });

    // No body is taken anywhere, so there is nothing to parse one with: every
    // request is answered on its method and path alone.
    server.removeAllContentTypeParsers();

    server.setNotFoundHandler(async (_request, reply) =>
      refuse(reply, 404, "not-found"),
    );

    server.setErrorHandler(async (error, _request, reply) => {
      // The class and the frames, never the message: a database error names
      // the values it was handling (logging/failure.ts).
      this.logger.error(
        `The management summary could not be read: ${failureName(error)}`,
        failureFrames(error),
      );
      return refuse(reply, 500, "summary-unavailable");
    });

    server.get("/v1/summary", async (request, reply) => {
      const token = presentedManagementToken(request.raw.rawHeaders);
      const matched =
        token === null
          ? null
          : matchingManagementDigest(
              token,
              this.env.OPENBRF_MANAGEMENT_TOKEN_DIGEST ?? [],
            );
      if (matched === null) {
        // Which of missing, malformed, doubled or wrong it was is not said.
        void reply.header("www-authenticate", "Bearer");
        return refuse(reply, 401, "management-token-invalid");
      }

      const verdict = this.budget.take(String(matched));
      if (!verdict.allowed) {
        void reply.header("retry-after", String(verdict.retryAfter));
        return refuse(reply, 429, "rate-limited");
      }

      const summary = await this.summaries.read();
      return reply
        .code(200)
        .header("cache-control", "no-store")
        .type("application/json")
        .send(summary);
    });

    return server;
  }
}

/**
 * A refusal: its status and its reason, and nothing else said. Uncached, like
 * every answer here.
 */
function refuse(
  reply: FastifyReply,
  status: number,
  reason: string,
): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("application/json")
    .send({ reason });
}
