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
 * Fees and their notices, through the browser.
 *
 * ## What this spec is about
 *
 * That the whole of the box exists in the deployed artefact: the board records
 * the participation shares on the apartment register, records what an apartment
 * pays per month, issues the period's notices, and takes the document away as a
 * CSV file and as a printed PDF.
 *
 * That the three rules the module could get quietly wrong are enforced where
 * they are hardest to check anywhere else. A rate may be dated forward, which
 * is the one thing that separates a fee from a charge. The andelstal aid
 * suggests and stores nothing, which is what keeps Open BRF from enforcing an
 * apportionment rule that belongs to the association's own stadgar. And a
 * holder with protected personal data is withheld from the notice while their
 * apartment stays on it, because the apartment is the party the fee is fixed on
 * and withholding it would empty the row.
 *
 * That the module is the board's alone. There is no resident half of it: a
 * person living here is not offered the destination and is refused the screen.
 *
 * ## The people
 *
 * The shared fixture's, plus one member this spec moves in. The fee is fixed on
 * the apartment rather than on a person, so what this spec needs is apartments
 * nothing else in the suite bills - and a claimed apartment is exactly that.
 *
 * Ingrid Persson comes from the fixture carrying protected personal data, which
 * is what the withholding assertion is made against. Nils Lindqvist is the
 * fixture's resident who holds no board seat, which is the persona the refusals
 * are made against.
 *
 * ## The period
 *
 * A year no other spec bills anything in, and a period may be issued once - so
 * the run this spec makes is its own and the assertions about it are statements
 * about a window rather than about the instance.
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

/** From the shared fixture: a resident with no board seat and no vote. */
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
  firstName: "Majken",
  lastName: uniqueSurname("Alm"),
} as const;

/** The day she was moved in on, comfortably before every rate below. */
const HELD_FROM = "2027-01-02";

/**
 * The period this spec bills, and the day the rates start.
 *
 * A year of its own, because a period may be issued once: a fixed period shared
 * with another spec would make the second run refuse rather than fail on
 * anything this spec is about.
 */
const PERIOD = { from: "2027-01-01", to: "2027-03-31" } as const;
const DUE_ON = "2027-01-31";
const APPLIES_FROM = "2027-01-01";

/** A rate dated into the future, which the charges module refuses for a charge. */
const FUTURE_FROM = "2099-01-01";

const [STORGATAN_12] = ADDRESSES;

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`;
}

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`. The authentication endpoints are
 * rate-limited per client address, and sharing one would make the suite throttle
 * itself and read as flaky.
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
interface FeePeople {
  readonly billed: string;
  readonly protectedMember: string;
  readonly protectedApartmentNumber: string;
  readonly protectedApartmentId: string;
  readonly apartment: ClaimedApartment;
  readonly spareApartment: ClaimedApartment;
}

/**
 * Moves this spec's member in and claims the apartments it bills.
 *
 * Over HTTP rather than through the move-in screen: that flow is criterion 8's,
 * and what this spec is about is what the board can bill afterwards. The
 * look-up first is what lets any one test in this file be run on its own against
 * a stack that is already up.
 *
 * Two apartments, both claimed: one this spec's own member holds, and one left
 * empty. A fee is fixed on the apartment whoever holds it, and the empty one is
 * what makes that unambiguous.
 */
async function createPeople(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
): Promise<FeePeople> {
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
        agreementReference: `UPL-2027-${apartment.number}`,
      },
    });
  }

  /*
   * The protected member's own flat, read out of the register rather than
   * written down: withholding is the one regression this spec exists to catch,
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
    spareApartment: await claimApartment(request, STORGATAN_12.number),
  };
}

/**
 * One value per worker process, and the suite runs in a single worker.
 *
 * Memoised on the promise rather than on the result, so two tests starting at
 * once share one move-in rather than racing to claim two apartments for one
 * person.
 */
let seeded: Promise<FeePeople> | undefined;

