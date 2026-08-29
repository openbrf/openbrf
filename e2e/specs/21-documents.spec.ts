import { request as playwrightRequest, type Page } from "@playwright/test";

import { documentFixture, documentNamed, readArchive } from "../src/documents";
import { expect, stack, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The document archive, per audience.
 *
 * Not one of the numbered exit criteria. It is here because the promise the
 * archive makes cannot be seen from any one screen: the same document is on
 * one person's shelf, absent from another's, and fetchable by a visitor with
 * no account at all - and which of those is true is decided by the instance,
 * not by the interface. The only way to hold it to that is to ask as each of
 * them in turn, and to ask for the file itself rather than only for the list.
 *
 * The public case is deliberately an API probe. The document list block on the
 * association's website arrives with the page editor; what exists today is the
 * file, at its own address, and this spec must not navigate the instance root
 * (the guard in 93-public-site.spec.ts).
 */

test.describe.configure({ mode: "serial" });

/**
 * Two people on apartment 1001 of Storgatan 12, out of the shared register
 * fixture: the member who holds the tenant-ownership, and a resident who holds
 * none. Not every resident is a member, which is the whole distinction the
 * member shelf rests on.
 *
 * The password is the one the invitation spec sets on these two accounts.
 * Nothing in the suite can change a password, so a second one here would only
 * fail to sign in.
 */
const PASSWORD = "granngarden-kastanj-2026";

const MEMBER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

const MINUTES = documentFixture({
  title: "Stämmoprotokoll",
  category: "Protokoll",
});
const BYLAWS = documentFixture({ title: "Stadgar", category: "Stadgar" });

async function signIn(
  page: Page,
  who: { email: string; password: string },
): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(who.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * Fills the filing form and submits it.
 *
 * The audience is chosen after the binder on purpose: choosing the minutes
 * binder takes a document off the public shelf, so an answer given before it
 * would be overwritten - which is the guardrail, and which the first test
 * below asserts directly.
 */
async function fileDocument(
  page: Page,
  document: {
    title: string;
    category: string;
    fileName: string;
    bytes: Buffer;
  },
  audience: string,
): Promise<void> {
  await page.getByLabel("Titel").fill(document.title);
  await page.getByLabel("Pärm").fill(document.category);
  await page
    .getByRole("group", { name: "Vem det är till för" })
    .getByRole("radio", { name: new RegExp(`^${audience}`) })
    .check();
  await page.getByLabel("Fil", { exact: true }).setInputFiles({
    name: document.fileName,
    mimeType: "application/pdf",
    buffer: document.bytes,
  });
  await page.getByRole("button", { name: "Lägg in dokumentet" }).click();
  await expect(page.getByText("Dokumentet ligger i arkivet.")).toBeVisible();
}

test("the board files a set of minutes, and the interface keeps them off the street", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signIn(page, ADMINISTRATOR);

  await page.goto(appPath("/documents"));
  await expect(
    page.getByRole("heading", { name: "Dokumentarkiv" }),
  ).toBeVisible();

  const audience = page.getByRole("group", { name: "Vem det är till för" });

  // The audience a document gets when nobody has said otherwise.
  await expect(
    audience.getByRole("radio", { name: /^Medlemmar/ }),
  ).toBeChecked();

  // Publishing chosen first, and then the minutes binder, which takes it back.
  await audience.getByRole("radio", { name: /^Publicerat/ }).check();
  await page.getByLabel("Pärm").fill("Protokoll");
  await expect(
    audience.getByRole("radio", { name: /^Medlemmar/ }),
  ).toBeChecked();
  await expect(
    page.getByText(/Protokoll stannar hos medlemmarna/),
  ).toBeVisible();

  await page.getByLabel("Titel").fill(MINUTES.title);
  await page.getByLabel("Fil", { exact: true }).setInputFiles({
    name: MINUTES.fileName,
    mimeType: "application/pdf",
    buffer: MINUTES.bytes,
  });
  await page.getByRole("button", { name: "Lägg in dokumentet" }).click();
  await expect(page.getByText("Dokumentet ligger i arkivet.")).toBeVisible();

  await expect(
    page.getByRole("link", { name: `Öppna ${MINUTES.title}` }),
  ).toBeVisible();
});

test("the board publishes the bylaws deliberately", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signIn(page, ADMINISTRATOR);
  await page.goto(appPath("/documents"));

  await fileDocument(page, BYLAWS, "Publicerat");

  await expect(
    page.getByRole("link", { name: `Öppna ${BYLAWS.title}` }),
  ).toBeVisible();
});

test("a member sees the minutes; a resident who is not a member does not", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureRegisterFixture(request);

  for (const who of [MEMBER, RESIDENT]) {
    const personId = people.get(who.name);
    expect(personId, `${who.name} is not in the register`).toBeDefined();
    await ensureAccountFor(request, {
      personId: personId as string,
      email: who.email,
      password: who.password,
      clientAddress,
    });
  }

  await signIn(page, MEMBER);
  await page.goto(appPath("/documents"));
  await expect(
    page.getByRole("link", { name: `Öppna ${MINUTES.title}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Öppna ${BYLAWS.title}` }),
  ).toBeVisible();
  // Reading the archive is not managing it.
  await expect(
    page.getByRole("heading", { name: "Lägg in ett dokument" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(
    page.getByRole("button", { name: "Logga in", exact: true }),
  ).toBeVisible();

  await signIn(page, RESIDENT);
  await page.goto(appPath("/documents"));
  await expect(
    page.getByRole("link", { name: `Öppna ${BYLAWS.title}` }),
  ).toBeVisible();
  // Not every resident is a member, and the minutes of a general meeting are
  // the members'.
  await expect(
    page.getByRole("link", { name: `Öppna ${MINUTES.title}` }),
  ).toHaveCount(0);
});

test("a published document is fetched by a visitor with no account, and the member one is not", async ({
  api: request,
}) => {
  await ensureRegisterFixture(request);

  const shelf = await readArchive(request);
  const bylaws = documentNamed(shelf, BYLAWS.title);
  const minutes = documentNamed(shelf, MINUTES.title);
  expect(bylaws, "the bylaws are not in the archive").toBeDefined();
  expect(minutes, "the minutes are not in the archive").toBeDefined();
  expect(bylaws?.audience).toBe("PUBLIC");
  expect(minutes?.audience).toBe("MEMBER");

  /*
   * A context of its own, with no cookie jar of the suite's: the question is
   * what a broker or a prospective buyer gets, and a session left over from
   * the board would answer a different one.
   */
  const visitor = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
  });
  try {
    const published = await visitor.get(
      `${stack.baseUrl}${bylaws?.url ?? ""}`,
      { failOnStatusCode: false },
    );
    expect(published.status()).toBe(200);
    expect(published.headers()["content-type"]).toBe("application/pdf");
    // The media route is shared with the association's logo on the public
    // website. Serving a file to the street must not start a session.
    expect(published.headers()["set-cookie"]).toBeUndefined();
    expect(await published.body()).toEqual(BYLAWS.bytes);

    const closed = await visitor.get(`${stack.baseUrl}${minutes?.url ?? ""}`, {
      failOnStatusCode: false,
    });
    const missing = await visitor.get(
      `${stack.baseUrl}/api/media/en-fil-som-aldrig-funnits`,
      { failOnStatusCode: false },
    );
    // Byte for byte: an anonymous caller cannot learn that the association
    // holds a file at this address at all.
    expect(closed.status()).toBe(404);
    expect(await closed.text()).toBe(await missing.text());
  } finally {
    await visitor.dispose();
  }
});
