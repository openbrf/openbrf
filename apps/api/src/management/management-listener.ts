import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { IncomingMessage } from "node:http";

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { TokenRateLimiter } from "../auth/token-rate-limit";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { failureFrames, failureName } from "../logging/failure";
import {
  SUPPORTER_NAME_MAX_LENGTH,
  SupportAccessService,
} from "../support/support-access.service";
import { SupportAccessClosedError } from "../support/support-errors";
import { ManagementSummaryService } from "./management-summary.service";
import {
  matchingManagementDigest,
  presentedManagementToken,
} from "./management-token";

/** Calls one token may make in a minute, summaries and sign-in links together. */
export const MANAGEMENT_CALLS_PER_MINUTE = 10;

/** The largest body the sign-in link route reads, in bytes. */
export const SUPPORT_SESSION_BODY_LIMIT = 1024;

/** Any control character, which a supporter's name may not carry. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** How long one request may take before the listener gives up on it. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The management API's listener (ADR 0021): a server of its own, on a port of
 * its own, answering two routes.
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
 * `GET /v1/summary` reads, and `POST /v1/support-sessions` asks for a support
 * session's sign-in link while an administrator has support access open (ADR
 * 0028), which is the one thing this listener writes. Any other path, and any
 * other method on these, is 404 before the token is looked at. The token is
 * checked against the configured digests, then charged against a budget of ten
 * a minute keyed on which digest matched and shared by both routes, then the
 * route does its work, in that order - a budget keyed on the presented value
 * would let anybody open counters. Counted per process, as every budget in this
 * application is (ADR 0009).
 *
 * No body is parsed before the token matches. The framework is given no
 * parser, so a body is left unread on the socket until the sign-in link route
 * has checked the token and reads up to a kilobyte of it itself; the summary
 * never reads one.
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
    private readonly support: SupportAccessService,
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

    /*
     * Nothing is parsed by the framework. Every body, whatever it says it is,
     * is handed on unread, so a caller without the token has no byte of it
     * read; the one route that takes a body reads it after the token matched.
     */
    server.removeAllContentTypeParsers();
    server.addContentTypeParser("*", (_request, _payload, done) => {
      done(null, undefined);
    });

    server.setNotFoundHandler(async (_request, reply) =>
      refuse(reply, 404, "not-found"),
    );

    server.setErrorHandler(async (error, request, reply) => {
      const summary = request.routeOptions.url === "/v1/summary";
      // The class and the frames, never the message: a database error names
      // the values it was handling (logging/failure.ts).
      this.logger.error(
        summary
          ? `The management summary could not be read: ${failureName(error)}`
          : `A support sign-in link could not be issued: ${failureName(error)}`,
        failureFrames(error),
      );
      return refuse(
        reply,
        500,
        summary ? "summary-unavailable" : "support-session-unavailable",
      );
    });

    server.get("/v1/summary", async (request, reply) => {
      if (!this.admitted(request, reply)) {
        return reply;
      }
      const summary = await this.summaries.read();
      return reply
        .code(200)
        .header("cache-control", "no-store")
        .type("application/json")
        .send(summary);
    });

    server.post("/v1/support-sessions", async (request, reply) => {
      if (!this.admitted(request, reply)) {
        return reply;
      }
      const body = await readBody(request.raw, SUPPORT_SESSION_BODY_LIMIT);
      const supporter = supporterIn(body);
      if (supporter === null) {
        // A body left unread on the socket cannot be followed by another
        // request on it, so the connection closes with the answer.
        if (body === null) {
          void reply.header("connection", "close");
        }
        return refuse(reply, 400, "invalid-body");
      }
      try {
        const issued = await this.support.issueSignIn(supporter);
        return await reply
          .code(201)
          .header("cache-control", "no-store")
          .type("application/json")
          .send({
            signInUrl: issued.signInUrl,
            expiresAt: issued.expiresAt.toISOString(),
            accessEndsAt: issued.accessEndsAt.toISOString(),
          });
      } catch (failure) {
        if (failure instanceof SupportAccessClosedError) {
          return refuse(reply, 409, "support-access-closed");
        }
        throw failure;
      }
    });

    return server;
  }

  /**
   * Checks the token and spends the budget, answering the refusal itself when
   * either fails. Common to both routes, and before either reads anything.
   */
  private admitted(request: FastifyRequest, reply: FastifyReply): boolean {
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
      void refuse(
        reply.header("www-authenticate", "Bearer"),
        401,
        "management-token-invalid",
      );
      return false;
    }

    const verdict = this.budget.take(String(matched));
    if (!verdict.allowed) {
      void refuse(
        reply.header("retry-after", String(verdict.retryAfter)),
        429,
        "rate-limited",
      );
      return false;
    }
    return true;
  }
}

/**
 * The request's body, up to `limit` bytes, or null when it is longer.
 *
 * Read from the socket here because the framework parses nothing on this
 * listener. A declared length over the limit is refused without reading a
 * byte, and a body that turns out longer stops being read at the limit, so a
 * caller cannot make the listener hold more than a kilobyte. Reading stops by
 * pausing rather than by destroying the stream, which would take the socket
 * with it and the 400 would never arrive.
 */
function readBody(raw: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(raw.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const stop = (): void => {
      raw.off("data", onData);
      raw.off("end", onEnd);
      raw.off("error", onError);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) {
        stop();
        raw.pause();
        resolve(null);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      stop();
      resolve(Buffer.concat(chunks));
    };
    const onError = (failure: Error): void => {
      stop();
      reject(failure);
    };
    raw.on("data", onData);
    raw.on("end", onEnd);
    raw.on("error", onError);
  });
}

/**
 * The supporter's name a body states, or null when it states none that may be
 * recorded: JSON, an object, and a `supporter` of 1 to 80 characters after
 * trimming with no control character in it.
 *
 * The host's word for who it is sending, which the instance cannot check. It
 * is written to the session and to the entry that records the link was asked
 * for, and shown to the administrator on the settings screen.
 */
function supporterIn(body: Buffer | null): string | null {
  if (body === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const supporter = (parsed as { supporter?: unknown }).supporter;
  if (typeof supporter !== "string") {
    return null;
  }
  const trimmed = supporter.trim();
  if (
    trimmed.length === 0 ||
    Array.from(trimmed).length > SUPPORTER_NAME_MAX_LENGTH ||
    CONTROL_CHARACTER.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
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
