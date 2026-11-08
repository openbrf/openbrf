import { Controller, Logger, Post } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DomainExceptionFilter } from "../http/domain-exception.filter";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { PublicRateLimitGuard } from "../http/public-rate-limit.guard";
import { SiteRateLimitFilter } from "./site-rate-limit.filter";
import {
  type RefusalPlace,
  SITE_HTML_HEADERS,
  SiteRenderer,
} from "./site-renderer.service";

/**
 * Who answers a spent public budget, and in which language.
 *
 * Over real HTTP, because what is under test is which filter Nest picks for an
 * exception thrown in a guard, and that is decided by the order the filters
 * were registered in. The two filters are registered here in the order
 * app.module.ts gives them. The renderer is replaced: what the page says is
 * site-html.spec.ts's business, and this file only needs to see which page was
 * asked for and in which language.
 */

/**
 * A website form, a link to an issue and an API route, each with room for one
 * request a minute.
 */
@Controller()
class LimitedController {
  @Post("en-sida/kontakt")
  @PublicRateLimit({ perMinute: 1 })
  form(this: void): { ok: boolean } {
    return { ok: true };
  }

  @Post("arende/:token")
  @PublicRateLimit({ perMinute: 1 })
  link(this: void): { ok: boolean } {
    return { ok: true };
  }

  @Post("api/limited")
  @PublicRateLimit({ perMinute: 1 })
  api(this: void): { ok: boolean } {
    return { ok: true };
  }
}

const tooManyRequests = vi.fn(
  (acceptLanguage: string | undefined, place: RefusalPlace) =>
    Promise.resolve(
      `<p>refused on the ${place} in ${acceptLanguage ?? "no language"}</p>`,
    ),
);

let app: NestFastifyApplication;

/** A fresh address per test, so each one starts on a full bucket. */
let nextAddress = 1;
function anAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String(nextAddress)}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [LimitedController],
    providers: [
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_FILTER, useClass: SiteRateLimitFilter },
      { provide: APP_GUARD, useClass: PublicRateLimitGuard },
      { provide: ENV, useValue: { TRUSTED_PROXIES: ["127.0.0.1"] } as Env },
      { provide: SiteRenderer, useValue: { tooManyRequests } },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

let errorLog: { mockRestore(): void } | undefined;

afterEach(() => {
  errorLog?.mockRestore();
  errorLog = undefined;
});

afterAll(async () => {
  await app.close();
});

/**
 * What the filter logged as errors: each call's message, and every argument of
 * every call, frames included, for checking that nothing private reached the
 * log at all.
 */
function loggedErrors(): { messages(): string[]; everything(): string } {
  const error = vi
    .spyOn(Logger.prototype, "error")
    .mockImplementation(() => undefined);
  errorLog = error;
  return {
    messages: () => error.mock.calls.map(([message]) => String(message)),
    everything: () =>
      error.mock.calls.flatMap((args) => args.map(String)).join("\n"),
  };
}

/** Marks a failure's message, which is never logged (ADR 0007). */
const PRIVATE_MESSAGE = "private-message-marker";

/** Spends one address's budget on `url` and returns the refusal after it. */
async function refusedAt(url: string, headers: Record<string, string> = {}) {
  const server = app.getHttpAdapter().getInstance();
  const address = anAddress();
  const send = () =>
    server.inject({
      method: "POST",
      url,
      headers: { "x-forwarded-for": address, ...headers },
    });
  expect((await send()).statusCode).toBe(201);
  return send();
}

describe("a spent budget on a website address", () => {
  it("is answered with the website's page, in the language the visitor asked for", async () => {
    const refused = await refusedAt("/en-sida/kontakt", {
      "accept-language": "en-GB,en;q=0.9",
    });

    expect(refused.statusCode).toBe(429);
    expect(refused.headers["content-type"]).toBe(
      SITE_HTML_HEADERS["content-type"],
    );
    expect(refused.headers["content-security-policy"]).toBe(
      SITE_HTML_HEADERS["content-security-policy"],
    );
    expect(refused.body).toBe(
      "<p>refused on the website in en-GB,en;q=0.9</p>",
    );
    // The delay the guard worked out survives the page drawn around it.
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("never shows the API's own English sentence", async () => {
    const refused = await refusedAt("/en-sida/kontakt", {
      "accept-language": "sv",
    });

    expect(refused.body).not.toContain("Too many requests");
    expect(refused.body).not.toContain("too-many-requests");
  });

  it("still answers the refusal and its delay when the page cannot be drawn", async () => {
    tooManyRequests.mockRejectedValueOnce(new Error(PRIVATE_MESSAGE));
    const logged = loggedErrors();

    const refused = await refusedAt("/en-sida/kontakt");

    // A refusal, not a server fault, and nothing of the failure in the body.
    expect(refused.statusCode).toBe(429);
    expect(refused.body).toBe("");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(logged.messages()).toEqual([
      "The rate-limit page for the website could not be rendered: Error",
    ]);
    expect(logged.everything()).not.toContain(PRIVATE_MESSAGE);
  });
});

describe("a spent budget on a link to an issue", () => {
  it("is answered with the link's page, which has no menu", async () => {
    const refused = await refusedAt(`/arende/obrf_rl_${"F".repeat(43)}`, {
      "accept-language": "sv",
    });

    expect(refused.statusCode).toBe(429);
    expect(refused.body).toBe("<p>refused on the link in sv</p>");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("logs a page it cannot draw as the link's, and never the address", async () => {
    const token = `obrf_rl_${"G".repeat(43)}`;
    // The token in the failure's message too, as a database error quoting the
    // statement's parameters would carry it.
    tooManyRequests.mockRejectedValueOnce(
      new Error(`${PRIVATE_MESSAGE}: ${token}`),
    );
    const logged = loggedErrors();

    const refused = await refusedAt(`/arende/${token}`);

    expect(refused.statusCode).toBe(429);
    expect(refused.body).toBe("");
    expect(logged.messages()).toEqual([
      "The rate-limit page for a link to an issue could not be rendered: Error",
    ]);
    // Every argument, frames included, not the message line alone.
    expect(logged.everything()).not.toContain(token);
    expect(logged.everything()).not.toContain(PRIVATE_MESSAGE);
  });
});

describe("a spent budget on an API route", () => {
  it("keeps the JSON code the application's screens map to a sentence", async () => {
    tooManyRequests.mockClear();

    const refused = await refusedAt("/api/limited", {
      "accept-language": "sv",
    });

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ reason: "too-many-requests" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(tooManyRequests).not.toHaveBeenCalled();
  });
});
