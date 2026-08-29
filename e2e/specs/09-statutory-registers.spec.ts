import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { auditEntriesByAction } from "../src/database";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureInstance,
} from "../src/provision";
import * as api from "../src/api";
import { appPath } from "../src/stack";

/**
 * Exit criterion 9.
 *
 * The member register and the apartment register as two documents, on two
 * screens, reached by two routes, sharing no endpoint.
 *
 * They are separate because the law separates them. The member register
 * (medlemsförteckning, EFL 5 kap. via BRL 9 kap.) is public on request, so it
 * may never carry a personal identity number; the apartment register
 * (lägenhetsförteckning, BRL 9 kap.) is confidential, carries them, and is read
 * by the board and by each tenant-owner for their own entry alone. A screen
 * that blended the two would publish the confidential one.
 *
 * Both extracts leave the building on paper, so the printable document is
 * checked as a document: what the print stylesheet keeps, and - because these
 * pages are handed over - that the public one carries no identity number in any
 * shape at all.
 */

test.describe.configure({ mode: "serial" });

/*
 * This run's own member, on this spec's own apartment. She is written into both
 * registers and neither entry can be removed, so the identity is unique to the
 * run and 1301 on Storgatan 14 belongs to no other spec.
 */
const SIGRID = {
  firstName: "Sigrid",
  lastName: uniqueSurname("Almroth"),
  email: uniqueEmail("sigrid"),
  password: "linbloma-tegelsten-2026",
  /**
   * Valid under the Luhn checksum the register enforces, and nobody's:
   * 1985-05-15 with an invented suffix.
   */
  personalIdentityNumber: "19850515-1236",
  postalStreet: "Storgatan 14",
  postalCode: "11122",
  postalCity: "Stockholm",
} as const;

const FULL_NAME = `${SIGRID.firstName} ${SIGRID.lastName}`;

const ADDRESS_NUMBER = "14";
const ADDRESS = `Storgatan ${ADDRESS_NUMBER}`;
const APARTMENT = "1301";
const DESIGNATION = `${ADDRESS} ${APARTMENT}`;
const HELD_FROM = "2026-05-01";

/** People from the shared register fixture, who must not reach her extract. */
const OTHER_MEMBERS = ["Astrid Lindqvist", "Karl Berg"] as const;

// --- what may appear on a document that is public on request -----------------

/**
 * A personal identity number, in either of the forms the register accepts.
 *
 * The same scan the screenshot capture runs before it writes an image, for the
 * same reason: the member register extract is handed to whoever asks for it, so
 * "it holds no identity number" is checked rather than trusted. Kept here
 * rather than imported because `screenshots/` belongs to the capture task and
 * nothing in `specs/` reaches into it.
 */
const IDENTITY_NUMBER = /\b\d{6}(?:\d{2})?[-+]\d{4}\b/g;

/**
 * Whether a match could be a personal identity number at all.
 *
 * A Swedish organisation number has the same shape and stands at the head of
 * every extract - the cooperative's own. The two are told apart by the date: a
 * personal identity number begins with one, and an organisation number is
 * issued with its month digits raised past twelve precisely so that it cannot.
 * A coordination number is a personal identity number with sixty added to the
 * day, so the day is allowed to run past the end of a month.
 */
function couldBeADate(candidate: string): boolean {
  const [date = ""] = candidate.split(/[-+]/);
  const month = Number(date.slice(-4, -2));
  const day = Number(date.slice(-2));
  return month >= 1 && month <= 12 && day >= 1 && day <= 91;
}

/** Everything on a document that is shaped like a personal identity number. */
function identityNumbersIn(text: string): string[] {
  return [...text.matchAll(IDENTITY_NUMBER)]
    .map((match) => match[0])
    .filter((candidate) => couldBeADate(candidate));
}

// --- fixtures ----------------------------------------------------------------

type BoardPage = {
  readonly rows: readonly {
    readonly personId: string;
    readonly name: string;
  }[];
};

