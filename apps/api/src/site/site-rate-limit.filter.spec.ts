import { Controller, Post } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DomainExceptionFilter } from "../http/domain-exception.filter";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { PublicRateLimitGuard } from "../http/public-rate-limit.guard";
import { SiteRateLimitFilter } from "./site-rate-limit.filter";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

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

/** A website form and an API route, each with room for one request a minute. */
@Controller()
class LimitedController {
  @Post("en-sida/kontakt")
  @PublicRateLimit({ perMinute: 1 })
  form(this: void): { ok: boolean } {
    return { ok: true };
  }

  @Post("api/limited")
  @PublicRateLimit({ perMinute: 1 })
  api(this: void): { ok: boolean } {
    return { ok: true };
  }
}

const tooManyRequests = vi.fn((acceptLanguage: string | undefined) =>
  Promise.resolve(`<p>refused in ${acceptLanguage ?? "no language"}</p>`),
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

afterAll(async () => {
  await app.close();
});

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
    expect(refused.body).toBe("<p>refused in en-GB,en;q=0.9</p>");
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
    tooManyRequests.mockRejectedValueOnce(new Error("database is down"));

    const refused = await refusedAt("/en-sida/kontakt");

    // A refusal, not a server fault, and nothing of the failure in the body.
    expect(refused.statusCode).toBe(429);
    expect(refused.body).toBe("");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
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
