import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { claimApartment, type ClaimedApartment } from "../src/apartments";
import { memberRegisterEntriesByRecordedName } from "../src/database";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, waitForMessage } from "../src/mailpit";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import * as api from "../src/api";
import { appPath } from "../src/stack";

/**
 * Exit criterion 8.
 *
 * Moving in and moving out, driven through the board's own screens.
 *
 * The two halves are one criterion because they are one residency. Moving in as
 * a member writes the entry in the statutory member register and sends the
 * welcome mail in the recipient's own language; moving out ends the residency,
 * closes the membership in that same register, and states the date the service
 * data is erased - a date derived from the association's retention policy and
 * never stored, so the screen has to be able to say it without one.
 *
 * The register entry outlives the move-out on purpose. EFL 5 kap. requires the
 * archive; GDPR requires the rest to go. The panel says which of the two
 * happened rather than leaving a board member to find out later.
 */

test.describe.configure({ mode: "serial" });

/*
 * This run's own person, on this run's own apartment. Nothing here can be
 * removed again - the residency, the transfer and the register entry are all
 * kept - so both a fixed identity and a fixed apartment would collide with
 * themselves on a second run against one database.
 */
const VILGOT = {
  firstName: "Vilgot",
  lastName: uniqueSurname("Norberg"),
  email: uniqueEmail("vilgot"),
} as const;

const FULL_NAME = `${VILGOT.firstName} ${VILGOT.lastName}`;

const ADDRESS_NUMBER = "12";

/**
 * The apartment Vilgot moves into, claimed once for the whole file.
 *
 * The two tests are one residency: the move-out ends the residency the move-in
 * created, so they have to mean the same apartment. Held in the module rather
 * than claimed per test for exactly that, and the file runs serially in one
 * worker, so the second test finds what the first claimed rather than asking
 * for a second apartment.
 */
let claimed: Promise<ClaimedApartment> | undefined;

function apartmentForVilgot(
  request: APIRequestContext,
): Promise<ClaimedApartment> {
  claimed ??= claimApartment(request, ADDRESS_NUMBER);
  return claimed;
}

const MOVED_IN_ON = "2026-06-01";
const MOVED_OUT_ON = "2026-08-01";

/** What a fresh instance starts at, and what nothing in this suite changes. */
const RETENTION_DAYS = 365;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The purge date, computed rather than written down.
 *
 * Mirrors `apps/api/src/retention/purge-date.ts`: whole days added to the UTC
 * instant the move-out date parses to, because a calendar-field addition in
 * local time crosses a Swedish daylight saving boundary and lands a day early -
 * and a purge date a day early is an erasure a day early. Computing it here is
 * also what makes the assertion a check on the application rather than a copy
 * of a number somebody read off the screen once.
 */
function purgeDateFor(movedOutOn: string, retentionDays: number): string {
  const anchor = new Date(`${movedOutOn}T00:00:00.000Z`);
  const purge = new Date(
    anchor.getTime() + retentionDays * MILLISECONDS_PER_DAY,
  );
  return purge.toISOString().slice(0, 10);
}

const PURGE_ON = purgeDateFor(MOVED_OUT_ON, RETENTION_DAYS);

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * The move panels are asides with their own names.
 *
 * Scoped rather than reached from the page: the button that opens the move-in
 * panel and the button that submits it read the same word, which is right on
 * both of them and ambiguous to a locator that looks at the whole page.
 */
function movePanel(page: Page, name: string): Locator {
  return page.getByRole("complementary", { name });
}

