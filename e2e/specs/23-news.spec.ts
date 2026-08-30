import { request as playwrightRequest } from "@playwright/test";

import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import {
  clearMailbox,
  expectNoMessage,
  listMessages,
  waitForMessage,
} from "../src/mailpit";
import {
  createNews,
  editNews,
  listNews,
  type NewsRow,
  publishNews,
  setPreferredLocale,
} from "../src/news";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * News, and the one thing about it that cannot be seen from a screen.
 *
 * Not one of the numbered exit criteria. It is here because "the members are
 * emailed once, and never again when the notice is corrected" is a promise
 * about the whole deployed instance - the publish transaction, the job queue,
 * the worker and a real mail server - and every part of that is invisible from
 * the interface. The negative case is the point of the file: the board fixes a
 * typo, publishes again, and nothing arrives.
 *
 * The other half is the website. A member-only item must be answered to an
 * anonymous visitor with the document a missing address produces, and a public
 * one must be readable with no account at all.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the invitation spec sets on the shared fixture's accounts.
 * Nothing in the suite can change a password, so a second one here would only
 * fail to sign in.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * Two of the four people the shared register fixture seeds.
 *
 * Astrid holds a tenant-ownership on Storgatan 12, so she is a member and the
 * mailing is hers. Nils lives in the same apartment without holding one: not
 * every resident is a member, and that distinction is what the second
 * assertion in the first test is about.
 */
const MEMBER = {
  name: "Karl Berg",
  email: "karl@eksemplet.test",
  password: PASSWORD,
} as const;

const OTHER_MEMBER = { email: "astrid@eksemplet.test" } as const;
const RESIDENT = { email: "nils@eksemplet.test" } as const;

