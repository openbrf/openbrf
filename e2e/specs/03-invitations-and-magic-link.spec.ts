import type { Page } from "@playwright/test";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, linkFrom, waitForMessage } from "../src/mailpit";
import {
  ADMINISTRATOR,
  ensureRegisterFixture,
  signInAsAdministrator,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Exit criterion 3.
 *
 * The board invites a member on an apartment, a resident on the same apartment
 * and an external board member with no apartment at all. Each activates from
 * the link in their email, and activating leaves them signed in - so the whole
 * way in is driven through the browser here, from the button a board member
 * presses to the register the new account lands on.
 *
 * One property is worth naming before reading the file: after the password is
 * set on /activate, nobody visits /sign-in. Somebody who has just proved
 * possession of the mailbox and chosen a password should not be asked to prove
 * it again, and an activation that ended on a sign-in form would be a way in
 * that needs explaining to everyone who receives it.
 *
 * The spec assumes a fresh database, like the rest of the suite: it invites
 * unconditionally, and a second run against the same volumes would meet the
 * accounts the first run created.
 *
 * One constraint decides how the file is split. Better Auth rate-limits its own
 * endpoints to twenty requests a minute per client address (auth-options.ts),
 * and src/fixtures.ts derives that address from the test's title - so the
 * browser context and the api context of one test spend from a single bucket,
 * and signing in, signing out and every route guard's session check all spend
 * from it. Each invitee therefore gets a test of their own. Two of them in one
 * test crosses twenty, and the request that crosses it is a 429 on the
 * activation sign-in, which surfaces as the "account is ready, sign in
 * yourself" fallback and reads like a broken activation rather than a
 * throttled test.
 */

test.describe.configure({ mode: "serial" });

const PASSWORD = "granngarden-kastanj-2026";

/**
 * Two people on apartment 1001 of Storgatan 12, out of the shared register
 * fixture: the member who holds the tenant-ownership, and a resident who holds
 * none. `standing` is what makes the two test titles differ, which is what
 * gives each of them its own rate-limit bucket.
 */
const INVITED = [
  {
    standing: "the member holding the tenant-ownership",
    name: "Astrid Lindqvist",
    email: "astrid@eksemplet.test",
  },
  {
    standing: "a resident holding no tenant-ownership",
    name: "Nils Lindqvist",
    email: "nils@eksemplet.test",
  },
] as const;

// Written by this spec rather than looked up in the shared register fixture, so
// the identity is this run's: see src/identity.ts. The magic-link test below
// needs the address to resolve to exactly one person.
const EXTERNAL_BOARD_MEMBER = {
  firstName: "Margareta",
  lastName: uniqueSurname("Wallin"),
  email: uniqueEmail("margareta"),
} as const;

async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  // A refusal is named here, with its status, rather than surfacing as a
  // missing heading several assertions later: the rate limit this spec is
  // written around answers 429, and that must read as a throttled sign-in.
  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);

  // The session exists; this is the screen having acted on it. Without it a
  // caller navigating inside the application would still be racing the
  // sign-in it has just performed.
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/**
 * Sets the password on the activation screen the emailed link points at.
 *
 * The link is pulled out of the message by substring rather than by an exact
 * path, so it keeps working wherever the application is mounted.
 */
async function activateFromTheEmail(
  page: Page,
  messageText: string,
): Promise<void> {
  await page.goto(linkFrom(messageText, "/activate"));
  await expect(
    page.getByRole("heading", { name: "Aktivera ditt konto" }),
  ).toBeVisible();
  // The field's label carries the length requirement with it, so it is matched
  // from the start rather than in full.
  await page.getByLabel(/^Lösenord/).fill(PASSWORD);
  await page.getByRole("button", { name: "Aktivera kontot" }).click();
}

for (const invitee of INVITED) {
  test(`${invitee.standing} on apartment 1001 is invited, activates and signs in`, async ({
    page,
    api: request,
  }) => {
    const people = await ensureRegisterFixture(request);
    expect(
      people.get(invitee.name),
      `${invitee.name} is in the register`,
    ).toBeDefined();
    await clearMailbox();

    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();

    await page.getByLabel("Sök i registret").fill(invitee.name);
    await page.getByRole("button", { name: `Öppna ${invitee.name}` }).click();
    await expect(
      page.getByRole("heading", { name: invitee.name }),
    ).toBeVisible();

    /*
     * Matched from the start of the label rather than in full: the shared
     * register people reached the register through sign-up approval, which
     * already emailed them an invitation, so the panel offers to send it
     * again - and the button says so. Both wordings are correct states of this
     * screen, and both send the same email.
     */
    await page.getByRole("button", { name: /^Skicka inbjudan/ }).click();
    await expect(
      page.getByText("Inbjudan är skickad till personens e-postadress."),
    ).toBeVisible();

    /*
     * The board leaves before the invitation is opened, and that is what gives
     * the assertions at the end their meaning: with the administrator's session
     * still in this browser, the address book would be on screen whether the
     * activation had signed anybody in or not.
     */
    await signOut(page);

    const { message, text } = await waitForMessage(invitee.email);
    expect(message.Subject).toContain("Ett konto väntar på dig hos");

    await activateFromTheEmail(page, text);

    // The criterion: the register, under their own name, with no trip through
    // the sign-in form. The name is read off the band rather than off the
    // rows, where this person also appears.
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();
    await expect(
      page.getByRole("banner").getByText(invitee.name),
    ).toBeVisible();
  });
}

test("an external board member with no apartment activates and signs in", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);
  await clearMailbox();

  // A person needs no apartment, no residency and no membership. That is what
  // lets a cooperative seat an external board member at all.
  const personId = await api.createPerson(request, stack.baseUrl, {
    firstName: EXTERNAL_BOARD_MEMBER.firstName,
    lastName: EXTERNAL_BOARD_MEMBER.lastName,
    email: EXTERNAL_BOARD_MEMBER.email,
  });

  await api.sendInvitation(request, stack.baseUrl, personId);
  const { text } = await waitForMessage(EXTERNAL_BOARD_MEMBER.email);

  await activateFromTheEmail(page, text);
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  // Signing out and back in proves the password belongs to the account, not
  // only to the session the activation left behind.
  await signOut(page);
  await signInThroughTheScreen(page, EXTERNAL_BOARD_MEMBER.email, PASSWORD);
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
});

test("a sign-in link arrives by email and signs its recipient in", async ({
  page,
}) => {
  await clearMailbox();

  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(EXTERNAL_BOARD_MEMBER.email);
  await page
    .getByRole("button", {
      name: "Skicka en inloggningslänk till mig i stället",
    })
    .click();

  // The screen never confirms that the address has an account: on an instance
  // holding a statutory register, that is not a question a public endpoint
  // answers.
  await expect(page.getByRole("status")).toContainText(
    "Om adressen har ett konto är en inloggningslänk på väg.",
  );

  const { message, text } = await waitForMessage(EXTERNAL_BOARD_MEMBER.email);
  expect(message.Subject).toContain("Din inloggningslänk till");

  // The link verifies the token, mints the session and redirects to the
  // application, so following it is the whole of the sign-in.
  await page.goto(linkFrom(text, "/api/auth/magic-link/verify"));
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
});