async function findPerson(
  request: APIRequestContext,
  name: string,
): Promise<string | undefined> {
  const response = await request.get(
    `${stack.baseUrl}/api/address-book?search=${encodeURIComponent(name)}&filter=all&page=1`,
  );
  if (!response.ok()) {
    throw new Error(
      `GET /api/address-book answered ${String(response.status())}`,
    );
  }
  const page = (await response.json()) as BoardPage;
  return page.rows.find((row) => row.name === name)?.personId;
}

/**
 * Puts Sigrid in both registers, once however often this is asked for.
 *
 * Over HTTP rather than through the move-in screen: that flow is criterion 8's,
 * and what this spec is about is the two documents her move-in produces. The
 * look-up first is what lets any one test in this file be run on its own
 * against a stack that is already up.
 */
async function ensureSigrid(request: APIRequestContext): Promise<string> {
  await ensureInstance(request);

  const existing = await findPerson(request, FULL_NAME);
  if (existing !== undefined) {
    return existing;
  }

  const personId = await api.createPerson(request, stack.baseUrl, {
    firstName: SIGRID.firstName,
    lastName: SIGRID.lastName,
    email: SIGRID.email,
    personalIdentityNumber: SIGRID.personalIdentityNumber,
    postalStreet: SIGRID.postalStreet,
    postalCode: SIGRID.postalCode,
    postalCity: SIGRID.postalCity,
  });

  const addresses = await api.listAddresses(request, stack.baseUrl);
  const address = addresses.find(
    (candidate) => candidate.number === ADDRESS_NUMBER,
  );
  if (address === undefined) {
    throw new Error(`no address ${ADDRESS} in the register`);
  }
  const apartments = await api.listApartments(
    request,
    stack.baseUrl,
    address.id,
  );
  const apartment = apartments.find(
    (candidate) => candidate.number === APARTMENT,
  );
  if (apartment === undefined) {
    throw new Error(`no apartment ${APARTMENT} on ${ADDRESS}`);
  }

  // A tenant-ownership with its transfer: that writes her into the member
  // register and into the apartment register in one act, which is the state
  // both documents are read in below.
  await api.moveIn(request, stack.baseUrl, {
    personId,
    apartmentId: apartment.id,
    role: "MEMBER",
    movedInOn: HELD_FROM,
    transfer: {
      transferredOn: HELD_FROM,
      price: "1875000",
      agreementReference: "OVL-2026-1301",
    },
  });

  return personId;
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

async function openMemberRegister(page: Page): Promise<void> {
  await page.goto(appPath("/registers/members"));
}

async function openApartmentRegister(page: Page): Promise<void> {
  await page.goto(appPath("/registers/apartments"));
}

/** The printable region. The print stylesheet targets this attribute. */
function printableDocument(page: Page): Locator {
  return page.locator('[data-print="document"]');
}

/** The row of a register table that carries a surname. */
function rowFor(page: Page, lastName: string): Locator {
  return page.getByRole("row").filter({ hasText: lastName });
}

test("the member register is its own document and taking a copy is recorded", async ({
  page,
  api: request,
}) => {
  await ensureSigrid(request);
  const admin = await api.viewer(request, stack.baseUrl);
  const before = await auditEntriesByAction(
    "MEMBER_REGISTER_EXTRACT_GENERATED",
  );

  await signInAsAdmin(page);
  // Reached from the address book, because that is what it is an extract of.
  await page.getByRole("link", { name: "Medlemsförteckning" }).click();

  await expect(
    page.getByRole("heading", { name: "Medlemsförteckning" }),
  ).toBeVisible();

  // Said on the document itself: the absence of identity numbers is the rule
  // rather than a gap in the register.
  await expect(
    page.getByText(
      "Detta utdrag innehåller inga personnummer. Förteckningen är offentlig på begäran och får därför aldrig innehålla dem.",
    ),
  ).toBeVisible();

  const row = rowFor(page, SIGRID.lastName);
  await expect(row).toContainText(FULL_NAME);
  await expect(row).toContainText(
    `${SIGRID.postalStreet}, ${SIGRID.postalCode}, ${SIGRID.postalCity}`,
  );
  await expect(row).toContainText(DESIGNATION);
  await expect(row).toContainText(HELD_FROM);

  await expect(
    page.getByText(
      /^Utdrag ur medlemsförteckningen - nuvarande medlemmar - \d{4}-\d{2}-\d{2}$/,
    ),
  ).toBeVisible();

  // The scope is part of what the extract states, so changing it restamps the
  // document rather than only refiltering the table.
  await page.getByRole("radio", { name: "Även tidigare medlemmar" }).check();
  await expect(
    page.getByText(
      /^Utdrag ur medlemsförteckningen - nuvarande och tidigare medlemmar - \d{4}-\d{2}-\d{2}$/,
    ),
  ).toBeVisible();

  /*
   * And the wider scope carries no personal identity number either. The print
   * assertion below reads the default view, so without this a renderer that
   * leaked a number only into the all-members scope would pass every check
   * this spec makes - and that scope is the one holding people who have left,
   * whose numbers the member register may never carry at all.
   */
  expect(
    identityNumbersIn(await printableDocument(page).innerText()),
    "the all-members extract carries no personal identity number",
  ).toEqual([]);

  /*
   * Who took a copy of the member list, and when, is a question a supervisory
   * authority asks and a board asks after a leak, so the read is audited. The
   * entry names no person - it is one act over the whole register - which is
   * why it is read by action rather than by target.
   */
  await expect
    .poll(
      async () =>
        (await auditEntriesByAction("MEMBER_REGISTER_EXTRACT_GENERATED"))
          .slice(before.length)
          .map(
            (entry) =>
              (entry.context as { scope?: string } | null)?.scope ?? "",
          ),
      { message: "both extracts are recorded", timeout: 10_000 },
    )
    .toContain("all");

  const after = await auditEntriesByAction("MEMBER_REGISTER_EXTRACT_GENERATED");
  const recorded = after.at(-1)!;
  expect(recorded.actorPersonId).toBe(admin.personId);
  expect((recorded.context as { scope?: string } | null)?.scope).toBe("all");
});

test("the printed member register is the document and nothing else", async ({
  page,
  api: request,
}) => {
  await ensureSigrid(request);
  await signInAsAdmin(page);
  await openMemberRegister(page);
  await expect(printableDocument(page)).toBeVisible();

  /*
   * The medium is emulated rather than the button clicked. "Skriv ut" calls
   * window.print(), which opens the browser's own dialog and cannot be driven
   * or dismissed from a test; what the criterion is about is the stylesheet
   * behind it, and that is exactly what emulating the medium exercises.
   */
  await page.emulateMedia({ media: "print" });

  // The application frame does not come out of the printer.
  await expect(
    page.getByRole("heading", { name: "Medlemsförteckning", level: 1 }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: "Skriv ut" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Logga ut" })).toBeHidden();
  await expect(printableDocument(page)).toBeVisible();

  const printed = await printableDocument(page).innerText();
  expect(printed).toContain(FULL_NAME);
  expect(printed).toContain(SIGRID.postalStreet);
  expect(printed).toContain(DESIGNATION);
  expect(printed).toContain(HELD_FROM);

  // The one thing this document may never carry, checked as a shape rather
  // than as one person's number: the cooperative's organisation number has the
  // same form and is allowed to stand.
  expect(printed).not.toContain(SIGRID.personalIdentityNumber);
  expect(identityNumbersIn(printed)).toEqual([]);

  await page.emulateMedia({ media: null });
});

test("the full apartment register extract is a deliberate, recorded act", async ({
  page,
  api: request,
}) => {
  const sigridId = await ensureSigrid(request);
  const admin = await api.viewer(request, stack.baseUrl);

  await signInAsAdmin(page);
  await openApartmentRegister(page);
  await expect(
    page.getByRole("heading", { name: "Lägenhetsförteckning" }),
  ).toBeVisible();

  const row = rowFor(page, SIGRID.lastName);
  await expect(row.getByText("Maskerat")).toBeVisible();

  const before = await auditEntriesByAction("PROTECTED_DATA_REVEALED");

  await page
    .getByRole("button", {
      name: "Ta fram det fullständiga lagstadgade utdraget",
    })
    .click();

  await expect(
    page.getByText(
      "Den här kopian innehåller personnummer. Att den togs fram skrevs till granskningsloggen.",
    ),
  ).toBeVisible();
  await expect(
    rowFor(page, SIGRID.lastName).getByText(SIGRID.personalIdentityNumber),
  ).toBeVisible();

  await expect
    .poll(
      async () =>
        (await auditEntriesByAction("PROTECTED_DATA_REVEALED")).length,
      { message: "the full extract is recorded", timeout: 10_000 },
    )
    .toBeGreaterThan(before.length);

  const after = await auditEntriesByAction("PROTECTED_DATA_REVEALED");
  const recorded = after.at(-1)!;
  // The target is the register rather than a person: one copy discloses
  // whichever holders' numbers it happened to carry, and the context says
  // whose.
  expect(recorded.targetKind).toBe("apartmentRegister");
  expect(recorded.actorPersonId).toBe(admin.personId);
  const context = recorded.context as {
    via?: string;
    personIds?: string[];
  } | null;
  expect(context?.via).toBe("apartment-register-extract");
  expect(context?.personIds).toContain(sigridId);

  // Hiding a revealed value again is local to the screen and records nothing,
  // because nothing was read.
  await page.getByRole("button", { name: "Dölj dem igen" }).click();
  await expect(
    rowFor(page, SIGRID.lastName).getByText("Maskerat"),
  ).toBeVisible();
  expect((await auditEntriesByAction("PROTECTED_DATA_REVEALED")).length).toBe(
    after.length,
  );
});

test("a tenant-owner reads their own entry and not the member register", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const sigridId = await ensureSigrid(request);
  await ensureAccountFor(request, {
    personId: sigridId,
    email: SIGRID.email,
    password: SIGRID.password,
    clientAddress,
  });

  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(SIGRID.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(SIGRID.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  // The link a resident is offered is her own entry, not the register.
  await page.getByRole("link", { name: "Min lägenhetsförteckning" }).click();
  await expect(
    page.getByRole("heading", { name: "Din post i lägenhetsförteckningen" }),
  ).toBeVisible();

  await expect(page.getByText(DESIGNATION)).toBeVisible();
  await expect(rowFor(page, SIGRID.lastName)).toContainText(FULL_NAME);

  // Nobody else's entry is reachable from here. Not masked in it - absent from
  // it: a masked row would still say the apartment is held and by how many.
  for (const other of OTHER_MEMBERS) {
    await expect(page.getByText(other)).toHaveCount(0);
  }

  // Her own number is masked until she asks for the statutory extract, exactly
  // as the board's copy is.
  await expect(
    rowFor(page, SIGRID.lastName).getByText("Maskerat"),
  ).toBeVisible();

  const revealsBefore = await auditEntriesByAction("PROTECTED_DATA_REVEALED");

  await page
    .getByRole("button", {
      name: "Ta fram det fullständiga lagstadgade utdraget",
    })
    .click();
  await expect(
    rowFor(page, SIGRID.lastName).getByText(SIGRID.personalIdentityNumber),
  ).toBeVisible();

  /*
   * And her own reveal is recorded like anyone else's. This is the path where
   * that is easiest to get wrong: she is reading her own entry, which feels
   * like it needs no record, but the log answers "who saw this number" rather
   * than "who was not entitled to" - and a disclosure nobody wrote down is the
   * one a board cannot account for afterwards.
   */
  await expect
    .poll(
      async () =>
        (await auditEntriesByAction("PROTECTED_DATA_REVEALED")).length,
      {
        message: "the tenant-owner's own extract is recorded",
        timeout: 10_000,
      },
    )
    .toBe(revealsBefore.length + 1);

  const ownReveal = (await auditEntriesByAction("PROTECTED_DATA_REVEALED")).at(
    -1,
  )!;
  expect(ownReveal.targetKind).toBe("apartmentRegister");
  expect(ownReveal.actorPersonId).toBe(sigridId);
  const ownContext = ownReveal.context as {
    via?: string;
    personIds?: string[];
  } | null;
  expect(ownContext?.via).toBe("apartment-register-extract");
  expect(ownContext?.personIds).toContain(sigridId);

  // And the other register refuses her. It is public on request as a document
  // the board produces, which is not the same as readable by every member.
  await openMemberRegister(page);
  await expect(
    page.getByText("Förteckningen kunde inte läsas just nu."),
  ).toBeVisible();
});
