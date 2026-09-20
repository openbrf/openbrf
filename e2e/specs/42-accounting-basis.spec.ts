import type { APIRequestContext, Page } from "@playwright/test";

import * as api from "../src/api";
import { type ClaimedApartment, claimApartment } from "../src/apartments";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import {
  ADDRESSES,
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
  REGISTER_PEOPLE,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The accounting basis, through the browser.
 *
 * ## What this spec is about
 *
 * That the whole of the box exists in the deployed artefact: the board records
 * a fee, issues a period's notices, records a charge, and takes both halves
 * away as one file with the header `docs/accounting-basis-contract.md`
 * publishes.
 *
 * That the masking rule the file rests on holds in the deployed artefact rather
 * than only in a unit test. A charge on a member with protected personal data
 * names them and withholds their apartment; a fee row names nobody at all, for
 * any apartment. Those two together are what stops the file saying, of one
 * apartment, that its holders are withheld and, of one person, that their
 * apartment is - which a reader holding both rows could put back together.
 *
 * That the file is produced on a click. Producing it writes the audit entry
 * recording the disclosure, so nothing is offered for download until the board
 * has asked for it.
 *
 * That it is the board's alone: a resident is not offered the panel on either
 * screen it stands on.
 *
 * ## The period
 *
 * A year no other spec bills anything in, because a notification period may be
 * issued once. The export period is wider and reaches back over today, since a
 * charge cannot be dated into the future while a fee can - so the two halves of
 * this spec's own money sit at opposite ends of one export.
 *
 * That width is also why every assertion here is about rows this spec wrote
 * rather than about totals: another spec's charges fall inside the same window,
 * and a figure for the whole instance would be a statement about the suite.
 *
 * Fixed rather than derived, which is where `OPENBRF_E2E_REUSE_STACK` bites: a
 * second run against a stack that already billed this period meets the refusal
 * that spec 41 asserts, which is the product behaving correctly. CI starts from
 * empty volumes, and a local re-run wants a fresh stack for this file.
 */

test.describe.configure({ mode: "serial" });

/** The password the shared fixture accounts are activated with, per spec 03. */
const PASSWORD = "granngarden-kastanj-2026";

/** From the shared fixture: a member with protected personal data. */
const PROTECTED = registerPerson("Ingrid", "Persson");

/** One of the four people `ensureRegisterFixture` puts in the register. */
function registerPerson(
  firstName: string,
  lastName: string,
): { name: string; apartmentNumber: string } {
  const entry = REGISTER_PEOPLE.find(
    (person) => person.firstName === firstName && person.lastName === lastName,
  );
  if (entry === undefined) {
    throw new Error(
      `${firstName} ${lastName} is not one of the register fixture's people.`,
    );
  }
  return {
    name: `${firstName} ${lastName}`,
    apartmentNumber: entry.apartmentNumber,
  };
}

/** From the shared fixture: a resident with no board seat. */
const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * The member this spec moves in.
 *
 * A surname unique to the run, per `src/identity.ts`: a member register entry
 * cannot be taken back, so a fixed name describes a different person on the
 * second run against one database.
 */
const BILLED = {
  firstName: "Gunnel",
  lastName: uniqueSurname("Bok"),
} as const;

/** The day she was moved in on, comfortably before every rate below. */
const HELD_FROM = "2026-01-02";

/** The quarter this spec bills, in a year of its own. */
const PERIOD = { from: "2029-01-01", to: "2029-03-31" } as const;
const DUE_ON = "2029-01-31";
const APPLIES_FROM = "2029-01-01";

/** A charge is dated when it happened, so this one is behind the clock. */
const CHARGED_ON = "2026-03-16";

/** The whole window the export covers: the charge at one end, the run at the other. */
const EXPORT = { from: "2026-01-01", to: "2029-12-31" } as const;

const [STORGATAN_12] = ADDRESSES;

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`;
}

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`. The authentication endpoints are
 * rate-limited per client address, and sharing one would make the suite
 * throttle itself and read as flaky.
 */
type Persona = "administrator" | "resident";

/** Puts this browser on one person's own client address. */
async function browseAs(
  page: Page,
  clientAddress: string,
  persona: Persona,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * Starts from a browser holding no session: these tests act as two people on
 * one page and `browseAs` changes only the forwarded-for header, so a second
 * call would arrive still carrying the first person's cookie - and /sign-in's
 * route guard sends a visitor who already has a session to the address book.
 */
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
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

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

/** The identifiers this spec's fixture hands back. */
interface BasisPeople {
  readonly billed: string;
  readonly protectedMember: string;
  readonly protectedApartmentNumber: string;
  readonly protectedApartmentId: string;
  readonly apartment: ClaimedApartment;
}

/**
 * Moves this spec's member in and claims the apartment it bills.
 *
 * Over HTTP rather than through the move-in screen: that flow is criterion 8's,
 * and what this spec is about is what the board can take away afterwards. The
 * look-up first is what lets any one test in this file be run on its own
 * against a stack that is already up.
 */
async function createPeople(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
): Promise<BasisPeople> {
  const protectedMember = people.get(PROTECTED.name);
  if (protectedMember === undefined) {
    throw new Error("the register fixture is missing one of its people");
  }

  const existing = await api.findPersonIdByName(
    request,
    stack.baseUrl,
    fullName(BILLED),
  );
  const apartment = await claimApartment(request, STORGATAN_12.number);
  let billed = existing;
  if (billed === undefined) {
    billed = await api.createPerson(request, stack.baseUrl, {
      firstName: BILLED.firstName,
      lastName: BILLED.lastName,
    });
    await api.moveIn(request, stack.baseUrl, {
      personId: billed,
      apartmentId: apartment.id,
      role: "MEMBER",
      movedInOn: HELD_FROM,
      transfer: {
        // A first holder on an apartment nobody has held: an upplatelse.
        kind: "GRANT",
        transferredOn: HELD_FROM,
        agreementReference: `UPL-2026-${apartment.number}`,
      },
    });
  }

  /*
   * The protected member's own flat, read out of the register rather than
   * written down: a fee row naming nobody is what this spec exists to catch,
   * and a literal number would go on passing after the fixture moved them.
   */
  const addresses = await api.listAddresses(request, stack.baseUrl);
  const address = addresses.find(
    (candidate) => candidate.number === STORGATAN_12.number,
  );
  if (address === undefined) {
    throw new Error(`the fixture has no address ${STORGATAN_12.number}`);
  }
  const apartments = await api.listApartments(
    request,
    stack.baseUrl,
    address.id,
  );
  const protectedApartment = apartments.find(
    (candidate) => candidate.number === PROTECTED.apartmentNumber,
  );
  if (protectedApartment === undefined) {
    throw new Error(
      `the register has no apartment ${PROTECTED.apartmentNumber}`,
    );
  }

  return {
    billed,
    protectedMember,
    protectedApartmentNumber: PROTECTED.apartmentNumber,
    protectedApartmentId: protectedApartment.id,
    apartment,
  };
}

/**
 * One value per worker process, and the suite runs in a single worker.
 *
 * Memoised on the promise rather than on the result, so two tests starting at
 * once share one move-in rather than racing to claim two apartments for one
 * person.
 */
let seeded: Promise<BasisPeople> | undefined;

/** The instance every test here expects. */
async function ensureBasisFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<BasisPeople> {
  // `ensureRegisterFixture` signs this context in as the administrator on its
  // way through `ensureInstance`, so nothing here signs in a second time.
  const people = await ensureRegisterFixture(request);

  const residentId = people.get(RESIDENT.name);
  if (residentId === undefined) {
    throw new Error(`${RESIDENT.name} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId: residentId,
    email: RESIDENT.email,
    password: RESIDENT.password,
    clientAddress: clientAddressFor(clientAddress, "resident"),
  });

  seeded ??= createPeople(request, people);
  return seeded;
}

/**
 * Records one rate through the fee form.
 *
 * By role and accessible name, not by label: `getByLabel` compares the label
 * ELEMENT's text, and a label that wraps a select carries every option with it,
 * so no exact match can ever equal it.
 */
async function recordFee(
  page: Page,
  fee: { apartmentId: string; monthlyAmount: string },
): Promise<void> {
  await page
    .getByRole("combobox", { name: "Lägenhet", exact: true })
    .selectOption(fee.apartmentId);
  await page.getByLabel("Gäller från").fill(APPLIES_FROM);
  await page.getByLabel("Belopp per månad i kronor").fill(fee.monthlyAmount);
  await page.getByRole("button", { name: "Registrera avgiften" }).click();
}

/** The file's cells, header included, as the reader of the contract sees them. */
function cellsOf(csv: string): string[][] {
  return csv
    .replace(/^﻿/u, "")
    .trimEnd()
    .split("\r\n")
    .map((line) => line.split(";"));
}

/**
 * Produces the basis on the screen this page is on, and hands back the bytes.
 *
 * Read out of the link rather than saved to disk: the anchor carries the CSV
 * the server produced, so this is the file the board hands on and not a
 * rendering of the screen.
 */
async function produceBasis(page: Page): Promise<string> {
  await page.getByLabel("Från och med").fill(EXPORT.from);
  await page.getByLabel("Till och med").fill(EXPORT.to);

  // Nothing is offered until the board has asked: producing the file is what
  // writes the audit entry recording the disclosure.
  const download = page.getByRole("link", {
    name: "Hämta bokföringsunderlaget",
  });
  await expect(download).toHaveCount(0);

  await page
    .getByRole("button", { name: "Ta fram bokföringsunderlaget" })
    .click();
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute(
    "download",
    `bokforingsunderlag-${EXPORT.from}-${EXPORT.to}.csv`,
  );

  const href = await download.getAttribute("href");
  expect(href).not.toBeNull();
  return decodeURIComponent(
    (href ?? "").replace("data:text/csv;charset=utf-8,", ""),
  );
}

test("the board bills a period and charges a member", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureBasisFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );

  await page.goto(appPath("/fees"));
  await expect(
    page.getByRole("heading", { name: "Avgifter och avier", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("[data-print='document']")).toBeVisible();

  await recordFee(page, {
    apartmentId: people.apartment.id,
    monthlyAmount: "2500.00",
  });
  // A rate on the protected member's own flat, so the file has a fee row for an
  // apartment whose holder the register masks.
  await recordFee(page, {
    apartmentId: people.protectedApartmentId,
    monthlyAmount: "3000.00",
  });

  await page.getByLabel("Från", { exact: true }).fill(PERIOD.from);
  await page.getByLabel("Till", { exact: true }).fill(PERIOD.to);
  await page.getByLabel("Förfallodag").fill(DUE_ON);
  await page.getByRole("button", { name: "Framställ avierna" }).click();
  await expect(
    page.locator("tbody tr", { hasText: `${PERIOD.from} till ${PERIOD.to}` }),
  ).toHaveCount(1);

  await page.goto(appPath("/charges"));
  await expect(
    page.getByRole("heading", { name: "Debiteringar mot medlem" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "En medlem" }).check();
  await page
    .getByRole("combobox", { name: "Medlem", exact: true })
    .selectOption(people.protectedMember);
  await page.getByLabel("Debiteringsdatum").fill(CHARGED_ON);
  await page.getByLabel("Belopp i kronor").fill("450.00");
  await page.getByLabel("Vad debiteringen avser").fill(reasonFor(people));
  await page.getByRole("button", { name: "Registrera debiteringen" }).click();
  await expect(
    page.locator("[data-print='document'] tbody tr", {
      hasText: reasonFor(people),
    }),
  ).toHaveCount(1);
});

test("the board takes both halves away as one documented file", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureBasisFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );

  await page.goto(appPath("/charges"));
  await expect(
    page.getByRole("heading", { name: "Debiteringar mot medlem" }),
  ).toBeVisible();

  const csv = await produceBasis(page);
  const rows = cellsOf(csv);
  const header = rows[0] ?? [];
  const column = (name: string): number => {
    const index = header.indexOf(name);
    expect(index, `the file has no ${name} column`).toBeGreaterThanOrEqual(0);
    return index;
  };

  // The published header, in the published order.
  expect(header.join(";")).toBe(
    "kind;periodFrom;periodTo;apartment;apartmentWithheld;name;amount;" +
      "vatTreatment;vatRatePercent;reason;paymentReference",
  );

  // Both halves of this spec's own money. Three months at each rate, carried
  // whole at the day the run opens.
  const fees = rows
    .slice(1)
    .filter((cells) => cells[column("kind")] === "FEE_NOTICE");
  const billed = fees.filter(
    (cells) => cells[column("periodFrom")] === PERIOD.from,
  );
  expect(billed.map((cells) => cells[column("amount")])).toContain("7500.00");
  expect(billed.map((cells) => cells[column("amount")])).toContain("9000.00");
  for (const cells of billed) {
    expect(cells[column("periodTo")]).toBe(PERIOD.to);
    expect(cells[column("paymentReference")]).not.toBe("");
  }

  /*
   * No fee row names anybody, on any apartment. This is the property the whole
   * file rests on: a fee row that named its holders would withhold them where
   * one is protected, and the file would then carry both halves of the link
   * between a name and a door.
   */
  expect(fees.length).toBeGreaterThan(0);
  for (const cells of fees) {
    expect(cells[column("name")]).toBe("");
    expect(cells[column("apartmentWithheld")]).toBe("");
  }
  expect(fees.map((cells) => cells[column("apartment")]).join(" ")).toContain(
    people.protectedApartmentNumber,
  );

  // The charge on a protected member names them and withholds their apartment,
  // which is the debiting list's own rule carried across unchanged.
  const charge = rows.find(
    (cells) => cells[column("reason")] === reasonFor(people),
  );
  expect(charge?.[column("kind")]).toBe("MEMBER_CHARGE");
  expect(charge?.[column("name")]).toBe(PROTECTED.name);
  expect(charge?.[column("apartment")]).toBe("");
  expect(charge?.[column("apartmentWithheld")]).toBe("protected");
  expect(charge?.[column("periodFrom")]).toBe(CHARGED_ON);
  expect(charge?.[column("periodTo")]).toBe(CHARGED_ON);
  expect(charge?.[column("amount")]).toBe("450.00");

  // Nothing here says whether anything was paid, on either half.
  expect(csv).not.toContain("paid");
  expect(csv).not.toContain("balance");
});

test("the same file is offered from the fees screen", async ({
  page,
  api: request,
  clientAddress,
}) => {
  // One panel on both screens, because the file is both halves of the money and
  // a board member should not have to know which half it was filed under.
  await ensureBasisFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );

  await page.goto(appPath("/fees"));
  await expect(
    page.getByRole("heading", { name: "Bokföringsunderlag" }),
  ).toBeVisible();

  const csv = await produceBasis(page);
  expect(csv.startsWith("﻿")).toBe(true);
  expect(cellsOf(csv)[0]?.[0]).toBe("kind");
});

test("a resident is not offered the file at all", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBasisFixture(request, clientAddress);
  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT.email, RESIDENT.password);

  await page.goto(appPath("/charges"));
  await expect(
    page.getByText(/Debiteringar hanteras av styrelsen/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ta fram bokföringsunderlaget" }),
  ).toHaveCount(0);
});

/** The reason this spec's own charge carries, unique to the run. */
function reasonFor(people: BasisPeople): string {
  return `Underlag ${people.apartment.number} tvättstugetagg`;
}
