import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import {
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

describe("a not-found page that cannot be rendered", () => {
  it("answers 404 and logs the failure without its message", async () => {
    // The renderer reads the association's own data to draw the page, so what
    // it throws can carry that data, and a log keeps what it is given (ADR
    // 0007).
    const webRoot = mkdtempSync(join(tmpdir(), "openbrf-web-"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    const moduleRef = await Test.createTestingModule({}).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    const logged: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join("\n"));
      });

    try {
      await serveSinglePageApp(app, webRoot, () =>
        Promise.reject(new Error("No page for anna@example.se")),
      );
      await app.init();
      const server = app.getHttpAdapter().getInstance();
      await server.ready();

      const response = await server.inject({ method: "GET", url: "/stadgar" });

      expect(response.statusCode).toBe(404);
      const log = logged.join("\n");
      expect(log).toContain("could not be rendered: Error");
      expect(log).not.toContain("anna@example.se");
    } finally {
      spy.mockRestore();
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
