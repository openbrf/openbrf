import type { Page } from "@playwright/test";

import { auditEntriesFor } from "../src/database";
import { expect, stack, test } from "../src/fixtures";
import { clearMailbox } from "../src/mailpit";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
  signInAsAdministrator,
} from "../src/provision";
import * as api from "../src/api";

/**
 * Exit criterion 6.
 *
 * A person flagged with protected personal data stays masked wherever they
 * appear, and every reveal lands in the audit log.
 *
 * Skyddade personuppgifter is a protection the Tax Agency grants a person who
 * is at risk from someone who wants to find them. The register has to keep
 * holding their data and has to stop showing it, which is why unmasking is a
 * separate, named, recorded act rather than a display setting.
 */

test.describe.configure({ mode: "serial" });

const PROTECTED_PERSON = "Ingrid Persson";
const NEIGHBOUR = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: "granngarden-kastanj-2026",
} as const;

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

test("the board sees the sign and masked contact, never the values", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signInAsAdmin(page);

  await page.getByLabel("Sök i registret").fill("Persson");

  const row = page.getByRole("row", {
    name: new RegExp(`Öppna ${PROTECTED_PERSON}`),
  });
  await expect(row).toBeVisible();
  // Every sign and every contact value is rendered twice per row: once for the
  // wide layout and once for the narrow one, where it folds into the name cell.
  // Only one of the two is on the screen at a given width.
  //
  // The word, not only the colour: DESIGN.md forbids colour as the only signal,
  // and this is the state where that matters most.
  await expect(
    row.getByText("Skyddad").filter({ visible: true }),
  ).toBeVisible();
  await expect(
    row.getByText("Maskerad").filter({ visible: true }),
  ).toBeVisible();
});

test("a reveal is an explicit act and lands in the audit log", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);

  // A subject of this spec's own, because a reveal needs something to reveal
  // and the register fixture reaches its people through sign-up approval,
  // which records no personal identity number.
  const personId = await api.createPerson(request, stack.baseUrl, {
    firstName: "Elisabet",
    lastName: "Rydberg",
    email: "elisabet@eksemplet.test",
    phone: "0709876543",
    // A valid personal identity number under the Luhn checksum the register
    // enforces. It belongs to nobody: 1990-01-01 with an invented suffix.
    personalIdentityNumber: "19900101-0017",
    protectedPersonalData: true,
  });

  const before = await auditEntriesFor(personId);

  await signInAsAdmin(page);
  await page.getByLabel("Sök i registret").fill("Rydberg");
  await page.getByRole("button", { name: "Öppna Elisabet Rydberg" }).click();

  await expect(
    page.getByRole("heading", { name: "Elisabet Rydberg" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Varje visning skrivs till granskningsloggen med ditt namn och de fält du sett.",
    ),
  ).toBeVisible();

  // The personal identity number is masked for everyone, protected flag or
  // not: the board reaches it only through this reveal.
  await page.getByRole("button", { name: "Visa Personnummer" }).click();
  await expect(
    page.getByRole("button", { name: "Dölj igen" }).first(),
  ).toBeVisible();

  await expect
    .poll(async () => (await auditEntriesFor(personId)).length, {
      message: "the reveal is recorded",
      timeout: 10_000,
    })
    .toBeGreaterThan(before.length);

  const afterFirst = await auditEntriesFor(personId);
  const recorded = afterFirst.at(-1)!;
  expect(recorded.action).toBe("PROTECTED_DATA_REVEALED");
  expect(recorded.targetPersonId).toBe(personId);
  expect(recorded.actorPersonId).not.toBeNull();
  expect((recorded.context as { fields?: string[] } | null)?.fields).toContain(
    "personalIdentityNumber",
  );

  // A second field is a second act, and a second entry. Hiding a revealed
  // value again is local to the screen and records nothing, because nothing
  // was read.
  await page.getByRole("button", { name: "Visa E-postadress" }).click();
  await expect
    .poll(async () => (await auditEntriesFor(personId)).length, {
      message: "the second reveal is recorded separately",
      timeout: 10_000,
    })
    .toBeGreaterThan(afterFirst.length);

  const afterSecond = await auditEntriesFor(personId);
  expect(
    (afterSecond.at(-1)!.context as { fields?: string[] } | null)?.fields,
  ).toContain("email");
});

test("a neighbour does not see the protected person at all", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureRegisterFixture(request);
  await clearMailbox();

  const neighbourId = people.get(NEIGHBOUR.name);
  expect(neighbourId).toBeDefined();
  await ensureAccountFor(request, {
    personId: neighbourId!,
    email: NEIGHBOUR.email,
    password: NEIGHBOUR.password,
    clientAddress,
  });

  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(NEIGHBOUR.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(NEIGHBOUR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  // A protected person is absent from a resident-facing list, not masked in it:
  // a masked row would still say where they live.
  await expect(page.getByText(PROTECTED_PERSON)).toHaveCount(0);

  // And the resident-facing board has no contact column to mask in the first
  // place. Contact data stays with the board.
  await expect(
    page.getByRole("columnheader", { name: "Kontakt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Namn", exact: true }),
  ).toBeVisible();
});

test("the flag can be set from the person view and that is recorded too", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);

  const personId = await api.createPerson(request, stack.baseUrl, {
    firstName: "Hedvig",
    lastName: "Almqvist",
    email: "hedvig@eksemplet.test",
    phone: "0701234567",
  });

  await signInAsAdmin(page);
  await page.getByLabel("Sök i registret").fill("Almqvist");
  await page.getByRole("button", { name: "Öppna Hedvig Almqvist" }).click();

  await page.getByRole("button", { name: "Maskera den här personen" }).click();
  await expect(
    page.getByRole("button", { name: "Sluta maskera den här personen" }),
  ).toBeVisible();

  const entries = await auditEntriesFor(personId);
  expect(entries.map((entry) => entry.action)).toContain(
    "PROTECTED_FLAG_CHANGED",
  );
});
