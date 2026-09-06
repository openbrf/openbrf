import type { Page } from "@playwright/test";

import * as api from "../src/api";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, deliverToMailbox, waitForMessage } from "../src/mailpit";
import { grantBoardSeat } from "../src/board";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The shared board mailbox, end to end.
 *
 * The one thing this suite can prove that nothing below it can: that mail sent
 * to the board's address becomes a thread in the application, that a board
 * member takes it on and answers it in a browser, and that the answer leaves the
 * instance as real mail. Every layer of that is the deployed image - the POP3
 * client, the MIME reader, the job queue, the outbound path - and the only thing
 * standing in for an association's mail provider is mailpit, which speaks both
 * protocols.
 *
 * The inbound message is put into the mailbox through mailpit's own send API
 * rather than through anything in the product. That is deliberate: the
 * application has no test-only endpoint and gains none here, so what is under
 * test is the path a real letter takes - a message sitting in a mailbox, and an
 * instance that collects it.
 *
 * Collecting is driven from the board's own "collect now" control rather than by
 * waiting out the five-minute schedule. That control is the product's, not this
 * suite's: it exists because a board told that somebody has just written should
 * not have to wait, and because an administrator who has just filled in the
 * settings needs to know whether the password works.
 */

test.describe.configure({ mode: "serial" });

/**
 * The board member who works the mailbox.
 *
 * The administrator, who this spec also puts on the board. The shared fixture
 * elects nobody - nothing in the product does - so a board seat is granted the
 * only way the suite can, and giving it to the account that already exists keeps
 * this spec from adding a person to a register nothing can delete from.
 */
const BOARD = ADMINISTRATOR;

/** The address the board publishes. This run's own, like every identity here. */
const BOARD_ADDRESS = uniqueEmail("styrelsen");

/** Somebody outside the association, writing in. */
const CORRESPONDENT = {
  name: "Gunilla Granne",
  address: uniqueEmail("granne"),
} as const;

/**
 * The resident who is offered none of this.
 *
 * Nils holds no tenant-ownership and, unlike the other shared fixture people,
 * collects no roles from earlier specs - which is what makes him the persona for
 * an assertion about what a plain resident is not shown.
 *
 * The password is the one the invitation spec sets on the shared fixture's
 * accounts. Nothing in the suite can change a password, so a second one here
 * would only fail to sign in.
 */
const RESIDENT = {
  fullName: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: "granngarden-kastanj-2026",
} as const;

const SUBJECT = `Vattenläcka i tvättstugan ${uniqueSurname("arende")}`;
const LETTER =
  "Hej styrelsen,\n\nDet rinner vatten på golvet i tvättstugan. Kan ni titta på det?\n\nHälsningar Gunilla";
const ANSWER =
  "Hej Gunilla, tack för att du hörde av dig. Vi har beställt en rörmokare till på torsdag.";

/**
 * Puts this browser on the board member's own client address.
 *
 * The sign-in endpoints are rate-limited per client address, and this spec signs
 * one person in across several tests. A page-level header takes precedence over
 * the context's, so this moves every request the page makes into that person's
 * bucket without a second context to create and close.
 */
async function browseAsBoard(page: Page, clientAddress: string): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, "board"),
  });
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * The wait belongs here rather than to the callers: clicking only starts the
 * sign-in, so a caller that navigates on the next line cancels the request in
 * flight and the route guard sends the browser back to the form.
 */
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

/**
 * The instance every test here expects: the register fixture, a board seat for
 * the administrator, and the mailbox pointed at mailpit.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 */