test("moving someone in writes the register and welcomes them in their own language", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  const apartment = await apartmentForVilgot(request);

  /*
   * English, on a Swedish instance. The criterion is that the welcome mail is
   * in the recipient's language rather than the cooperative's, and this is the
   * only way to tell the two apart.
   */
  await api.createPerson(request, stack.baseUrl, {
    firstName: VILGOT.firstName,
    lastName: VILGOT.lastName,
    email: VILGOT.email,
    preferredLocale: "en",
  });

  await clearMailbox();
  await signInAsAdmin(page);

  await page.getByRole("button", { name: "Flytta in" }).click();
  const panel = movePanel(page, "Flytta in");
  await expect(panel).toBeVisible();

  await panel.getByLabel("Person", { exact: true }).fill(VILGOT.lastName);
  await panel.getByRole("button", { name: FULL_NAME }).click();

  await panel
    .getByRole("combobox", { name: "Adresser" })
    .selectOption({ label: apartment.addressLabel });
  await panel
    .getByRole("combobox", { name: "Lägenhet" })
    .selectOption({ label: apartment.number });

  // A tenant-ownership rather than a tenancy: this is the choice that decides
  // whether a statutory member register entry is written at all.
  await panel
    .getByRole("radio", { name: "Medlem - innehar bostadsrätten" })
    .check();
  await panel.getByLabel("Inflyttningsdatum").fill(MOVED_IN_ON);

  await panel.getByRole("checkbox", { name: "Registrera överlåtelse" }).check();
  await panel.getByLabel("Avtalsdatum").fill(MOVED_IN_ON);
  // Nobody has ever held this apartment - it was claimed for this run - so the
  // transfer is the first grant. That is the default the select offers, and
  // leaving it is the whole assertion.
  await expect(
    panel.getByRole("combobox", { name: "Tidigare innehavare" }),
  ).toHaveValue("");
  await panel.getByLabel("Pris").fill("2450000");
  await panel
    .getByLabel("Avtalshänvisning")
    .fill(`OVL-2026-${apartment.number}`);

  await panel.getByRole("button", { name: "Flytta in", exact: true }).click();

  // What the move did, said in four sentences, because only the first of them
  // can be undone.
  await expect(
    panel.getByText(
      `${FULL_NAME} är registrerad på lägenhet ${apartment.number}.`,
    ),
  ).toBeVisible();
  await expect(
    panel.getByText("En post skrevs i medlemsförteckningen."),
  ).toBeVisible();
  await expect(
    panel.getByText("Överlåtelsen registrerades i lägenhetsförteckningen."),
  ).toBeVisible();
  await expect(
    panel.getByText("Ett välkomstmejl skickades, på mottagarens eget språk."),
  ).toBeVisible();

  const { message, text } = await waitForMessage(VILGOT.email, {
    subjectMatch: /Welcome to Brf Eksemplet/,
  });
  expect(message.Subject).toContain("Welcome to Brf Eksemplet");
  // The plain-text part is word-wrapped when it is rendered, so the sentence is
  // read with its line breaks collapsed rather than as it happens to be laid
  // out: a wrap falling between the word and the number is not a defect.
  expect(text.replace(/\s+/g, " ")).toContain(`apartment ${apartment.number}`);

  await expect
    .poll(
      async () =>
        (await memberRegisterEntriesByRecordedName(VILGOT.lastName)).map(
          (entry) => entry.eventType,
        ),
      {
        message: "the move-in wrote the member register entry",
        timeout: 10_000,
      },
    )
    .toEqual(["ENTRY"]);
});

test("moving someone out states the purge date and keeps the register entry", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  const apartment = await apartmentForVilgot(request);
  await signInAsAdmin(page);

  await page.getByLabel("Sök i registret").fill(VILGOT.lastName);
  await page.getByRole("button", { name: `Öppna ${FULL_NAME}` }).click();
  await expect(page.getByRole("heading", { name: FULL_NAME })).toBeVisible();

  // Named after the apartment it ends, because a person can hold more than one.
  await page
    .getByRole("button", {
      name: `Flytta ut från lägenhet ${apartment.number}`,
    })
    .click();

  const panel = movePanel(page, "Flytta ut");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Utflyttningsdatum").fill(MOVED_OUT_ON);
  await panel.getByRole("button", { name: "Flytta ut", exact: true }).click();

  await expect(
    panel.getByText(
      `Utflyttningen från lägenhet ${apartment.addressLabel} ${apartment.number} är registrerad.`,
    ),
  ).toBeVisible();

  // The service tier goes on this date; the statutory tier never does. Both
  // sentences are the criterion, and the second is the one a board misreads.
  await expect(
    panel.getByText(`Servicedata gallras ${PURGE_ON}.`),
  ).toBeVisible();
  await expect(
    panel.getByText("Medlemskapet avslutades i medlemsförteckningen."),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "Själva posten i medlemsförteckningen bevaras som lagen kräver. Ingen gallringsinställning når den.",
    ),
  ).toBeVisible();

  // The handover is a board task with a date of its own, and it is the day the
  // residency ended rather than the day the data goes.
  await expect(
    panel.getByText(
      `Styrelsen påminns ${MOVED_OUT_ON} om att slutföra överlämningen.`,
    ),
  ).toBeVisible();

  await panel.getByRole("button", { name: "Stäng" }).click();

  // And on the board: the moved-out filter, the sign in a word rather than only
  // a dashed border, and the date the rest of the record goes.
  await page
    .getByRole("navigation", { name: "Filtrera registret" })
    .getByRole("button", { name: /^Utflyttade/ })
    .click();

  const row = page.getByRole("row", {
    name: new RegExp(`Öppna ${FULL_NAME}`),
  });
  await expect(row).toBeVisible();
  // Every sign and every date is rendered twice per row, once for the wide
  // layout and once for the narrow one; only one of the two is on the screen.
  await expect(
    row.getByText("Utflyttad").filter({ visible: true }),
  ).toBeVisible();
  await expect(
    row.getByText(`Gallras ${PURGE_ON}`).filter({ visible: true }),
  ).toBeVisible();

  await expect
    .poll(
      async () =>
        (await memberRegisterEntriesByRecordedName(VILGOT.lastName)).map(
          (entry) => entry.eventType,
        ),
      {
        message:
          "the move-out closed the membership without touching the entry",
        timeout: 10_000,
      },
    )
    .toEqual(["ENTRY", "EXIT"]);
});
