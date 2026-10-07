import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  APP_CONTENT_SECURITY_POLICY,
  isApiRequest,
  isAppRequest,
  serveSinglePageApp,
} from "./serve-single-page-app";

/**
 * The wildcard route this decides for is the last thing a request meets, so a
 * wrong answer is silent: an API path gets the client's index.html with a 200
 * instead of the JSON 404 an integration reads, and a client route gets a JSON
 * body instead of the screen.
 */
describe("isApiRequest", () => {
  it("claims the API paths", () => {
    expect(isApiRequest("/health")).toBe(true);
    expect(isApiRequest("/api")).toBe(true);
    expect(isApiRequest("/api/address-book")).toBe(true);
  });

  it("claims them with a query string as well", () => {
    // The request URL carries the query string, so a decision made on the whole
    // of it answers differently for the same path.
    expect(isApiRequest("/health?probe=1")).toBe(true);
    expect(isApiRequest("/api?x=1")).toBe(true);
    expect(isApiRequest("/api/address-book?search=Berg")).toBe(true);
    expect(isApiRequest("/api#fragment")).toBe(true);
  });

  it("leaves the client's own routes to the client", () => {
    expect(isApiRequest("/")).toBe(false);
    expect(isApiRequest("/app")).toBe(false);
    expect(isApiRequest("/app/settings")).toBe(false);
    expect(isApiRequest("/app/settings?panel=email")).toBe(false);
  });

  it("does not claim a path that merely begins with the same letters", () => {
    expect(isApiRequest("/apiary")).toBe(false);
    expect(isApiRequest("/healthcheck")).toBe(false);
  });
});

/**
 * The other half of the same decision, and the one that decides between the
 * client and the association's own website.
 *
 * The prefix has to match a whole path segment. A housing cooperative may well
 * publish
 * a page at /apple or /application-form, and answering either with the client's
 * index.html would take a published page off its website with no error
 * anywhere.
 */
describe("isAppRequest", () => {
  it("claims the client's prefix and everything under it", () => {
    expect(isAppRequest("/app")).toBe(true);
    expect(isAppRequest("/app/")).toBe(true);
    expect(isAppRequest("/app/settings")).toBe(true);
    expect(isAppRequest("/app/activate?token=abc")).toBe(true);
  });

  it("claims it with a query string or a fragment as well", () => {
    expect(isAppRequest("/app?x=1")).toBe(true);
    expect(isAppRequest("/app#top")).toBe(true);
  });

  it("does not claim a page whose address merely begins the same way", () => {
    expect(isAppRequest("/apple")).toBe(false);
    expect(isAppRequest("/application-form")).toBe(false);
    expect(isAppRequest("/appar")).toBe(false);
  });

  it("leaves the website's own addresses alone", () => {
    expect(isAppRequest("/")).toBe(false);
    expect(isAppRequest("/hem")).toBe(false);
    expect(isAppRequest("/api/address-book")).toBe(false);
  });
});

describe("the client's page", () => {
  let app: NestFastifyApplication;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), "openbrf-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><div id=root>");
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await serveSinglePageApp(app, webRoot);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it.each(["/app", "/app/settings/profile", "/app/index.html", "/app/x?y=1"])(
    "carries the policy at %s",
    async (url) => {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(
        APP_CONTENT_SECURITY_POLICY,
      );
    },
  );

  it("keeps the policy off paths outside the app", async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/api/x" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("runs only this origin's scripts and is framed by nobody", () => {
    const directives = new Map(
      APP_CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
        const [name = "", ...values] = directive.split(" ");
        return [name, values.join(" ")] as const;
      }),
    );

    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    // No way back to a script through an exemption.
    expect(APP_CONTENT_SECURITY_POLICY).not.toMatch(
      /unsafe-eval|script-src[^;]*unsafe-inline|\*/,
    );
  });
});
