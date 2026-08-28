import { createHash } from "node:crypto";

import {
  test as base,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { stack } from "./stack";

/**
 * Shared fixtures.
 *
 * The one that needs explaining is `clientAddress`. Better Auth rate-limits its
 * endpoints to twenty requests a minute per client, and identifies the client
 * by the X-Forwarded-For header, because a deployed instance sits behind a
 * reverse proxy that sets it. Every request in a suite run comes from one host,
 * so without this the suite would throttle itself and read as flaky.
 *
 * Giving each test its own address is not a way around the limit: the limit is
 * per client, and each test is a different member of the housing cooperative
 * signing in from their own home. The stack under test publishes on loopback
 * only and has nothing in front of it, so nothing else is affected.
 */

/** A stable address per test, so a retry lands in the same bucket. */
function addressFor(testId: string): string {
  const digest = createHash("sha256").update(testId).digest();
  // 10.0.0.0/8 is private, and the first octet is fixed so the addresses are
  // recognisable in a log.
  return `10.${String(digest[0]!)}.${String(digest[1]!)}.${String((digest[2]! % 254) + 1)}`;
}

export const test = base.extend<{
  clientAddress: string;
  context: BrowserContext;
  page: Page;
  api: APIRequestContext;
}>({
  // The browser name is part of the address so that a second browser project,
  // were one added, would not share a rate-limit bucket with this one.
  clientAddress: async ({ browserName }, use, testInfo) => {
    await use(
      addressFor(`${browserName}::${testInfo.file}::${testInfo.title}`),
    );
  },

  context: async ({ browser, clientAddress }, use) => {
    const context = await browser.newContext({
      baseURL: stack.baseUrl,
      extraHTTPHeaders: { "x-forwarded-for": clientAddress },
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },

  /**
   * An API context with its own cookie jar, separate from the browser's, so a
   * spec can act as the board over HTTP while the page is signed in as someone
   * else.
   */
  api: async ({ clientAddress }, use) => {
    const context = await playwrightRequest.newContext({
      baseURL: stack.baseUrl,
      extraHTTPHeaders: { "x-forwarded-for": clientAddress },
    });
    await use(context);
    await context.dispose();
  },
});

export { expect } from "@playwright/test";
export { stack };
