import type { Page } from "@playwright/test";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, linkFrom, waitForMessage } from "../src/mailpit";
import {
  activationTokenFrom,
  ensureRegisterFixture,
  signInAsAdministrator,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Exit criterion 3.
 *
 * The board invites a member on an apartment, a resident on the same apartment
 * and an external board member with no apartment at all. Each activates from
 * the link in their email and can then sign in. A sign-in link by email works
 * as well.
 *
 * One gap is deliberate and not papered over: the invitation email points at
 * /activate, and the client has no /activate route yet, so the token is taken
 * from the message and posted to the activation endpoint. Everything either
 * side of that - the invitation, the email, the account, the sign-in - is
 * exercised as a member of the cooperative would meet it. When the activation
 * screen exists, this spec is where it gets driven.
 */

test.describe.configure({ mode: "serial" });

const PASSWORD = "granngarden-kastanj-2026";

const INVITED = [
  { name: "Astrid Lindqvist", email: "astrid@eksemplet.test" },
  { name: "Nils Lindqvist", email: "nils@eksemplet.test" },
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
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
}

test("a member and a resident on one apartment each activate and sign in", async ({
  page,
  api: request,
}) => {
  const people = await ensureRegisterFixture(request);
  await clearMailbox();

  for (const invitee of INVITED) {
    const personId = people.get(invitee.name);
    expect(personId, `${invitee.name} is in the register`).toBeDefined();

    await api.sendInvitation(request, stack.baseUrl, personId!);
    const { message, text } = await waitForMessage(invitee.email);
    expect(message.Subject).toContain("Ett konto väntar på dig hos");

    await api.acceptInvitation(request, stack.baseUrl, {
      token: activationTokenFrom(text),
      password: PASSWORD,
    });
  }

  // Both hold a residency on apartment 1001 of Storgatan 12, one as the member
  // who holds the tenant-ownership and one as a resident who does not.
  for (const invitee of INVITED) {
    await signInThroughTheScreen(page, invitee.email, PASSWORD);
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Logga ut" }).click();
    await expect(page).toHaveURL(new RegExp(`${appPath("/sign-in")}$`));
  }
});

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
  await api.acceptInvitation(request, stack.baseUrl, {
    token: activationTokenFrom(text),
    password: PASSWORD,
  });

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
