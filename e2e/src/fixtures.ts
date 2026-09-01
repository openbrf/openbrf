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
 * The one that needs explaining is `clientAddress`. Better Auth counts its
 * endpoints per client and per path, and identifies the client by the
 * X-Forwarded-For header, because a deployed instance sits behind a reverse
 * proxy that sets it. A sign-in attempt is counted tightly, guessing a password
 * being what that budget is for, and every request in a suite run comes from
 * one host - so without this the suite would spend one test's attempts on
 * another's and read as flaky.
 *
 * Giving each test its own address is not a way around the limit: the limit is
 * per client, and each test is a different member of the housing cooperative
 * signing in from their own home. The stack under test publishes on loopback
 * only and has nothing in front of it, so nothing else is affected.
 */

/** A stable address per seed, so a retry lands in the same bucket. */
function addressFor(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  // 10.0.0.0/8 is private, and the first octet is fixed so the addresses are
  // recognisable in a log.
  return `10.${String(digest[0]!)}.${String(digest[1]!)}.${String((digest[2]! % 254) + 1)}`;
}

/**
 * A second address, for somebody else acting in the same test.
 *
 * One test is usually one person, and the address above is theirs. A test about
 * two people - somebody who has no account yet and the board member deciding
 * their request - is two clients, and giving them one address between them
 * spends one person's sign-in attempts on the other's until the instance
 * refuses one the test is asserting on.
 *
 * The same argument as the address above, not a way around it: the limit is per
 * client, and an applicant activating their account really is somewhere else
 * from the board member who approved it. Derived from the test's own address so
 * two tests never share a persona's bucket either.
 */
export function clientAddressFor(testAddress: string, persona: string): string {
  return addressFor(`${testAddress}::${persona}`);
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
      /*
       * The visitor is Swedish, because half the instance answers in the
       * visitor's own language and the other half does not.
       *
       * The application is Swedish whatever this says - the client initialises
       * i18next with a fixed language and reads no header - but the
       * association's public website chooses from Accept-Language, and
       * Playwright's default would make its chrome English while the page's own
       * text stayed Swedish, because site content is monolingual and stored as
       * written. A spec reading the website through this context would then be
       * asserting against a browser that is lying about who is visiting.
       *
       * The screenshot capture already sets this, for exactly this reason. This
       * is the same instrument, on the suite that drives the same site.
       */
      locale: "sv-SE",
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