/** The instance every test here expects. */
async function ensureFeeFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<FeePeople> {
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

/** Opens the fee screen and waits for the register document to arrive. */
async function openFees(page: Page): Promise<void> {
  await page.goto(appPath("/fees"));
  await expect(
    page.getByRole("heading", { name: "Avgifter och avier", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("[data-print='document']")).toBeVisible();
}

/**
 * Records one rate through the form.
 *
 * By role and accessible name, not by label: `getByLabel` compares the label
 * ELEMENT's text, and a label that wraps a select carries every option with it,
 * so no exact match can ever equal it.
 */
async function recordFee(
  page: Page,
  fee: { apartmentId: string; appliesFrom: string; monthlyAmount: string },
): Promise<void> {
  await page
    .getByRole("combobox", { name: "Lägenhet", exact: true })
    .selectOption(fee.apartmentId);
  await page.getByLabel("Gäller från").fill(fee.appliesFrom);
  await page.getByLabel("Belopp per månad i kronor").fill(fee.monthlyAmount);
  await page.getByRole("button", { name: "Registrera avgiften" }).click();
}

/** The register document's row for this apartment. */
function rowFor(page: Page, apartmentNumber: string) {
  return page.locator("[data-print='document'] tbody tr", {
    hasText: apartmentNumber,
  });
}

test("the board records the participation shares on the register", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );

  await page.goto(appPath("/registers/apartments"));
  await expect(
    page.getByRole("heading", {
      name: "Andelstal och insatser",
    }),
  ).toBeVisible();
  // The panel says in as many words that nothing works a fee out from these
  // figures, which is the whole of decision 23 and the risk the panel carries.
  await expect(page.getByText(/Registret håller siffrorna/)).toBeVisible();

  await page
    .getByRole("button", { name: "Registrera andelstal och insatser" })
    .click();
  await page
    .getByRole("textbox", {
      name: `Andelstal för ${people.apartment.addressLabel} ${people.apartment.number}`,
    })
    .fill("0.02500000");
  await page
    .getByRole("textbox", {
      name: `Insats för ${people.apartment.addressLabel} ${people.apartment.number}`,
    })
    .fill("125000.00");
  await page.getByRole("button", { name: "Spara siffrorna" }).click();

  // Read back off the register document, which is what the board sees.
  await expect(
    page.locator("[data-print='document']").getByText("0.025"),
  ).toBeVisible();
});

test("the board records a fee, including one dated forward", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openFees(page);

  await recordFee(page, {
    apartmentId: people.apartment.id,
    appliesFrom: APPLIES_FROM,
    monthlyAmount: "3450.50",
  });

  const row = rowFor(page, people.apartment.number);
  await expect(row).toHaveCount(1);
  // Formatted for a reader rather than printed as the column holds it: this is
  // the first screen in the application that formats money at all.
  await expect(row).toContainText("3 450,50 kr");
  await expect(row).toContainText("Årsavgift");

  /*
   * A rate dated into the future is accepted, and that is the one thing
   * separating a fee from a charge: a rate dated forward is the board recording
   * a decision it has taken, while a charge dated forward claims something
   * happened which has not.
   */
  await recordFee(page, {
    apartmentId: people.spareApartment.id,
    appliesFrom: FUTURE_FROM,
    monthlyAmount: "1500.00",
  });
  await expect(page.getByText(/kunde inte|inte ett datum/i)).toHaveCount(0);

  // And it is in force on that day rather than on this one.
  await page.getByLabel("Gäller den").fill(FUTURE_FROM);
  await expect(rowFor(page, people.spareApartment.number)).toContainText(
    "1 500,00 kr",
  );
});

test("the andelstal aid suggests a figure and stores nothing", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openFees(page);

  await page.getByRole("button", { name: "Visa hjälpen" }).click();
  await page.getByLabel("Årets summa i kronor").fill("1200000");

  // Two and a half per cent of 1 200 000 over twelve months is 2 500.
  const row = rowFor(page, people.apartment.number);
  await expect(row).toContainText("2 500,00 kr");
  // And the rate itself is untouched: the aid is arithmetic on the screen.
  await expect(row).toContainText("3 450,50 kr");
  await expect(page.getByText(/lagras aldrig/)).toBeVisible();
});