async function ensureMailboxFixture(
  request: Parameters<typeof ensureRegisterFixture>[0],
  clientAddress: string,
): Promise<ReadonlyMap<string, string>> {
  /*
   * The context comes back signed in as the administrator: ensureInstance, which
   * ensureRegisterFixture calls, signs it in. Do not sign in again here - a
   * second sign-in goes out on a context that already holds the session cookie,
   * and the authentication layer applies its origin check to a cookie-bearing
   * state-changing request.
   */
  const people = await ensureRegisterFixture(request);

  const residentId = people.get(RESIDENT.fullName);
  if (residentId === undefined) {
    throw new Error(`${RESIDENT.fullName} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId: residentId,
    email: RESIDENT.email,
    password: RESIDENT.password,
    // The probe, and on a fresh stack the activation, belong to the resident's
    // own rate-limit budget rather than to whatever this test is about to do.
    clientAddress: clientAddressFor(clientAddress, "resident"),
  });

  const administratorId = await api.findPersonIdByName(
    request,
    stack.baseUrl,
    `${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`,
  );
  if (administratorId === undefined) {
    throw new Error("the administrator is not in the address book");
  }
  await grantBoardSeat(administratorId);

  await api.saveBoardMailbox(request, stack.baseUrl, {
    address: BOARD_ADDRESS,
    host: stack.pop3Host,
    port: stack.pop3Port,
    // Cleartext, because the port inside the compose network is. The default is
    // the encrypted one, which is what an association's provider offers.
    secure: false,
    user: stack.pop3User,
    password: stack.pop3Password,
  });

  /*
   * Handed back rather than looked up again by the caller. `ensureRegisterFixture`
   * signs this context in, and calling it a second time on a context that already
   * holds the session cookie is refused: the authentication layer applies its
   * origin check to a cookie-bearing state-changing request, and this context has
   * no Origin to satisfy it with.
   */
  return people;
}

test("mail to the board's address becomes a thread the board answers", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureMailboxFixture(request, clientAddress);
  await clearMailbox();

  // A letter arrives in the association's mailbox. Nothing in the product has
  // been told about it.
  await deliverToMailbox({
    from: { address: CORRESPONDENT.address, name: CORRESPONDENT.name },
    to: BOARD_ADDRESS,
    subject: SUBJECT,
    text: LETTER,
  });

  await browseAsBoard(page, clientAddress);
  await signInThroughTheScreen(page, BOARD.email, BOARD.password);
  await page.goto(appPath("/board-mailbox"));

  await expect(
    page.getByRole("heading", { name: "Styrelsens gemensamma brevlåda" }),
  ).toBeVisible();

  // The board collects the mailbox, which is the inbound half in one press.
  await page.getByRole("button", { name: "Hämta nu" }).click();

  // The thread, with the sender the envelope named and the words they
  // wrote. Nothing here was attributed to anybody in the register.
  const row = page.getByRole("button").filter({ hasText: SUBJECT });
  await expect(row.first()).toBeVisible();
  await expect(row.first().getByText("Ny", { exact: true })).toBeVisible();
  await expect(row.first().getByText(CORRESPONDENT.name)).toBeVisible();

  await row.first().click();
  await expect(page.getByText("Det rinner vatten på golvet")).toBeVisible();
  // The warning that says what this is: input from outside the association.
  await expect(page.getByText(/kom utifrån föreningen/i)).toBeVisible();

  // A board member takes it on, where every other seat can see.
  await page.getByRole("button", { name: "Ta hand om det" }).click();
  await expect(
    page.getByText(
      `${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName} tar hand om det här.`,
    ),
  ).toBeVisible();

  // And answers it.
  await page.getByLabel("Ditt svar").fill(ANSWER);
  await page.getByRole("button", { name: "Skicka svaret" }).click();
  await expect(
    page.getByText("Svaret är antecknat på tråden och är på väg."),
  ).toBeVisible();

  /*
   * The answer as the correspondent receives it: real mail, out of the deployed
   * image, through the ordinary outbound path. Its Reply-To carries the board's
   * own address, which is what makes the next letter land on this same thread
   * rather than at whatever relay the instance sends through.
   */
  const { message, text } = await waitForMessage(CORRESPONDENT.address, {
    subjectMatch: new RegExp(SUBJECT.slice(0, 20)),
  });
  expect(text).toContain("Vi har beställt en rörmokare");
  expect(message.Subject).toContain(SUBJECT);

  // The thread records what was asked and what was answered, in order.
  await expect(page.getByText("Inkommet")).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();

  /*
   * Every sentence on this screen that names somebody or counts something is an
   * interpolated one, and an interpolation whose variable is not supplied does
   * not fail - it renders its own placeholder, which reads as a sentence with a
   * word missing rather than as a defect. The assertions above cover the two
   * that carry a name; this covers the rest of the screen at once, including the
   * counts, which is the shape of the failure rather than one instance of it.
   */
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain("{{");
});

test("collecting the same mailbox again brings nothing in twice", async ({
  api: request,
  clientAddress,
}) => {
  await ensureMailboxFixture(request, clientAddress);

  /*
   * Nothing is deleted from the mailbox, so the letter from the first test is
   * still sitting in it. What stops it arriving twice is its unique identifier,
   * and the only place that is true of the deployed image rather than of a unit
   * test is here.
   *
   * The board's own answer is in that mailbox too, because mailpit stands in for
   * both halves of a mail provider and stores what it relayed as well as what it
   * was given. That is not only an artefact of the stand-in: a board that copies
   * its own address, or a provider that files sent mail in the same mailbox,
   * produces exactly this. Neither may come back as a letter.
   */
  const before = await api.listBoardMailboxThreads(request, stack.baseUrl);
  const summary = await api.collectBoardMailbox(request, stack.baseUrl);
  const after = await api.listBoardMailboxThreads(request, stack.baseUrl);

  expect(summary.configured).toBe(true);
  expect(summary.collected).toBe(0);
  expect(after).toHaveLength(before.length);
  expect(after.filter((thread) => thread.subject === SUBJECT)).toHaveLength(1);
  // And no thread has been opened in which the board wrote to itself.
  expect(
    after.filter((thread) => thread.correspondent.email === BOARD_ADDRESS),
  ).toHaveLength(0);
});

test("a resident is not offered the board's correspondence", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureMailboxFixture(request, clientAddress);

  /*
   * The RESIDENT persona, because the fixture's other people collect roles from
   * earlier specs. Every resident may write to the board; none of them may read
   * what the neighbours wrote, and the navigation is where a person would
   * actually look for the door.
   */
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, "resident"),
  });
  await signInThroughTheScreen(page, RESIDENT.email, RESIDENT.password);

  await page.goto(appPath("/issues"));
  await expect(
    page.getByRole("link", { name: "Styrelsens post", exact: true }),
  ).toHaveCount(0);

  // And the screen itself says so rather than failing on every request.
  await page.goto(appPath("/board-mailbox"));
  await expect(
    page.getByText("Styrelsens brevlåda läses av styrelsen."),
  ).toBeVisible();
});

test("the board's correspondence never reaches the association's website", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureMailboxFixture(request, clientAddress);

  /*
   * A property of the whole application rather than of one service: the website
   * renders in the same process from its own module, takes no authenticated read
   * and has no route into this table. The honest way to assert it is to ask the
   * website for the words and find nothing.
   *
   * Read through the API rather than by navigating the instance root, so this
   * spec stays off the allowlist in 93-public-site: what is being checked is
   * what the public surface answers, not what a browser renders.
   */
  const response = await page.request.get(`${stack.baseUrl}/`);
  expect(response.ok()).toBe(true);
  const body = await response.text();
  expect(body).not.toContain(SUBJECT);
  expect(body).not.toContain(CORRESPONDENT.address);
  expect(body).not.toContain("Det rinner vatten");
});

test("the access report answers for correspondence the mailbox identified", async ({
  api: request,
  clientAddress,
}) => {
  /*
   * No sign-in here. `ensureMailboxFixture` calls `ensureRegisterFixture`, which
   * calls `ensureInstance`, which leaves this context signed in as the
   * administrator - and a second sign-in on a context that already holds the
   * session cookie is refused, because the authentication layer applies its
   * origin check to a cookie-bearing state-changing request and this context has
   * no Origin to satisfy it with.
   */
  const people = await ensureMailboxFixture(request, clientAddress);

  /*
   * A letter from an address the register holds for exactly one person, which is
   * the one case where the access report reaches this table. The mailbox records
   * that person as the letter arrives and the report asks for the link; an
   * address the register holds twice, or holds for somebody else by the time the
   * report is drawn, identifies nobody and is in no report at all.
   */
  const karlId = people.get("Karl Berg");
  if (karlId === undefined) {
    throw new Error("Karl Berg is not in the register fixture");
  }

  const reportSubject = `Fråga om andrahandsuthyrning ${uniqueSurname("utdrag")}`;
  await deliverToMailbox({
    from: { address: "karl@eksemplet.test", name: "Karl Berg" },
    to: BOARD_ADDRESS,
    subject: reportSubject,
    text: "Hej, jag funderar på att hyra ut i andra hand.",
  });
  const collected = await api.collectBoardMailbox(request, stack.baseUrl);
  expect(collected.collected).toBeGreaterThan(0);

  const report = await request.post(
    `${stack.baseUrl}/api/data-subject-reports/persons/${karlId}`,
  );
  expect(report.ok(), `the report answered ${String(report.status())}`).toBe(
    true,
  );

  const body = (await report.json()) as {
    boardMailboxThreads: {
      subject: string;
      correspondentEmail: string;
      erasableFrom: string;
    }[];
  };
  const listed = body.boardMailboxThreads.find(
    (thread) => thread.subject === reportSubject,
  );
  expect(listed).toBeDefined();
  expect(listed?.correspondentEmail).toBe("karl@eksemplet.test");
  // The date the purge will reach it, derived rather than stored.
  expect(listed?.erasableFrom).not.toBe("");
});
