import { Controller, type ExecutionContext, Post } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DomainExceptionFilter } from "./domain-exception.filter";
import { PublicRateLimit } from "./public-rate-limit.decorator";
import {
  clientAddressOf,
  PublicRateLimitGuard,
  TokenBuckets,
  TooManyRequestsError,
  trustedProxyList,
} from "./public-rate-limit.guard";

/**
 * The budget that stands between a public form and a script.
 *
 * Three properties carry it, and each has a way of going quietly wrong. The
 * client address has to come from the hops of the forwarded header that the
 * instance's own proxies wrote, and from nothing a client wrote: read too
 * little and every caller shares one bucket, so the first script to arrive
 * locks out the whole cooperative; read too much and a script picks a fresh
 * bucket for every request. The bucket has to refill, or a resident
 * who filled a form in twice this morning is refused for the rest of the day.
 * And a route that declared no budget has to be untouched, because the guard is
 * global and runs on every request the instance answers.
 */

const WINDOW_MS = 60_000;

/** Matches MAX_BUCKETS in the guard. */
const MAX_BUCKETS = 50_000;

/*
 * The routes under test, declared the way a controller declares them so the
 * guard reads real metadata rather than metadata this file wrote by hand.
 * `this: void` says these handlers use no instance state, which is what lets a
 * test pass one around as a plain function.
 */
class PublicForms {
  @PublicRateLimit({ perMinute: 3 })
  submit(this: void): void {}

  @PublicRateLimit({ perMinute: 3 })
  accept(this: void): void {}

  read(this: void): void {}
}

/** The proxy in front of the instance, on the same host. */
const LOOPBACK_PROXY = trustedProxyList(["127.0.0.1"]);

/** No proxy named. */
const NO_PROXY = trustedProxyList([]);

/** An environment naming the loopback proxy, for the guard. */
const ENV_WITH_PROXY = { TRUSTED_PROXIES: ["127.0.0.1"] } as Env;

function requestFrom(
  headers: Record<string, string | string[] | undefined>,
  ip = "127.0.0.1",
): Pick<FastifyRequest, "headers" | "ip"> {
  return { headers, ip } as Pick<FastifyRequest, "headers" | "ip">;
}

/** A context and the reply headers the guard set on it. */
function contextFor(
  handler: () => void,
  address: string,
): { context: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
      return reply;
    },
  };
  const context = {
    getHandler: () => handler,
    getClass: () => PublicForms,
    switchToHttp: () => ({
      getRequest: () => requestFrom({ "x-forwarded-for": address }),
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

describe("the client address a budget is spent against", () => {
  it("is the right-most hop the trusted proxy did not write", () => {
    // What a proxy that appends rather than overwrites sends: whatever the
    // client put in the header, then the address the proxy was reached from.
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "198.51.100.4, 203.0.113.9" }),
        LOOPBACK_PROXY,
      ),
    ).toBe("203.0.113.9");
  });

  it("gives one bucket to a client however it fills the header in", () => {
    // The left of the header is the client's to write. Two requests from one
    // client that write different things there are still one client.
    const addresses = ["10.1.2.3", "192.0.2.77", "not-an-address"].map(
      (spoofed) =>
        clientAddressOf(
          requestFrom({ "x-forwarded-for": `${spoofed}, 203.0.113.9` }),
          LOOPBACK_PROXY,
        ),
    );
    expect(new Set(addresses)).toEqual(new Set(["203.0.113.9"]));
  });

  it("walks past every proxy that is trusted, and stops at the first that is not", () => {
    const chain = trustedProxyList(["127.0.0.1", "10.0.0.0/8"]);
    expect(
      clientAddressOf(
        requestFrom({
          "x-forwarded-for": "192.0.2.1, 198.51.100.4, 10.0.0.7, 10.0.0.8",
        }),
        chain,
      ),
    ).toBe("198.51.100.4");
  });

  it("survives the whitespace a header is written with, and a repeated field", () => {
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "  198.51.100.4  " }),
        LOOPBACK_PROXY,
      ),
    ).toBe("198.51.100.4");
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": ["192.0.2.1", "198.51.100.4"] }),
        LOOPBACK_PROXY,
      ),
    ).toBe("198.51.100.4");
  });

  it("is the connection when it does not come from a trusted proxy", () => {
    // Nobody vouches for the header, so it is not read.
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "198.51.100.4" }, "203.0.113.9"),
        LOOPBACK_PROXY,
      ),
    ).toBe("203.0.113.9");
  });

  it("is the connection when no proxy is named", () => {
    // One shared bucket behind an unnamed proxy, which is wrong but bounded;
    // reading the header instead would hand the bucket to the caller.
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "198.51.100.4" }),
        NO_PROXY,
      ),
    ).toBe("127.0.0.1");
    expect(clientAddressOf(requestFrom({}, "203.0.113.9"), NO_PROXY)).toBe(
      "203.0.113.9",
    );
  });

  it("is the proxy when the proxy forwarded nothing usable", () => {
    expect(
      clientAddressOf(requestFrom({ "x-forwarded-for": "" }), LOOPBACK_PROXY),
    ).toBe("127.0.0.1");
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "garbage" }),
        LOOPBACK_PROXY,
      ),
    ).toBe("127.0.0.1");
  });

  it("recognises a trusted proxy reached over IPv6 as a mapped address", () => {
    expect(
      clientAddressOf(
        requestFrom({ "x-forwarded-for": "198.51.100.4" }, "::ffff:127.0.0.1"),
        LOOPBACK_PROXY,
      ),
    ).toBe("198.51.100.4");
  });
});

