import { BlockList, isIP } from "node:net";

import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DomainError } from "./domain-error";
import {
  PUBLIC_RATE_LIMIT,
  type PublicRateLimitOptions,
} from "./public-rate-limit.decorator";

/** The window a budget is expressed in. */
const WINDOW_MS = 60_000;

/** The client address used when the request carries none that can be trusted. */
const UNKNOWN_ADDRESS = "unknown";

/**
 * How many buckets are held before a sweep is forced, whatever the clock says.
 *
 * The sweep below runs at most once a window, so between two sweeps the map
 * grows by one entry for every address that arrives - and a caller who rotates
 * the forwarded header decides how many addresses that is. Rotating also means
 * every request starts on a full bucket and no budget is ever spent, so the
 * only cost of the flood is this map. The cap turns "as many as arrive in a
 * window" into a fixed number, on an anonymous route served by the same process
 * as the member register.
 *
 * 50 000 is far above what a cooperative's residents produce in a minute and
 * small enough that the map costs a few megabytes.
 */
const MAX_BUCKETS = 50_000;

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

/** The refusal for a bucket holding `tokens`, with the wait until it holds one. */
function refusedFor(tokens: number, perMinute: number): RateLimitDecision {
  const wait = ((1 - tokens) * WINDOW_MS) / perMinute;
  // Rounded up and never below a second: a Retry-After of 0 invites an
  // immediate retry that would be refused again.
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
  };
}

/**
 * The proxies whose word about the client is taken, from `TRUSTED_PROXIES`.
 *
 * The same list the Fastify bridge resolves the client address against before
 * a request reaches Better Auth's own limiter (fastify-bridge.ts), so the two
 * limiters cannot disagree about who a client is. The entries were validated
 * with the rest of the environment.
 */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    const bits = family === "ipv4" ? 32 : 128;
    list.addSubnet(
      address,
      prefix === undefined ? bits : Number(prefix),
      family,
    );
  }
  return list;
}

function isTrustedProxy(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The client address a request came from.
 *
 * The connection's own address, unless it is a proxy the operator named in
 * `TRUSTED_PROXIES`. Then the forwarded header is read from the right, one hop
 * at a time, for as long as the hop being read from is itself trusted: each
 * proxy appends the address it was reached from, so the right-most entries are
 * the ones the instance's own proxies wrote, and everything to the left of the
 * first address that is not one of them was written by the client and proves
 * nothing. That holds for a proxy that appends to the header and for one that
 * overwrites it alike.
 *
 * With no proxy named the header is not read at all. An instance reachable
 * without a proxy would otherwise take a caller's word for who it is; behind a
 * proxy that nobody named, every visitor shares the proxy's bucket, which is
 * wrong but bounded, and docs/deployment.md says to name it.
 */
export function clientAddressOf(
  request: Pick<FastifyRequest, "headers" | "ip">,
  trusted: BlockList,
): string {
  const forwarded = request.headers["x-forwarded-for"];
  const hops = (
    Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")
  )
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");

  let address = request.ip;
  while (isTrustedProxy(trusted, address)) {
    const hop = hops.pop();
    if (hop === undefined || isIP(hop) === 0) {
      break;
    }
    address = hop;
  }
  return address === "" ? UNKNOWN_ADDRESS : address;
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

    const tokens = this.tokensAt(key, perMinute, now);
    if (tokens < 1) {
      // Banked, not spent: a request the budget itself turned away takes
      // nothing further, so being refused does not push the next attempt out.
      this.buckets.set(key, { tokens, filledAt: now });
      return refusedFor(tokens, perMinute);
    }

    this.buckets.set(key, { tokens: tokens - 1, filledAt: now });
    return { allowed: true };
  }

  /**
   * What `take` would answer for `key` now, without spending or banking.
   *
   * For a caller refused by something else first, who still needs to be told
   * the longer of the two waits: a request turned away for one reason and
   * retried after that reason's delay should not then meet this budget spent.
   */
  peek(
    key: string,
    perMinute: number,
    now: number = Date.now(),
  ): RateLimitDecision {
    const tokens = this.tokensAt(key, perMinute, now);
    return tokens < 1 ? refusedFor(tokens, perMinute) : { allowed: true };
  }

  /**
   * Gives back a token `take` spent for `key`, for a request that was let
   * through one budget and then refused by another.
   *
   * Capped at `perMinute` like a refill, and a no-op for a key no longer
   * tracked: a bucket the sweep has dropped is full, which is what a refund
   * would have restored it to.
   */
  refund(key: string, perMinute: number): void {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) {
      bucket.tokens = Math.min(perMinute, bucket.tokens + 1);
    }
  }

  /** The tokens `key` holds at `now`, with the refill since it was last set. */
  private tokensAt(key: string, perMinute: number, now: number): number {
    const bucket = this.buckets.get(key);
    return bucket === undefined
      ? perMinute
      : Math.min(
          perMinute,
          bucket.tokens + ((now - bucket.filledAt) / WINDOW_MS) * perMinute,
        );
  }

  /** How many buckets are being tracked. Exists for the tests of the sweep. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Forgets the buckets that have refilled, at most once a window, and empties
   * the map outright when one window's arrivals have filled it past the cap.
   *
   * A bucket untouched for a whole window is full again whatever its capacity,
   * which makes it indistinguishable from a caller who has never been seen, so
   * dropping it loses nothing. That alone does not bound the map though: what
   * it leaves is every address seen since the last sweep, and a caller who
   * rotates the forwarded header picks that number. MAX_BUCKETS is the bound
   * that does not depend on the caller, which is why it is a second condition
   * here rather than a belt-and-braces one.
   */
  private sweep(now: number): void {
    if (now - this.sweptAt < WINDOW_MS && this.buckets.size < MAX_BUCKETS) {
      return;
    }
    this.sweptAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.filledAt >= WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= MAX_BUCKETS) {
      /*
       * Nothing idle was left to drop, so the map holds buckets a flood made
       * inside one window and there is no honest one to keep in preference:
       * evicting the oldest entries would keep the flood's newest and throw out
       * the residents who were here first. Everything goes instead. A caller
       * loses a partly spent budget, which is what a restart costs them anyway,
       * and the map is small again - so the scan above stays once a window
       * rather than becoming a scan of the whole map on every request, which
       * would hand the flood a processor to exhaust once it had run out of
       * memory to grow.
       */
      this.buckets.clear();
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
  private readonly trusted: BlockList;

  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) env: Env,
  ) {
    this.trusted = trustedProxyList(env.TRUSTED_PROXIES);
  }

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<
      PublicRateLimitOptions | undefined
    >(PUBLIC_RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (options === undefined) {
      return true;
    }

    const http = context.switchToHttp();
    const address = clientAddressOf(
      http.getRequest<FastifyRequest>(),
      this.trusted,
    );
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