test("the board issues the period's notices and takes them away", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openFees(page);

  // A rate on the protected member's own flat, so the document has a name to
  // withhold.
  await recordFee(page, {
    apartmentId: people.protectedApartmentId,
    appliesFrom: APPLIES_FROM,
    monthlyAmount: "3000.00",
  });

  await page.getByLabel("Från", { exact: true }).fill(PERIOD.from);
  await page.getByLabel("Till", { exact: true }).fill(PERIOD.to);
  await page.getByLabel("Förfallodag").fill(DUE_ON);
  await page.getByRole("button", { name: "Framställ avierna" }).click();

  const run = page.locator("tbody tr", {
    hasText: `${PERIOD.from} till ${PERIOD.to}`,
  });
  await expect(run).toHaveCount(1);
  // Three months at 3 450,50 and 3 000,00.
  await expect(run).toContainText("19 351,50 kr");

  /*
   * The document is produced on a click and not on the read, because producing
   * it writes the audit entry that records the disclosure. So the download is
   * not offered until the board has asked for it.
   */
  await expect(page.getByRole("link", { name: "Hämta filen" })).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `Ta fram dokumentet för ${PERIOD.from} till ${PERIOD.to}`,
    })
    .click();

  const download = page.getByRole("link", { name: "Hämta filen" });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute(
    "download",
    `avier-${PERIOD.from}-${PERIOD.to}.csv`,
  );

  /*
   * The file's own bytes, read out of the link rather than saved: the anchor
   * carries the CSV the server produced, so this is the file the board hands on
   * and not a rendering of the screen.
   */
  const href = await download.getAttribute("href");
  expect(href).not.toBeNull();
  const csv = decodeURIComponent(
    (href ?? "").replace("data:text/csv;charset=utf-8,", ""),
  );
  expect(csv).toContain(
    "apartment;apartmentNumber;holders;holdersWithheld;amount;paymentReference;dueOn",
  );
  expect(csv).toContain(fullName(BILLED));
  expect(csv).toContain("10351.50");
  expect(csv).toContain(DUE_ON);
  // The protected holder's name is not in the file, and the word is what tells
  // the reader the empty cell is deliberate.
  expect(csv).not.toContain(PROTECTED.name);
  expect(csv).toContain("protected");
  // The flat is on the row either way: it is the party the fee is fixed on.
  expect(csv).toContain(people.protectedApartmentNumber);

  // Nothing here says whether anything was paid, on either side.
  expect(csv).not.toContain("paid");
  expect(csv).not.toContain("balance");

  /*
   * The PDF is the browser's own print of the register document. Printed here
   * rather than asserted as a button, because a print stylesheet that dropped
   * the table would leave the button working and the document empty.
   */
  await page.emulateMedia({ media: "print" });
  await expect(
    page.getByRole("heading", { name: "Registrera en avgift" }),
  ).toBeHidden();
  await expect(page.locator("[data-print='document']")).toBeVisible();

  const pdf = await page.pdf({ format: "A4" });
  expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  expect(pdf.byteLength).toBeGreaterThan(1000);

  await page.emulateMedia({ media: "screen" });
});

test("a period can only be issued once", async ({
  page,
  api: request,
  clientAddress,
}) => {
  // A month billed twice would give the association two answers to what it
  // asked for and two sets of payment references for one month's money.
  await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openFees(page);

  await page.getByLabel("Från", { exact: true }).fill(PERIOD.from);
  await page.getByLabel("Till", { exact: true }).fill(PERIOD.to);
  await page.getByLabel("Förfallodag").fill(DUE_ON);
  await page.getByRole("button", { name: "Framställ avierna" }).click();

  await expect(page.getByText("Perioden är redan aviserad.")).toBeVisible();
});

test("a resident is neither offered the screen nor allowed on it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureFeeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT.email, RESIDENT.password);

  // Not in the band: the navigation offers what the capability model grants.
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Avgifter" }),
  ).toHaveCount(0);

  // And refused on the screen itself, which is where the gate actually is.
  await page.goto(appPath("/fees"));
  await expect(page.getByText(/Avgifter hanteras av styrelsen/)).toBeVisible();
});