describe("a token bucket", () => {
  it("allows the budget and refuses the request after it", () => {
    const buckets = new TokenBuckets();
    const now = 1_000_000;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(buckets.take("form some-address", 3, now).allowed).toBe(true);
    }

    const refused = buckets.take("form some-address", 3, now);
    expect(refused.allowed).toBe(false);
  });

  it("refills continuously rather than at the top of a minute", () => {
    const buckets = new TokenBuckets();
    const start = 1_000_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      buckets.take("form some-address", 3, start);
    }

    // A third of a window is one of three tokens: enough for one request and
    // not for two.
    const third = start + WINDOW_MS / 3;
    expect(buckets.take("form some-address", 3, third).allowed).toBe(true);
    expect(buckets.take("form some-address", 3, third).allowed).toBe(false);

    // A whole window later the budget is back, and no more than the budget.
    const later = start + WINDOW_MS * 5;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(buckets.take("form some-address", 3, later).allowed).toBe(true);
    }
    expect(buckets.take("form some-address", 3, later).allowed).toBe(false);
  });

  it("says how long to wait, in whole seconds and never none", () => {
    const buckets = new TokenBuckets();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      buckets.take("form some-address", 3, now);
    }

    const refused = buckets.take("form some-address", 3, now);
    if (refused.allowed) {
      throw new Error("The budget was expected to be spent.");
    }
    // A third of a minute for one of three tokens, rounded up.
    expect(refused.retryAfterSeconds).toBe(20);
  });

  it("spends one address's budget and leaves the next one whole", () => {
    const buckets = new TokenBuckets();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      buckets.take("form 198.51.100.4", 3, now);
    }

    expect(buckets.take("form 198.51.100.4", 3, now).allowed).toBe(false);
    expect(buckets.take("form 203.0.113.9", 3, now).allowed).toBe(true);
  });

  it("gives back a spent token, and never more than the budget", () => {
    const buckets = new TokenBuckets();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      buckets.take("form some-address", 3, now);
    }
    expect(buckets.take("form some-address", 3, now).allowed).toBe(false);

    buckets.refund("form some-address", 3);
    expect(buckets.take("form some-address", 3, now).allowed).toBe(true);
    expect(buckets.take("form some-address", 3, now).allowed).toBe(false);

    // A refund past full changes nothing, and an unknown key is left alone.
    buckets.refund("form other-address", 3);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      buckets.refund("form some-address", 3);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(buckets.take("form some-address", 3, now).allowed).toBe(true);
    }
    expect(buckets.take("form some-address", 3, now).allowed).toBe(false);
    expect(buckets.size).toBe(1);
  });

  it("tells what a take would answer without spending anything", () => {
    const buckets = new TokenBuckets();
    const now = 1_000_000;
    expect(buckets.peek("form some-address", 3, now)).toEqual({
      allowed: true,
    });
    // An unknown key stays unknown, so a peek alone never grows the map.
    expect(buckets.size).toBe(0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(buckets.peek("form some-address", 3, now).allowed).toBe(true);
      buckets.take("form some-address", 3, now);
    }

    // The same wait the take reports: a token every twenty seconds.
    expect(buckets.peek("form some-address", 3, now)).toEqual({
      allowed: false,
      retryAfterSeconds: 20,
    });
    expect(buckets.take("form some-address", 3, now)).toEqual({
      allowed: false,
      retryAfterSeconds: 20,
    });
    expect(buckets.peek("form some-address", 3, now + 15_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
    });
    expect(buckets.peek("form some-address", 3, now + 20_000).allowed).toBe(
      true,
    );
    expect(buckets.take("form some-address", 3, now + 20_000).allowed).toBe(
      true,
    );
  });

  it("forgets an address that has stopped spending", () => {
    const buckets = new TokenBuckets();
    const start = 1_000_000;
    buckets.take("form 198.51.100.4", 3, start);
    buckets.take("form 203.0.113.9", 3, start);
    expect(buckets.size).toBe(2);

    // A full window later both are full again, which is what an address nobody
    // has ever seen looks like - so keeping them would only grow the map for
    // nothing.
    buckets.take("form 192.0.2.1", 3, start + WINDOW_MS);
    expect(buckets.size).toBe(1);
  });

  it("stops growing when addresses arrive faster than the sweep", () => {
    const buckets = new TokenBuckets();
    const start = 1_000_000;
    let largest = 0;

    /*
     * A caller rotating the forwarded header: every request is a new key, so
     * every request costs a bucket and none costs a token. The clock never
     * moves here, which is the point - within one window the once-a-window
     * sweep finds nothing idle to drop, so it is not what bounds this map, and
     * the size the caller could otherwise choose is memory on the instance that
     * also serves the register.
     */
    for (let attempt = 0; attempt < MAX_BUCKETS * 3; attempt += 1) {
      buckets.take(`form 198.51.100.${attempt}`, 3, start);
      largest = Math.max(largest, buckets.size);
    }

    // Reached the cap and never went past it, over three times as many
    // addresses as the map is allowed to hold.
    expect(largest).toBe(MAX_BUCKETS);
  });
});

