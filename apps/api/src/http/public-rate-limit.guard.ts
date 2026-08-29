import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DomainError } from "./domain-error";
import {
  PUBLIC_RATE_LIMIT,
  type PublicRateLimitOptions,
} from "./public-rate-limit.decorator";

/** The window a budget is expressed in. */
const WINDOW_MS = 60_000;

/** The client address used when the request carries none that can be trusted. */
const UNKNOWN_ADDRESS = "unknown";

/** Too many requests from one client address in too little time. */
export class TooManyRequestsError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason = "too-many-requests";
}

/** Whether one request may proceed, and how long to wait when it may not. */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Bucket {
  /** Tokens left, fractional because refill is continuous. */
  tokens: number;
  /** When `tokens` was last computed. */
  filledAt: number;
}

/**
 * The client address a request came from.
 *
 * Read from the first x-forwarded-for value, which is the same assumption
 * `auth-options.ts` documents for Better Auth's own limiter and the same one
 * this deployment is built on: one container behind a reverse proxy that
 * OVERWRITES the header rather than appending to a client-supplied value, which
 * is the default behaviour of nginx, Caddy and Traefik. An instance exposed
 * directly to the internet without a proxy lets a caller spoof the header and
 * sidestep the budget - and would sidestep the sign-in limiter the same way.
 *
 * Honouring the header is also what keeps the end-to-end suite honest: every
 * test there is a different resident signing in from their own home, and
 * `e2e/src/fixtures.ts` says so by giving each one its own address.
 */
export function clientAddressOf(
  request: Pick<FastifyRequest, "headers" | "ip">,
): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") {
    return first;
  }
  // Fastify's own view of the peer, which behind a proxy is the proxy. Better
  // one shared bucket than none at all: a deployment with no forwarded header
  // is misconfigured, and the endpoint stays limited while it is.
  return request.ip === "" ? UNKNOWN_ADDRESS : request.ip;
}

/**
 * Token buckets, in this process and nowhere else.
 *
 * In-memory is correct for the deployment this platform ships: one application
 * container per instance, so this process sees every request the instance
 * receives. Running more than one container per instance would give each its
 * own buckets and multiply every budget by the number of containers; the answer
 * then is a shared bucket in a table, which is deliberately not built until
 * there is a deployment that needs it.
 *
 * A bucket refills continuously rather than resetting on a boundary, so a
 * caller who spends a budget does not get the whole of it back at the top of
 * the next minute.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private sweptAt = 0;

  /**
   * Spends one token for `key`, or refuses.
   *
   * `perMinute` is both the capacity and the refill rate, and has to be at
   * least one: a budget below one token a minute would refuse every request
   * forever, since a bucket is only ever asked for a whole token.
   */
  take(
    key: string,
    perMinute: number,
    now: number = Date.now(),
  ): RateLimitDecision {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    const tokens =
      bucket === undefined
        ? perMinute
        : Math.min(
            perMinute,
            bucket.tokens + ((now - bucket.filledAt) / WINDOW_MS) * perMinute,
          );

    if (tokens < 1) {
      // Banked, not spent: a request the budget itself turned away takes
      // nothing further, so being refused does not push the next attempt out.
      this.buckets.set(key, { tokens, filledAt: now });
      const wait = ((1 - tokens) * WINDOW_MS) / perMinute;
      // Rounded up and never below a second: a Retry-After of 0 invites an
      // immediate retry that would be refused again.
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
      };
    }

    this.buckets.set(key, { tokens: tokens - 1, filledAt: now });
    return { allowed: true };
  }

  /** How many buckets are being tracked. Exists for the tests of the sweep. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Forgets the buckets that have refilled, at most once a window.
   *
   * A bucket untouched for a whole window is full again whatever its capacity,
   * which makes it indistinguishable from a caller who has never been seen. So
   * dropping it loses nothing, and what is left is bounded by the number of
   * addresses actually spending tokens - rather than by the number of addresses
   * that have ever reached the instance, which is the number an attacker
   * chooses.
   */
  private sweep(now: number): void {
    if (now - this.sweptAt < WINDOW_MS) {
      return;
    }
    this.sweptAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.filledAt >= WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Enforces the budget a route declared with @PublicRateLimit.
 *
 * Registered globally and does nothing at all on a route that declared none,
 * which is the same shape the authorization guard has: the decorator is the
 * whole of what a route has to say, and a public endpoint added later cannot
 * end up behind a limiter that was wired in one module and not another.
 *
 * Budgets are per route and per address, so one form being hammered never
 * spends another form's budget, and Better Auth's own limiter on /api/auth/*
 * is left exactly as it is.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly buckets = new TokenBuckets();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<
      PublicRateLimitOptions | undefined
    >(PUBLIC_RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (options === undefined) {
      return true;
    }

    const http = context.switchToHttp();
    const address = clientAddressOf(http.getRequest<FastifyRequest>());
    /*
     * The route is part of the key, so the budget a route declares is its
     * own. The space separates them unambiguously: a class and a method are
     * identifiers and neither can contain one, so the first space in the key
     * is always the one put there here.
     */
    const key = `${context.getClass().name}.${context.getHandler().name} ${address}`;

    const decision = this.buckets.take(key, options.perMinute);
    if (decision.allowed) {
      return true;
    }

    http
      .getResponse<FastifyReply>()
      .header("retry-after", String(decision.retryAfterSeconds));
    // The refusal says nothing about the submission: a caller learns that it
    // asked too often and nothing else.
    throw new TooManyRequestsError(
      "Too many requests from this address. Try again shortly.",
    );
  }
}
