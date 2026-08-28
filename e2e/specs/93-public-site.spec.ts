import { expect, stack, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureInstance,
  HOUSING_COOPERATIVE,
} from "../src/provision";
import { deletePage, insertPage } from "../src/site";
import { appPath } from "../src/stack";

/**
 * The association's own public website, and the application beside it.
 *
 * Not one of the numbered exit criteria. It is here because everything this
 * spec asserts is invisible from a screen and is exactly what a housing
 * cooperative is promising the people who read its website: that reading a page
 * about the recycling room does not run anyone's code, does not put a cookie in
 * the reader's browser, and does not tell a single other company that they were
 * here. Those are properties of the whole deployed instance, and this is the
 * only place they can be checked as such.
 *
 * The other half is the move: the client lives under /app now, and the root
 * belongs to the website. A spec that only used the client's own URLs would
 * pass with the two silently swapped.
 */

test.describe.configure({ mode: "serial" });

test("the root serves the association's own page, with no script and no cookie", async ({
  api: request,
}) => {
  await ensureInstance(request);

  const response = await request.get(`${stack.baseUrl}/`, {
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toContain("text/html");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  // No script-src at all, so the policy refuses every script: the promise is
  // enforced by the browser rather than only true of what we wrote.
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["vary"]).toContain("cookie");
  // The website never starts a session. A public page that set a cookie would
  // be a public page that tracks its readers.
  expect(headers["set-cookie"]).toBeUndefined();

  const body = await response.text();
  expect(body.startsWith("<!doctype html>")).toBe(true);
  // The page the setup wizard wrote when the instance was claimed.
  expect(body).toContain(HOUSING_COOPERATIVE.name);
  expect(body.includes("<script")).toBe(false);
});

test("a visitor's browser reaches nothing but this instance", async ({
  page,
  context,
}) => {
  const requested: string[] = [];
  page.on("request", (outgoing) => {
    requested.push(outgoing.url());
  });

  await page.goto("/");
  await expect(page.getByText(HOUSING_COOPERATIVE.name).first()).toBeVisible();

  // Every subresource the page pulled - the typefaces above all, which is the
  // one that would silently become a third-party request if the stylesheet
  // named a font host.
  expect(requested.length).toBeGreaterThan(0);
  for (const url of requested) {
    expect(url.startsWith(stack.baseUrl), url).toBe(true);
  }

  // Nothing ran, and nothing was stored.
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await context.cookies()).toEqual([]);
});

test("a member-only page is indistinguishable from one that does not exist", async ({
  browser,
  clientAddress,
}) => {
  const memberPage = await insertPage({ visibility: "MEMBER" });

  try {
    // One language for both, because the page is rendered in the visitor's own
    // and two different languages would differ for a reason that is not the one
    // under test.
    const anonymous = await browser.newContext({
      baseURL: stack.baseUrl,
      locale: "sv-SE",
      extraHTTPHeaders: { "x-forwarded-for": clientAddress },
    });

    const closed = await anonymous.request.get(
      `${stack.baseUrl}/${memberPage.slug}`,
      { failOnStatusCode: false },
    );
    const missing = await anonymous.request.get(
      `${stack.baseUrl}/en-sida-som-aldrig-skrivits`,
      { failOnStatusCode: false },
    );

    expect(closed.status()).toBe(404);
    expect(missing.status()).toBe(404);
    // Byte for byte. This is the whole guarantee: an anonymous visitor cannot
    // learn that the association has a page at this address at all.
    expect(await closed.text()).toBe(await missing.text());
    expect(closed.headers()["set-cookie"]).toBeUndefined();
    expect((await closed.text()).includes(memberPage.title)).toBe(false);

    await anonymous.close();

    // And the same address, to someone signed in.
    const member = await browser.newContext({
      baseURL: stack.baseUrl,
      locale: "sv-SE",
      extraHTTPHeaders: { "x-forwarded-for": clientAddress },
    });
    await member.request.post(`${stack.baseUrl}/api/auth/sign-in/email`, {
      data: {
        email: ADMINISTRATOR.email,
        password: ADMINISTRATOR.password,
      },
      failOnStatusCode: true,
    });

    const opened = await member.request.get(
      `${stack.baseUrl}/${memberPage.slug}`,
      { failOnStatusCode: false },
    );
    expect(opened.status()).toBe(200);
    const body = await opened.text();
    expect(body).toContain(memberPage.title);
    expect(body).toContain(memberPage.paragraph);
    // Reading a member page reads the session; it never writes one.
    expect(opened.headers()["set-cookie"]).toBeUndefined();

    await member.close();
  } finally {
    await deletePage(memberPage.slug);
  }
});

test("the application answers under its own prefix", async ({
  page,
  api: request,
}) => {
  // The move is what everything else in this file depends on: if the client
  // still owned the root, every assertion above would be about the client.
  const index = await request.get(`${stack.baseUrl}${appPath()}`, {
    failOnStatusCode: false,
  });
  expect(index.status()).toBe(200);
  expect(await index.text()).toContain("<!doctype html>");

  await page.goto(appPath("/sign-in"));
  await expect(
    page.getByRole("button", { name: "Logga in med en nyckel" }),
  ).toBeVisible();

  // A page address that merely begins with the prefix is the website's, not the
  // client's - the association may well publish one.
  const lookalike = await request.get(`${stack.baseUrl}/application-form`, {
    failOnStatusCode: false,
  });
  expect(lookalike.status()).toBe(404);
  expect(lookalike.headers()["content-type"]).toContain("text/html");
  expect((await lookalike.text()).includes("<script")).toBe(false);
});
