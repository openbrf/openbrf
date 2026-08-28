import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The theme routes, through the real guard, routing and exception filter.
 *
 * What renders is deliberately public: the sign-in screen is themed, and nobody
 * has a session there. That makes the risk here specific and worth a suite of
 * its own - `@Public()` sits on one controller while two others share its
 * `api/themes` prefix, and a leak would turn installing and activating a theme
 * into something an anonymous request could do.
 *
 * So every assertion below is about the boundary, not the behaviour: the two
 * public routes answer without a session, and every route that changes the
 * instance refuses one.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * The auth rate limiter buckets by forwarded address, so a repeat would make
 * one suite's requests count against another's budget. 10.6.0.0/16 is this
 * suite's; the other integration suites each hold their own second octet.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.6.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  payload?: object;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: { "x-forwarded-for": nextForwardedFor() },
    });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

describe("what an anonymous request may read", () => {
  it("serves the active theme, because the sign-in screen is themed too", async () => {
    const response = await inject({ method: "GET", url: "/api/themes/active" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      modes: { light: Record<string, string> };
      viewVariants: Record<string, string>;
    }>();
    expect(body.modes.light["surface-register"]).toMatch(/^#/);
    expect(body.viewVariants["memberRegister"]).toBe("table");
  });

  it("answers nothing for an asset of a theme that is not installed", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/themes/asset?theme=not-installed&file=fonts/x.woff2",
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses an asset path that is not one a package may contain", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/themes/asset?theme=not-installed&file=../../../etc/passwd",
    });
    // Refused before anything touches the filesystem: the query schema and the
    // package path rules both reject it, and the store checks containment again.
    expect([400, 404]).toContain(response.statusCode);
  });
});

describe("what an anonymous request may not do", () => {
  it("refuses every route that reads or changes the instance's themes", async () => {
    const routes = [
      { method: "GET" as const, url: "/api/themes/installed" },
      { method: "GET" as const, url: "/api/themes/catalog" },
      {
        method: "GET" as const,
        url: "/api/themes/installed/example-theme/preview",
      },
      {
        method: "POST" as const,
        url: "/api/themes/install",
        payload: { id: "example-theme" },
      },
      {
        method: "POST" as const,
        url: "/api/themes/activate",
        payload: { id: "example-theme" },
      },
      {
        method: "DELETE" as const,
        url: "/api/themes/installed/example-theme",
      },
    ];

    for (const route of routes) {
      const response = await inject(route);
      expect(
        [401, 403],
        `${route.method} ${route.url} was not refused`,
      ).toContain(response.statusCode);
    }
  });
});
