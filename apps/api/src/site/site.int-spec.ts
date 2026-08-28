import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The association's public website, through the real routing, guard and
 * exception filter.
 *
 * Everything asserted here is a promise to someone who has no account and never
 * will: a broker, a prospective buyer, a neighbour. The promises are that the
 * website sets no cookie, that it publishes no personal data, and that a page
 * they may not read is answered exactly like a page that was never written -
 * because if it were not, the 404 itself would tell them the page exists.
 *
 * Route ranking is the other half. One container serves the API, the client and
 * the website, and the website's page route carries a parameter that would
 * happily match /health or /api if Fastify ranked it above the static paths. It
 * does not, and this suite is where that is pinned rather than assumed.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const member = {
  personId: `site-member-${suffix}`,
  email: `site-member-${suffix}@exempel.se`,
};
const publicSlug = `site-public-${suffix}`;
const memberSlug = `site-member-page-${suffix}`;

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * The auth rate limiter buckets by forwarded address, so a repeat would make
 * one suite's requests count against another's budget. 10.9.0.0/16 is this
 * suite's; the other integration suites each hold their own second octet.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.9.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        // Fixed, so two responses compared for equality were rendered in the
        // same language and differ only where the test says they do.
        "accept-language": "sv-SE,sv;q=0.9",
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
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

  prisma = app.get(PrismaService);

  // A claimed instance: the root redirects an unclaimed one to the wizard, and
  // that is a different test.
  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  const encryption = app.get(FieldEncryptionService);
  const email = await encryption.encrypt("person.email", member.email);
  await prisma.person.create({
    data: {
      id: member.personId,
      firstName: "Signe",
      lastName: "Medlem",
      emailCipher: email.cipher,
      emailIndex: email.index,
      // A personal identity number on the person whose session reads the
      // member page. If the rendering path could reach the register at all,
      // this is the value that would show up in a page body.
      personalIdentityNumberCipher: (
        await encryption.encrypt(
          "person.personalIdentityNumber",
          "19850312-4527",
        )
      ).cipher,
    },
  });
  await app.get(AuthService).createAccountForPerson({
    personId: member.personId,
    email: member.email,
    name: "Signe Medlem",
    password: PASSWORD,
  });

  await prisma.page.createMany({
    data: [
      {
        slug: publicSlug,
        title: "Om föreningen",
        content: {
          version: 1,
          blocks: [{ type: "paragraph", text: "Föreningen bildades 1948." }],
        },
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 0,
      },
      {
        slug: memberSlug,
        title: "Styrelseprotokoll",
        content: {
          version: 1,
          blocks: [{ type: "paragraph", text: "Endast för medlemmar." }],
        },
        visibility: "MEMBER",
        published: true,
        publishedAt: new Date(),
        sortOrder: 1,
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await prisma?.page.deleteMany({
    where: { slug: { in: [publicSlug, memberSlug] } },
  });
  await prisma?.user.deleteMany({ where: { personId: member.personId } });
  await prisma?.person.deleteMany({ where: { id: member.personId } });
  await app?.close();
});

describe("what an anonymous visitor gets", () => {
  it("serves the front page as plain HTML", async () => {
    const response = await inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body.startsWith("<!doctype html>")).toBe(true);
    expect(response.body).toContain("Om föreningen");
    expect(response.body).toContain("Brf Eksemplet");
  });

  it("carries the headers that keep a page from doing anything", async () => {
    const response = await inject({ method: "GET", url: `/${publicSlug}` });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'",
    );
    expect(response.headers["cache-control"]).toBe("no-cache");
    // A member page answers differently to a visitor with a session, so a cache
    // that ignored the cookie would serve one visitor's page to another.
    expect(response.headers["vary"]).toBe("cookie");
  });

  it("sets no cookie on any response the website makes", async () => {
    for (const url of ["/", `/${publicSlug}`, `/${memberSlug}`, "/ingenting"]) {
      const response = await inject({ method: "GET", url });
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
  });

  it("runs no script", async () => {
    const response = await inject({ method: "GET", url: `/${publicSlug}` });

    expect(response.body.includes("<script")).toBe(false);
    expect(/\son[a-z]+=/i.test(response.body)).toBe(false);
  });

  it("names no host but this one", async () => {
    const response = await inject({ method: "GET", url: `/${publicSlug}` });

    // The typefaces are the risk: a stylesheet naming a font host would
    // disclose every visitor's address to that host on every page view.
    expect(/(?:src|href|url\()\s*"?https?:/i.test(response.body)).toBe(false);
  });
});

describe("what a page nobody may read looks like", () => {
  it("is byte-identical to a page that was never written", async () => {
    const closed = await inject({ method: "GET", url: `/${memberSlug}` });
    const missing = await inject({
      method: "GET",
      url: "/en-sida-som-inte-finns",
    });

    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // The whole guarantee, in one assertion. Anything that made these two
    // differ - a title, a length, a header - would tell an anonymous visitor
    // that the association has a page at that address.
    expect(closed.body).toBe(missing.body);
    expect(closed.body.includes("Styrelseprotokoll")).toBe(false);
  });

  it("is the one document the catch-all route answers with too", async () => {
    /*
     * The route that claims every path no controller wanted is registered on
     * the Fastify instance from main.ts, not by a module, so it does not exist
     * in this graph - a path of two segments reaches Nest's own not-found
     * handler here. What CAN be pinned here is the thing that would actually
     * break: main.ts answers that route by calling SiteRenderer.notFound, the
     * same call this controller makes, and a second renderer appearing on
     * either side is what would let an anonymous visitor tell a member-only
     * page from a missing one. So the renderer is asked directly and compared
     * with what the route sent.
     *
     * The deployed composition - a deep path, a traversal shape and a file
     * name at the root all answering with this document - is proved against
     * the real image in 91-startup-and-connection-urls and 93-public-site.
     */
    const missing = await inject({
      method: "GET",
      url: "/en-sida-som-inte-finns",
    });

    expect(missing.statusCode).toBe(404);
    expect(await app.get(SiteRenderer).notFound("sv-SE,sv;q=0.9")).toBe(
      missing.body,
    );
  });

  it("opens for a signed-in member", async () => {
    const cookie = await signIn(member.email);
    expect(cookie).not.toBe("");

    const response = await inject({
      method: "GET",
      url: `/${memberSlug}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Styrelseprotokoll");
    expect(response.body).toContain("Endast för medlemmar.");
    // Reading the session must never write one back onto the reply: Better
    // Auth can refresh a session row on a read, and copying its headers here
    // would turn the public website into something that sets cookies.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});

describe("what the website may never publish", () => {
  it("puts no personal identity number on any page it serves", async () => {
    const cookie = await signIn(member.email);

    // The shape, not the value: the assertion has to fail for any personnummer,
    // including one nothing in this suite wrote. The public rendering path
    // imports nothing from the registers, the address book or the encryption
    // layer, and this is what holds that true as the code changes.
    const personalIdentityNumber = /\b(?:19|20)?\d{6}[-+]?\d{4}\b/;

    for (const [url, headers] of [
      ["/", {}],
      [`/${publicSlug}`, {}],
      [`/${memberSlug}`, { cookie }],
      ["/ingenting", {}],
    ] as const) {
      const response = await inject({ method: "GET", url, headers });
      expect(personalIdentityNumber.test(response.body), url).toBe(false);
    }
  });
});

describe("what the website must never claim", () => {
  it("leaves the API's own paths to the API", async () => {
    /*
     * Route ranking: a static path beats the page parameter, and the parameter
     * beats the client's wildcard. "/api" has no static route of its own, so
     * the page route is what sees it - and hands it straight back, which is
     * what keeps it answering JSON to an integration rather than the website's
     * HTML. The query string is part of the request URL and no part of that
     * decision.
     *
     * One segment only. A deeper API path matches no route in this graph and
     * is answered by the catch-all main.ts registers, which is proved against
     * the real image in 91-startup-and-connection-urls.
     */
    for (const url of ["/api", "/api?probe=1"]) {
      const response = await inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ reason: "not-found" });
    }
  });

  it("leaves the liveness probe alone", async () => {
    const response = await inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("cannot be reached at an address a page may not have", async () => {
    for (const url of [
      "/Stora-Bokstaver",
      "/index.html%00.png",
      "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ]) {
      const response = await inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers["content-type"], url).toContain("text/html");
    }
  });
});