describe("the guard", () => {
  it("does nothing at all on a route that declared no budget", () => {
    const guard = new PublicRateLimitGuard(new Reflector(), ENV_WITH_PROXY);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { context } = contextFor(
        PublicForms.prototype.read,
        "198.51.100.4",
      );
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it("refuses past the budget and says when to come back", () => {
    const guard = new PublicRateLimitGuard(new Reflector(), ENV_WITH_PROXY);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { context } = contextFor(
        PublicForms.prototype.submit,
        "198.51.100.4",
      );
      expect(guard.canActivate(context)).toBe(true);
    }

    const { context, headers } = contextFor(
      PublicForms.prototype.submit,
      "198.51.100.4",
    );
    expect(() => guard.canActivate(context)).toThrow(TooManyRequestsError);
    expect(headers["retry-after"]).toBeDefined();
  });

  it("holds a separate budget per address", () => {
    const guard = new PublicRateLimitGuard(new Reflector(), ENV_WITH_PROXY);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { context } = contextFor(
        PublicForms.prototype.submit,
        "198.51.100.4",
      );
      try {
        guard.canActivate(context);
      } catch {
        // The refusal is the previous test's subject.
      }
    }

    const { context } = contextFor(PublicForms.prototype.submit, "203.0.113.9");
    expect(guard.canActivate(context)).toBe(true);
  });

  it("holds a separate budget per route", () => {
    // One form being hammered must not close another: the two forms are
    // different doors, and a visitor at one has nothing to do with the other.
    const guard = new PublicRateLimitGuard(new Reflector(), ENV_WITH_PROXY);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { context } = contextFor(
        PublicForms.prototype.submit,
        "198.51.100.4",
      );
      try {
        guard.canActivate(context);
      } catch {
        // As above.
      }
    }

    const { context } = contextFor(
      PublicForms.prototype.accept,
      "198.51.100.4",
    );
    expect(guard.canActivate(context)).toBe(true);
  });
});

/** A route with room for exactly one request a minute, for the test below. */
@Controller("limited")
class LimitedController {
  @Post()
  @PublicRateLimit({ perMinute: 1 })
  submit(this: void): { ok: boolean } {
    return { ok: true };
  }
}

describe("the refusal a caller receives", () => {
  it("is a refusal and not a server fault", async () => {
    /*
     * The guard throws a domain error, and a domain error is only a 429 because
     * the exception filter answers for exceptions thrown in a guard as well as
     * in a handler. If it did not, every refusal here would be a 500 - the
     * caller would be told the instance is broken, and the log would fill with
     * errors nobody can act on. Asserted over a real request for that reason.
     */
    const moduleRef = await Test.createTestingModule({
      controllers: [LimitedController],
      providers: [
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        { provide: APP_GUARD, useClass: PublicRateLimitGuard },
        { provide: ENV, useValue: ENV_WITH_PROXY },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    const server = app.getHttpAdapter().getInstance();
    await server.ready();

    try {
      const post = () =>
        server.inject({
          method: "POST",
          url: "/limited",
          headers: { "x-forwarded-for": "198.51.100.4" },
        });

      expect((await post()).statusCode).toBe(201);

      const refused = await post();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ reason: "too-many-requests" });
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

      // Another address is untouched by the first one's spending.
      const neighbour = await server.inject({
        method: "POST",
        url: "/limited",
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      expect(neighbour.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("counts a client behind an appending proxy once, whatever it puts before its address", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LimitedController],
      providers: [
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        { provide: APP_GUARD, useClass: PublicRateLimitGuard },
        {
          provide: ENV,
          useValue: { TRUSTED_PROXIES: ["127.0.0.1/32"] } as Env,
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    const server = app.getHttpAdapter().getInstance();
    await server.ready();

    try {
      // Injected requests arrive from 127.0.0.1, the proxy named above.
      const post = (spoofed: string) =>
        server.inject({
          method: "POST",
          url: "/limited",
          headers: { "x-forwarded-for": `${spoofed}, 203.0.113.9` },
        });

      expect((await post("10.9.8.7")).statusCode).toBe(201);
      expect((await post("10.9.8.6")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
