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
 * Charges to members, through the browser.
 *
 * ## What this spec is about
 *
 * That the whole of the free half exists in the deployed artefact: the board
 * records a charge against a named member and against an apartment, reads the
 * debiting list for a period, and takes it away as a CSV file and as a printed
 * PDF.
 *
 * That the two rules the module could get quietly wrong are enforced where they
 * are hardest to check anywhere else. A member with protected personal data is
 * named on the list and their apartment is not - on the screen and in the file
 * the board hands to whoever keeps the books, which is a document that leaves
 * the association. And a personal identity number pasted into the reason is
 * refused, because that reason is copied into the same file.
 *
 * That the module is the board's alone. There is no resident half of it: a
 * person living here is not offered the destination and is refused the screen.
 *
 * ## The people
 *
 * The shared fixture's, which is what this spec needs and no more. A charge is
 * put on a person the register holds, and it does not ask whether they hold a
 * tenant-ownership - so, unlike the meetings spec, this one does not have to
 * write the member register. It still moves one member of its own in: the list
 * states where a charged person lives, and a person on an apartment nothing else
 * in the suite touches is what makes that assertion this spec's own rather than
 * a fact about whatever another spec left behind.
 *
 * Ingrid Persson comes from the fixture carrying protected personal data, which
 * is what the masking assertions are made against. Nils Lindqvist is the fixture's
 * resident who holds no board seat, which is the persona the refusals are made
 * against.
 *
 * Every count asserted below moves relative to this spec's own rows: the period
 * is a year no other spec records anything in, and every reason it writes carries
 * a surname unique to the run.
 */

test.describe.configure({ mode: "serial" });

/** The password the shared fixture accounts are activated with, per spec 03. */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * From the shared fixture: a member with protected personal data, and the flat
 * the fixture puts them in.
 *
 * The apartment is read out of the fixture rather than written here. Masking is
 * the one regression this spec exists to catch, and a literal apartment number
 * would go on passing after the fixture moved this person: the row would print
 * their real flat, the literal would be absent from it, and the assertion would
 * read as a pass.
 */
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
const CHARGED = {
  firstName: "Elsa",
  lastName: uniqueSurname("Kvist"),
} as const;

/** The day she was moved in on, comfortably before every charge below. */
const HELD_FROM = "2026-01-15";

/**
 * The period every charge here is dated in, and the one the screen is read for.
 *
 * A year of its own so the list this spec reads is this spec's own. Nothing else
 * in the suite records a charge at all, and the period controls make the
 * assertion a statement about a window rather than about the instance.
 */
const PERIOD = { from: "2026-01-01", to: "2026-12-31" } as const;

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
 * Starts from a browser holding no session, for the reason the meetings spec
 * gives: these tests act as two people on one page and `browseAs` changes only
 * the forwarded-for header, so a second call would arrive still carrying the
 * first person's cookie - and /sign-in's route guard sends a visitor who already
 * has a session to the address book.
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
interface ChargePeople {
  readonly charged: string;
  readonly protectedMember: string;
  readonly resident: string;
  readonly spareApartment: ClaimedApartment;
}

/**
 * Moves this spec's member in and claims a spare apartment, once however often
 * this is asked for.
 *
 * Over HTTP rather than through the move-in screen: that flow is criterion 8's,
 * and what this spec is about is what the board can charge afterwards. The
 * look-up first is what lets any one test in this file be run on its own against
 * a stack that is already up.
 *
 * The spare apartment is claimed and left empty. It is what a charge against an
 * apartment rather than against a person is put on, and an empty one makes that
 * charge unambiguously about the flat.
 */
