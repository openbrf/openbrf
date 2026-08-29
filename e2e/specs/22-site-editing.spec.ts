import { randomUUID } from "node:crypto";

import {
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { expect, stack, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The board writing the association's own website.
 *
 * Not one of the numbered exit criteria. It is here because the page editor is
 * the one screen whose output is served to people with no account, and three
 * of its properties cannot be seen from the screen itself: that what the board
 * previewed is what the website serves, that publishing is refused while the
 * text carries a personal identity number, and that a claimed instance links a
 * privacy notice from the footer of every page it publishes.
 *
 * This spec navigates the instance root, which the guard in
 * 93-public-site.spec.ts allows it by name: reading the published page on the
 * website is the assertion, and the website really is at the root.
 */

test.describe.configure({ mode: "serial" });

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse: the scan runs the anchored validator over unanchored candidates
 * precisely so that an invoice number does not stop a board publishing.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

const PREVIEW_FRAME =
  'iframe[title="Sidan som webbplatsen skulle servera den"]';

/**
 * One address per test, which is what the shared fixture already gives it.
 *
 * Every test below acts as one person - the administrator, who holds
 * site:manage - so the test's own address is the only one needed. The
 * authentication endpoints allow twenty requests a minute per address, and one
 * browser sign-in that lands on a screen costs about five of them, because
 * every guarded route reads the session on the way.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * A request context carrying no session at all.
 *
 * The browser's own context is signed in as the board, and its request object
 * carries those cookies. Reading the published page through it would prove
 * that the board can read it, which is not the question.
 */
async function anonymousRequest(
  clientAddress: string,
): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: { "x-forwarded-for": clientAddress },
  });
}

/** Creates a page from the new-page panel and leaves its editor open. */
async function createPage(
  page: Page,
  input: { title: string; slug: string },
): Promise<void> {
  const panel = page.locator("section").filter({ hasText: "Ny sida" });
  await panel.getByLabel("Rubrik").fill(input.title);
  await panel.getByLabel(/^Adress/).fill(input.slug);
  await panel.getByRole("button", { name: "Skapa sidan" }).click();

  // The editor opens on the page that was just written.
  await expect(page.getByRole("button", { name: "Publicera" })).toBeVisible();
}

test("the board writes a page, previews it, and publishes it to the website", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  const slug = `trapphuset-${randomUUID().slice(0, 8)}`;
  const sentence = `Trapphuset städas varje tisdag, ${slug}.`;

  await page.goto(appPath("/admin/site"));
  await expect(
    page.getByRole("heading", { name: "Föreningens webbplats" }),
  ).toBeVisible();

  await createPage(page, { title: "Trapphuset", slug });

  // The warning about special-category free text stands on the editor whether
  // or not anything is wrong with what has been written.
  await expect(page.getByText(/namngiven persons hälsa/i)).toBeVisible();

  await page.getByRole("button", { name: "Lägg till ett stycke" }).click();
  await page.getByLabel("Stycke 1").fill(sentence);

  await page.getByRole("button", { name: "Förhandsgranska" }).click();

  /*
   * The preview is the server's own rendering, handed to a sandboxed frame as
   * a document rather than as an address. Asserting on what was handed over
   * asserts exactly the property: there is no second renderer in the browser,
   * so what is in the frame is what a visitor would be served.
   */
  const frame = page.locator(PREVIEW_FRAME);
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute("srcdoc")).toContain(sentence);

  await page.getByRole("button", { name: "Publicera" }).click();
  await expect(page.getByText("Sparad.")).toBeVisible();

  // And now the website itself, asked by somebody with no account at all.
  const anonymous = await anonymousRequest(clientAddress);
  try {
    const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain(sentence);
    expect(body.includes("<script")).toBe(false);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  } finally {
    await anonymous.dispose();
  }
});

test("publishing is refused while the page carries a personal identity number", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  const slug = `styrelsen-${randomUUID().slice(0, 8)}`;

  await page.goto(appPath("/admin/site"));
  await createPage(page, { title: "Styrelsen", slug });

  await page.getByRole("button", { name: "Lägg till ett stycke" }).click();
  await page
    .getByLabel("Stycke 1")
    .fill(`Ordförande är Anna, ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`);

  // The browser says so before the server has to. That is a courtesy; the
  // refusal below is the control.
  await expect(page.getByText(/ser ut som ett personnummer/i)).toBeVisible();

  await page.getByRole("button", { name: "Publicera" }).click();
  await expect(page.getByText(/innehåller ett personnummer/i)).toBeVisible();

  // Nothing was published, so the website answers as it does for an address
  // with nothing behind it.
  const anonymous = await anonymousRequest(clientAddress);
  try {
    const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(404);
  } finally {
    await anonymous.dispose();
  }
});

test("a claimed instance links its privacy notice from the footer", async ({
  page,
}) => {
  await page.goto("/");

  const notice = page.getByRole("link", { name: "Integritetspolicy" });
  await expect(notice).toBeVisible();

  await notice.click();

  // The fill-in page the instance ships with: the headings a privacy notice has
  // to answer, and no canned text under them.
  await expect(
    page.getByRole("heading", { name: "Integritetspolicy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Vem som är personuppgiftsansvarig" }),
  ).toBeVisible();

  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await page.context().cookies()).toEqual([]);
});
