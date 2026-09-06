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
/** The day the apartment passes to its next holder, after the move-out. */
const TRANSFERRED_ON = "2026-08-02";

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

  await panel
    .getByRole("checkbox", { name: "Registrera upplåtelse eller överlåtelse" })
    .check();
  await panel.getByLabel("Avtalsdatum").fill(MOVED_IN_ON);
  /*
   * Nobody has ever held this apartment - it was claimed for this run - so this
   * is the association granting the bostadsratt, and the board says so. It used
   * to be inferred from leaving the previous-holder picker empty, which is also
   * what a sale out of a hand the register does not hold looks like.
   */
  await panel
    .getByLabel("Vad registreras")
    .selectOption({ label: "Upplåtelse - föreningen upplåter bostadsrätten" });
  // A grant has no previous holder, so the field is not offered at all.
  await expect(
    panel.getByRole("combobox", { name: "Tidigare innehavare" }),
  ).toHaveCount(0);
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
  // Named for the event that was recorded, which is the grant and not a sale.
  await expect(
    panel.getByText("Upplåtelsen registrerades i lägenhetsförteckningen."),
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

test("an overgang is recorded, and the board then says which case it is", async ({
  page,
  api: request,
}) => {
  /*
   * The other half of the move panel's question, and what happens next.
   *
   * Vilgot has moved out, so the apartment he held is passing to somebody: that
   * is an overgang (BRL 6 kap.), not the association granting a bostadsratt.
   * Lag (2026:484) 3 kap. 3 § then has four rules and they differ in the day
   * the two-week window opens on and in who makes the anmalan, so recording the
   * move is not enough - the board has to state which of them applies, and it
   * does that on the apartment register screen.
   *
   * Until it does, the transfer carries no deadline at all. That is the state
   * this test walks through: a case offered rather than a date, and no
   * membership-decision field until the case that has one is chosen.
   */
  await ensureInstance(request);
  const apartment = await apartmentForVilgot(request);

  const buyer = {
    firstName: "Signe",
    lastName: uniqueSurname("Ekstrom"),
    email: uniqueEmail("signe"),
  } as const;
  const buyerName = `${buyer.firstName} ${buyer.lastName}`;

  await api.createPerson(request, stack.baseUrl, {
    firstName: buyer.firstName,
    lastName: buyer.lastName,
    email: buyer.email,
  });

  await signInAsAdmin(page);
  await page.getByRole("button", { name: "Flytta in" }).click();
  const panel = movePanel(page, "Flytta in");
  await expect(panel).toBeVisible();

  await panel.getByLabel("Person", { exact: true }).fill(buyer.lastName);
  await panel.getByRole("button", { name: buyerName }).click();
  await panel
    .getByRole("combobox", { name: "Adresser" })
    .selectOption({ label: apartment.addressLabel });
  await panel
    .getByRole("combobox", { name: "Lägenhet" })
    .selectOption({ label: apartment.number });
  await panel
    .getByRole("radio", { name: "Medlem - innehar bostadsrätten" })
    .check();
  await panel.getByLabel("Inflyttningsdatum").fill(TRANSFERRED_ON);

  await panel
    .getByRole("checkbox", { name: "Registrera upplåtelse eller överlåtelse" })
    .check();
  await panel.getByLabel("Avtalsdatum").fill(TRANSFERRED_ON);
  await panel
    .getByLabel("Vad registreras")
    .selectOption({ label: "Överlåtelse - bostadsrätten byter innehavare" });
  /*
   * An overgang has a previous holder, so the picker is offered here where a
   * grant does not offer it at all. Left unselected rather than naming Vilgot:
   * it offers the apartment's current holders, and he moved out in the test
   * above, so he is not among them. That is a transfer whose seller the
   * register does not hold - which is a state the register models on purpose
   * and not a gap - and this test is about the case the board states next.
   */
  await expect(
    panel.getByRole("combobox", { name: "Tidigare innehavare" }),
  ).toHaveCount(1);
  await panel
    .getByLabel("Avtalshänvisning")
    .fill(`OVL-2026-B-${apartment.number}`);
  await panel.getByRole("button", { name: "Flytta in", exact: true }).click();

  await expect(
    panel.getByText("Överlåtelsen registrerades i lägenhetsförteckningen."),
  ).toBeVisible();

  // And now the case, on the register screen.
  await page.goto(appPath("/registers/apartments"));
  const entry = page
    .getByRole("article")
    .filter({ hasText: `${apartment.addressLabel} ${apartment.number}` });
  const basis = entry.getByLabel(/^Fall enligt 3 kap. 3/).first();
  await expect(basis).toBeVisible();

  /*
   * No date until the case that has one is chosen. The window for the case
   * below runs "fran overgangen", so there is no decision to date and the
   * server refuses one - and a screen offers no control the server would
   * refuse.
   */
  await expect(entry.getByLabel(/^Medlemskap beslutat/)).toHaveCount(0);
  await basis.selectOption("ALREADY_MEMBER");
  await expect(entry.getByLabel(/^Medlemskap beslutat/)).toHaveCount(0);
  await basis.selectOption("MEMBERSHIP_DECISION");
  await expect(entry.getByLabel(/^Medlemskap beslutat/).first()).toBeVisible();

  await basis.selectOption("ALREADY_MEMBER");
  await entry
    .getByRole("button", { name: "Registrera fallet" })
    .first()
    .click();

  // Stated on the entry afterwards, and the control gone: the case is fixed
  // once recorded, because the deadline computed from it cannot be corrected.
  await expect(
    entry.getByText("Förvärvaren var redan medlem", { exact: false }),
  ).toBeVisible();
  await expect(entry.getByLabel(/^Fall enligt 3 kap. 3/)).toHaveCount(0);
});