async function createPeople(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
): Promise<ChargePeople> {
  const protectedMember = people.get(PROTECTED.name);
  const resident = people.get(RESIDENT.name);
  if (protectedMember === undefined || resident === undefined) {
    throw new Error("the register fixture is missing one of its people");
  }

  const existing = await api.findPersonIdByName(
    request,
    stack.baseUrl,
    fullName(CHARGED),
  );
  let charged = existing;
  if (charged === undefined) {
    const apartment = await claimApartment(request, STORGATAN_12.number);
    charged = await api.createPerson(request, stack.baseUrl, {
      firstName: CHARGED.firstName,
      lastName: CHARGED.lastName,
    });
    await api.moveIn(request, stack.baseUrl, {
      personId: charged,
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

  return {
    charged,
    protectedMember,
    resident,
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
let seeded: Promise<ChargePeople> | undefined;

/**
 * The instance every test here expects.
 *
 * Called once at the top of each test and never twice within one, which matters
 * on both counts: Playwright gives each test a request context of its own
 * holding no session, and a second sign-in on a context that already holds one
 * is refused for a missing origin.
 */
async function ensureChargeFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<ChargePeople> {
  // `ensureRegisterFixture` signs this context in as the administrator on its
  // way through `ensureInstance`, so nothing here signs in a second time: a
  // second sign-in on a context that already holds a session is refused for a
  // missing origin, which is a failure three files away from anything this spec
  // is about.
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

/** Opens the charges screen for this spec's own period. */
async function openCharges(page: Page): Promise<void> {
  await page.goto(appPath("/charges"));
  await expect(
    page.getByRole("heading", { name: "Debiteringar mot medlem" }),
  ).toBeVisible();

  /*
   * Exactly, on both. `getByLabel` matches a substring and ignores case, and
   * this screen has a label the shorter of the two is inside: "Skickat till
   * ekonomisk forvaltare" on the form above.
   */
  await page.getByLabel("Från", { exact: true }).fill(PERIOD.from);
  await page.getByLabel("Till", { exact: true }).fill(PERIOD.to);
  // The list is re-read on every period change, so the document below is the
  // one this spec's charges are in before anything is asserted about it.
  await expect(page.locator("[data-print='document']")).toBeVisible();
}

/** Records one charge through the form, and waits for the list to catch up. */
async function recordCharge(
  page: Page,
  charge: {
    party: "person" | "apartment";
    /**
     * The identifier the option carries, rather than the text it shows.
     *
     * The person options read "<name> - <apartment>", which is a label this spec
     * would have to reconstruct from two reads to match exactly; the identifier
     * is what the form actually sends and what the register handed back.
     */
    value: string;
    chargedOn: string;
    amount: string;
    reason: string;
  },
): Promise<void> {
  await page
    .getByRole("radio", {
      name: charge.party === "person" ? "En medlem" : "En lägenhet",
    })
    .check();
  await page
    /*
     * By role and accessible name, not by label.
     *
     * `getByLabel` compares the label ELEMENT's text, and a label that wraps its
     * control carries that control's content too: this form's hand-over field
     * computes as "Skickat till ekonomisk forvaltare Dagen underlaget skickades
     * over...", hint and all. For a wrapped select that means the label text is
     * the word plus every option, so an exact match can never equal it and a
     * substring one also reaches the radio above, since getByLabel ignores case
     * and the radios read "En medlem" and "En lagenhet".
     *
     * The accessible name is computed the other way and is just the word, which
     * is what the screenshot walk already targets its selects by.
     */
    .getByRole("combobox", {
      name: charge.party === "person" ? "Medlem" : "Lägenhet",
      exact: true,
    })
    .selectOption(charge.value);
  await page.getByLabel("Debiteringsdatum").fill(charge.chargedOn);
  await page.getByLabel("Belopp i kronor").fill(charge.amount);
  await page.getByLabel("Vad debiteringen avser").fill(charge.reason);
  await page.getByRole("button", { name: "Registrera debiteringen" }).click();
}

/** The document's row carrying this reason. */
function rowFor(page: Page, reason: string) {
  return page.locator("[data-print='document'] tbody tr", {
    hasText: reason,
  });
}

test("the board records a charge on a member and on an apartment", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureChargeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openCharges(page);

  const keyReason = `Nyckel till cykelrummet ${CHARGED.lastName}`;
  await recordCharge(page, {
    party: "person",
    value: people.charged,
    chargedOn: "2026-03-05",
    amount: "450.00",
    reason: keyReason,
  });

  const chargeRow = rowFor(page, keyReason);
  await expect(chargeRow).toHaveCount(1);
  await expect(chargeRow).toContainText(fullName(CHARGED));
  await expect(chargeRow).toContainText("450.00");

  const repairReason = `Vidaredebiterad reparation ${CHARGED.lastName}`;
  await recordCharge(page, {
    party: "apartment",
    value: people.spareApartment.id,
    chargedOn: "2026-04-02",
    amount: "1200.00",
    reason: repairReason,
  });

  const repairRow = rowFor(page, repairReason);
  await expect(repairRow).toHaveCount(1);
  // A charge on the flat names no person at all, which is the whole difference
  // between the two rows.
  await expect(repairRow).toContainText("Lägenheten");
  await expect(repairRow).toContainText(people.spareApartment.number);

  /*
   * The two together, added up, which is what whoever keeps the books checks the
   * file against. On the figure and not on the word: "Summa {{total}} kr" is an
   * interpolated string, and a variable that never arrives renders its
   * placeholder verbatim - which an assertion on the word alone would pass
   * straight through. The stamp below is asserted for the same reason, and the
   * last line refuses a placeholder anywhere on the document.
   */
  const document = page.locator("[data-print='document']");
  await expect(document).toContainText("Summa 1650.00 kr");
  await expect(document).toContainText(
    `Debiteringslängd - ${PERIOD.from} till ${PERIOD.to} - framställd`,
  );
  await expect(document).not.toContainText("{{");
});

test("a protected member is named and their apartment is withheld", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureChargeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openCharges(page);

  const reason = `Andrahandsavgift ${CHARGED.lastName}`;
  await recordCharge(page, {
    party: "person",
    value: people.protectedMember,
    chargedOn: "2026-05-04",
    amount: "800.00",
    reason,
  });

  const row = rowFor(page, reason);
  await expect(row).toHaveCount(1);
  // The name stays: whoever keeps the books has to know who to invoice. The link
  // from the name to the door does not, which is what protection withholds.
  await expect(row).toContainText(PROTECTED.name);
  await expect(row).toContainText("Skyddad, skrivs inte ut");
  await expect(row).not.toContainText(PROTECTED.apartmentNumber);
});

test("the list leaves as a CSV file and as a printed PDF", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureChargeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openCharges(page);

  /*
   * The file is produced on a click and not on the read, because producing it
   * writes the audit entry that records the disclosure. So the download is not
   * offered until the board has asked for it.
   */
  await expect(page.getByRole("link", { name: "Hämta filen" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ta fram filen" }).click();

  const download = page.getByRole("link", { name: "Hämta filen" });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute(
    "download",
    `debiteringslangd-${PERIOD.from}-${PERIOD.to}.csv`,
  );

  /*
   * The file's own bytes, read out of the link rather than saved: the anchor
   * carries the CSV the server produced, so this is the file the board hands
   * over and not a rendering of the screen.
   */
  const href = await download.getAttribute("href");
  expect(href).not.toBeNull();
  const csv = decodeURIComponent(
    (href ?? "").replace("data:text/csv;charset=utf-8,", ""),
  );
  expect(csv).toContain("chargedOn;party;name;apartment;apartmentWithheld");
  expect(csv).toContain(`Nyckel till cykelrummet ${CHARGED.lastName}`);
  // The masking holds in the file as well as on the screen, and the word is
  // what tells a bookkeeper the empty cell is deliberate.
  expect(csv).toContain(PROTECTED.name);
  expect(csv).toContain("protected");

  /*
   * The PDF is the browser's own print of the document, which is what the screen
   * offers and what the roadmap box asks for. Printed here rather than asserted
   * as a button, because a print stylesheet that dropped the table would leave
   * the button working and the document empty.
   */
  await page.emulateMedia({ media: "print" });
  await expect(
    page.getByRole("heading", { name: "Registrera en debitering" }),
  ).toBeHidden();
  await expect(page.locator("[data-print='document']")).toBeVisible();

  const pdf = await page.pdf({ format: "A4" });
  expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  expect(pdf.byteLength).toBeGreaterThan(1000);

  await page.emulateMedia({ media: "screen" });
});

test("a personal identity number in the reason is refused", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureChargeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await openCharges(page);

  const reason = `Nyckel at 811228-9874 ${CHARGED.lastName}`;
  await recordCharge(page, {
    party: "person",
    value: people.charged,
    chargedOn: "2026-06-01",
    amount: "450.00",
    reason,
  });

  await expect(page.getByText(/personnummer/i)).toBeVisible();
  // Refused, so nothing was recorded: the reason travels into a file that leaves
  // the association, and a number in it is a disclosure nobody can take back.
  await expect(rowFor(page, "811228")).toHaveCount(0);
});

test("a resident is neither offered the screen nor allowed on it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureChargeFixture(request, clientAddress);
  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT.email, RESIDENT.password);

  /*
   * Somewhere he does belong first, so the band is loaded and its links are the
   * ones this account is offered. `.first()` because the shell renders the same
   * links twice, once for the band and once for the bottom bar.
   *
   * Then the absence: a link to a screen that can only refuse teaches somebody
   * that a part of the product is broken for them rather than not theirs.
   */
  await page.goto(appPath("/issues"));
  await expect(
    page.getByRole("link", { name: "Ärenden", exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Debiteringar" })).toHaveCount(0);

  await page.goto(appPath("/charges"));
  await expect(
    page.getByRole("heading", { name: "Debiteringar mot medlem" }),
  ).toBeVisible();

  /*
   * The route is signed-in-only and the server is the boundary, so the screen
   * renders and says whose it is. What it must not do is offer a control the
   * server would refuse - so there is no list, no form, no period and no export,
   * and nothing about what the association charges anybody.
   */
  await expect(
    page.getByText(/Debiteringar hanteras av styrelsen/),
  ).toBeVisible();
  await expect(page.locator("[data-print='document']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ta fram filen" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Registrera en debitering" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Från", { exact: true })).toHaveCount(0);
});