/** Run-unique so a rerun against a kept stack cannot collide with its own rows. */
const suffix = Date.now().toString(36);
const MEMBER_ITEM = {
  slug: `stamma-${suffix}`,
  title: `Kallelse till stämman ${suffix}`,
  paragraph: `Stämman hålls i tvättstugan den 12 oktober, ${suffix}.`,
} as const;
const PUBLIC_ITEM = {
  slug: `staddag-${suffix}`,
  title: `Städdag ${suffix}`,
  paragraph: `Vi städar gården på lördag, ${suffix}.`,
} as const;

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`. The authentication endpoints are
 * rate-limited per client address and the fixture gives each test one, on the
 * reading that a test is one member signing in from their own home. Karl signs
 * in to say which language he reads, which is a second person and therefore a
 * second address.
 */

test("publishing mails every member once, in the language each of them reads", async ({
  api: request,
  clientAddress,
}) => {
  const people = await ensureRegisterFixture(request);
  await clearMailbox();

  /*
   * Karl reads English. Which language a person is written to in is their own
   * decision, and the only endpoint that records it is their own profile - so
   * this is Karl, in a context of his own, saying so.
   */
  const karlId = people.get(MEMBER.name);
  expect(karlId, `${MEMBER.name} is not in the register`).toBeDefined();
  const karlAddress = clientAddressFor(clientAddress, MEMBER.email);
  await ensureAccountFor(request, {
    personId: karlId as string,
    email: MEMBER.email,
    password: MEMBER.password,
    clientAddress: karlAddress,
  });

  const karl = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: { "x-forwarded-for": karlAddress },
  });
  try {
    await karl.post(`${stack.baseUrl}/api/auth/sign-in/email`, {
      data: { email: MEMBER.email, password: MEMBER.password },
      failOnStatusCode: true,
    });
    await setPreferredLocale(karl, "en");
  } finally {
    await karl.dispose();
  }

  const item = await createNews(request, {
    slug: MEMBER_ITEM.slug,
    title: MEMBER_ITEM.title,
    paragraphs: [MEMBER_ITEM.paragraph],
  });
  const published = await publishNews(request, item.id, {
    published: true,
    visibility: "MEMBER",
    sendEmail: true,
  });

  expect(published.published).toBe(true);
  expect(published.emailQueuedAt).not.toBeNull();
  expect(published.mailedTo).toBeGreaterThanOrEqual(2);

  // Each member, in their own language. The title is the board's own writing
  // and is monolingual; the wording around it is the recipient's.
  const swedish = await waitForMessage(OTHER_MEMBER.email, {
    subjectMatch: new RegExp(MEMBER_ITEM.title),
  });
  expect(swedish.text).toContain("Läs nyheten");
  expect(swedish.text).toContain(MEMBER_ITEM.paragraph);

  const english = await waitForMessage(MEMBER.email, {
    subjectMatch: new RegExp(MEMBER_ITEM.title),
  });
  expect(english.text).toContain("Read the news item");

  // Not every resident is a member, and the mailing is the members'.
  await expectNoMessage(RESIDENT.email);

  // Once each, and once only.
  const delivered = (await listMessages()).filter((message) =>
    message.To.some((to) => to.Address.toLowerCase() === OTHER_MEMBER.email),
  );
  expect(delivered).toHaveLength(1);
});

test("correcting the notice and publishing it again mails nobody", async ({
  api: request,
}) => {
  await ensureRegisterFixture(request);

  const found = (await listNews(request)).find(
    (one) => one.slug === MEMBER_ITEM.slug,
  );
  expect(found, "the news item from the first test is gone").toBeDefined();
  /*
   * Narrowed here rather than read through `?.` below. This test works on what
   * the one above it published, and a broken chain has to fail on the line that
   * says so - not by sending an edit to /api/news//publish and coming back with
   * a 404 about something else.
   */
  const item = found as NewsRow;
  expect(item.emailQueuedAt).not.toBeNull();

  await clearMailbox();

  await editNews(request, item.id, {
    slug: MEMBER_ITEM.slug,
    title: `${MEMBER_ITEM.title} (rättad)`,
    paragraphs: [MEMBER_ITEM.paragraph, "Rättelse: lokalen är ändrad."],
  });

  // Taken down and put up again - the loudest version of "publish it once
  // more" the interface has. The column that says the mailing was claimed is
  // never cleared, so there is no second mailing to make.
  await publishNews(request, item.id, { published: false });
  const again = await publishNews(request, item.id, {
    published: true,
    visibility: "MEMBER",
    sendEmail: true,
  });

  expect(again.published).toBe(true);
  expect(again.mailedTo).toBeNull();

  await expectNoMessage(OTHER_MEMBER.email);
  await expectNoMessage(MEMBER.email);
});

test("the board writes and publishes a news item from its own screen", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);

  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  await page.goto(appPath("/admin/site/news"));
  await expect(
    page.getByRole("heading", { name: "Nyheter", exact: true }),
  ).toBeVisible();

  /*
   * Anchored at the start of each label. A field's <label> wraps its hint as
   * well as its word, so an exact match finds nothing - and a bare substring
   * would match two fields here, because the body's hint explains how to write
   * a subheading and therefore contains the word the first field is called.
   */
  await page.getByLabel(/^Rubrik/).fill(PUBLIC_ITEM.title);
  await page.getByLabel(/^Adress/).fill(PUBLIC_ITEM.slug);
  await page.getByLabel(/^Text/).fill(PUBLIC_ITEM.paragraph);
  await page.getByRole("button", { name: "Spara nyheten" }).click();
  await expect(page.getByText("Nyheten är sparad.")).toBeVisible();

  const item = page.getByRole("article").filter({ hasText: PUBLIC_ITEM.title });
  await expect(item).toBeVisible();

  // Anyone, and no mailing: this one is for the street, and the members were
  // already written to about the meeting.
  await item.getByRole("radio", { name: "Alla", exact: true }).check();
  await item.getByLabel(/^Mejla medlemmarna/).uncheck();
  await item.getByRole("button", { name: "Publicera", exact: true }).click();
  await expect(item.getByText("Nyheten är publicerad.")).toBeVisible();
});

test("the website serves the public item to anyone and hides the members' one", async ({
  page,
  context,
  clientAddress,
}) => {
  // The association's own website is at the root, and this is one of the two
  // specs that reads it there (the allowlist in 93-public-site.spec.ts).
  await page.goto(`/nyheter/${PUBLIC_ITEM.slug}`);
  await expect(
    page.getByRole("heading", { name: PUBLIC_ITEM.title }),
  ).toBeVisible();
  await expect(page.getByText(PUBLIC_ITEM.paragraph)).toBeVisible();

  // Nothing ran, and nothing was stored: the promise the whole website makes,
  // held on the pages this branch added.
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await context.cookies()).toEqual([]);

  await page.goto("/nyheter");
  // The website answers in the visitor's own language, and this browser asks
  // for Swedish. What the board wrote is monolingual either way; this is the
  // chrome around it.
  await expect(
    page.getByRole("heading", { name: "Nyheter", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: PUBLIC_ITEM.title }),
  ).toBeVisible();
  // The members' meeting notice is not on an anonymous visitor's index.
  await expect(page.getByRole("link", { name: MEMBER_ITEM.title })).toHaveCount(
    0,
  );

  /*
   * The refusal, as bytes. A context of its own with no cookie jar of the
   * suite's, and an address of its own - this one signs in nowhere, but a
   * context that sent no forwarded address would share whatever bucket the
   * instance falls back to with every other caller that omitted it.
   */
  const visitor = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "visitor"),
    },
  });
  try {
    const article = await visitor.get(
      `${stack.baseUrl}/nyheter/${PUBLIC_ITEM.slug}`,
      { failOnStatusCode: false },
    );
    expect(article.status()).toBe(200);
    // Reading the association's news never starts a session.
    expect(article.headers()["set-cookie"]).toBeUndefined();

    const closed = await visitor.get(
      `${stack.baseUrl}/nyheter/${MEMBER_ITEM.slug}`,
      { failOnStatusCode: false },
    );
    const missing = await visitor.get(
      `${stack.baseUrl}/nyheter/en-nyhet-som-aldrig-skrivits`,
      { failOnStatusCode: false },
    );
    expect(closed.status()).toBe(404);
    expect(missing.status()).toBe(404);
    // Byte for byte: a visitor cannot learn that the association has written
    // anything at this address at all.
    expect(await closed.text()).toBe(await missing.text());
    expect(closed.headers()["set-cookie"]).toBeUndefined();
  } finally {
    await visitor.dispose();
  }
});
