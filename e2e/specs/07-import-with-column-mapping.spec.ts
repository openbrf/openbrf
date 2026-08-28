import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { memberRegisterEntriesByRecordedName } from "../src/database";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { buildWorkbook } from "../src/xlsx";
import * as api from "../src/api";

/**
 * Exit criterion 7.
 *
 * An existing member list is loaded from a file: the columns are mapped, the
 * preview says what each row would do, and only then is the register written.
 *
 * The preview step is the criterion rather than a convenience. An import writes
 * the statutory member register, which the database will not let anyone update
 * or delete, so a row that turns out to be somebody else is a mistake that can
 * only be answered with a second entry. This spec therefore drives all four
 * outcomes through the screen - a new person, a person the file matched, a row
 * matching two people and waiting for a decision, and a row that cannot be read
 * at all - before anything is applied.
 *
 * The CSV path runs end to end, which is what the criterion asks for. The
 * workbook is taken as far as the mapping step: the parser has its own tests at
 * the integration level, and what a browser adds is that the upload control
 * accepts a real .xlsx.
 */

test.describe.configure({ mode: "serial" });

/*
 * Everyone this spec writes is this run's, and the register keeps them: nothing
 * in the suite can delete a person, so a fixed name would be found twice on the
 * second run against one database. The apartments are this spec's own too -
 * 1501 and 1602 on Storgatan 12 belong to no other spec.
 */
const GUNNAR = {
  firstName: "Gunnar",
  lastName: uniqueSurname("Wikander"),
  email: uniqueEmail("gunnar"),
  /**
   * Valid under the Luhn checksum the register enforces, and nobody's:
   * 1970-12-31 with an invented suffix.
   */
  personalIdentityNumber: "19701231-1119",
} as const;

/** In the register already, with an email and nothing else, so the file updates her. */
const GRETA = {
  firstName: "Greta",
  lastName: uniqueSurname("Sandell"),
  email: uniqueEmail("greta"),
} as const;

/**
 * Two people of one name in one apartment - a parent and a child, as the
 * register meets them - which is what makes the file's row ambiguous.
 */
const BO = {
  firstName: "Bo",
  lastName: uniqueSurname("Ekwall"),
} as const;

/** The row the import refuses: a date nobody can read unambiguously. */
const BENGT = {
  firstName: "Bengt",
  lastName: uniqueSurname("Frisk"),
} as const;

const MEMBER_APARTMENT = "1501";
const SHARED_APARTMENT = "1602";

const CSV_NAME = "medlemslista.csv";
const WORKBOOK_NAME = "medlemslista.xlsx";

const HEADERS = [
  "Adress",
  "Lägenhetsnummer",
  "Förnamn",
  "Efternamn",
  "Roll",
  "E-postadress",
  "Personnummer",
  "Inflyttningsdatum",
  "Anteckning",
] as const;

/** The file the board is loading, as they would have exported it. */
const ROWS: readonly (readonly string[])[] = [
  [
    "Storgatan 12",
    MEMBER_APARTMENT,
    GUNNAR.firstName,
    GUNNAR.lastName,
    "Medlem",
    GUNNAR.email,
    GUNNAR.personalIdentityNumber,
    "2020-01-01",
    "Ny medlem",
  ],
  [
    "Storgatan 12",
    MEMBER_APARTMENT,
    GRETA.firstName,
    GRETA.lastName,
    "Boende",
    GRETA.email,
    "",
    "2021-03-15",
    "Finns redan",
  ],
  [
    "Storgatan 12",
    SHARED_APARTMENT,
    BO.firstName,
    BO.lastName,
    "Boende",
    "",
    "",
    "2022-05-01",
    "Två med samma namn",
  ],
  [
    "Storgatan 12",
    MEMBER_APARTMENT,
    BENGT.firstName,
    BENGT.lastName,
    "Boende",
    "",
    "",
    // Neither the fourth of January nor the first of April until somebody says
    // which, so the import refuses it rather than choosing.
    "01/02/2020",
    "Fel datumformat",
  ],
];

// The delimiter the file uses. Swedish spreadsheets write semicolons, and the
// parser tries that one first.
const csv = [HEADERS, ...ROWS].map((row) => row.join(";")).join("\n");

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

async function openImport(page: Page): Promise<void> {
  await page.goto("/import");
}

/**
 * The import screen, on its upload step, from wherever it opened.
 *
 * The screen asks the API which import ran last and opens on it, so a board
 * member who closed the tab finds it again rather than an empty form suggesting
 * nothing happened. That is also what greets a second run against a stack that
 * is already up, and starting another list is how the screen gets back to the
 * first step. Which of the two is on screen is settled by waiting for either
 * rather than by looking once, so this cannot race the load.
 */
async function openUploadStep(page: Page): Promise<void> {
  await openImport(page);
  const another = page.getByRole("button", {
    name: "Importera en annan lista",
  });
  const file = page.getByLabel("Välj en fil");
  await expect(another.or(file)).toBeVisible();
  if (await another.isVisible()) {
    await another.click();
  }
  await expect(file).toBeVisible();
}

/** The apartment the register holds under one address and number. */
async function apartmentIdFor(
  request: APIRequestContext,
  addressNumber: string,
  apartmentNumber: string,
): Promise<string> {
  const addresses = await api.listAddresses(request, stack.baseUrl);
  const address = addresses.find(
    (candidate) => candidate.number === addressNumber,
  );
  if (address === undefined) {
    throw new Error(`no address Storgatan ${addressNumber} in the register`);
  }
  const apartments = await api.listApartments(
    request,
    stack.baseUrl,
    address.id,
  );
  const apartment = apartments.find(
    (candidate) => candidate.number === apartmentNumber,
  );
  if (apartment === undefined) {
    throw new Error(
      `no apartment ${apartmentNumber} on Storgatan ${addressNumber}`,
    );
  }
  return apartment.id;
}

/**
 * The number beside one word in a description list.
 *
 * Both the preview's summary and the finished import's counts are dt/dd pairs,
 * so the number is only addressable through the word it belongs to. The word is
 * matched exactly: "Importeras inte" is a summary heading, an outcome on a row
 * and an option in the decision select, and only the first of them is here.
 */
function countBeside(page: Page, label: string): Locator {
  return page
    .locator("dl > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
}

/** The select that says which field one column of the file goes to. */
function fieldFor(page: Page, column: string): Locator {
  return page.getByRole("combobox", {
    name: `Fält i registret för ${column}`,
    exact: true,
  });
}

/** The row of the preview table that carries a surname. */
function previewRow(page: Page, lastName: string): Locator {
  return page.getByRole("row").filter({ hasText: lastName });
}

test("a CSV is mapped, previewed and applied, and writes the register", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);

  // The two people who make the third row ambiguous, and the one the file will
  // find rather than create. Written over HTTP because this spec is about the
  // import, not about how they got there.
  await api.createPerson(request, stack.baseUrl, {
    firstName: GRETA.firstName,
    lastName: GRETA.lastName,
    email: GRETA.email,
  });

  const shared = await apartmentIdFor(request, "12", SHARED_APARTMENT);
  for (let index = 0; index < 2; index += 1) {
    const personId = await api.createPerson(request, stack.baseUrl, {
      firstName: BO.firstName,
      lastName: BO.lastName,
    });
    await api.moveIn(request, stack.baseUrl, {
      personId,
      apartmentId: shared,
      role: "RESIDENT",
      movedInOn: "2019-09-01",
    });
  }

  await signInAsAdmin(page);
  await openUploadStep(page);

  await expect(
    page.getByRole("heading", { name: "Importera medlemslista" }),
  ).toBeVisible();

  await page.getByLabel("Välj en fil").setInputFiles({
    name: CSV_NAME,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: "Läs filen" }).click();

  // --- the mapping step ------------------------------------------------------

  await expect(page.getByRole("heading", { name: "Kolumnerna" })).toBeVisible();
  await expect(
    page.getByText(`${CSV_NAME}: 4 rader, 9 kolumner`),
  ).toBeVisible();

  // The guess comes from the column titles and is shown rather than acted on.
  // The ones worth checking are the two fields a wrong guess cannot be
  // corrected out of afterwards, and the column nothing in the register wants.
  await expect(fieldFor(page, "Personnummer")).toHaveValue(
    "personalIdentityNumber",
  );
  await expect(fieldFor(page, "Inflyttningsdatum")).toHaveValue("movedInOn");
  // The ignore option carries an empty value; it reads "Importera inte".
  await expect(fieldFor(page, "Anteckning")).toHaveValue("");

  await page.getByRole("button", { name: "Förhandsgranska importen" }).click();

  // --- the preview step ------------------------------------------------------

  await expect(
    page.getByRole("heading", { name: "Vad detta skulle göra" }),
  ).toBeVisible();

  await expect(countBeside(page, "Ny")).toHaveText("1");
  await expect(countBeside(page, "Uppdatering")).toHaveText("1");
  await expect(countBeside(page, "Kräver ett val")).toHaveText("1");
  await expect(countBeside(page, "Importeras inte")).toHaveText("1");

  // The file carries a personal identity number for the new member. The preview
  // reports that it does and never shows it: a preview is not a register view.
  await expect(
    previewRow(page, GUNNAR.lastName).getByText(
      "Filen innehåller ett personnummer för den här raden.",
    ),
  ).toBeVisible();
  await expect(page.getByText(GUNNAR.personalIdentityNumber)).toHaveCount(0);

  // The person the file found rather than created, and what it matched her on.
  await expect(previewRow(page, GRETA.lastName)).toContainText("Uppdatering");
  await expect(previewRow(page, GRETA.lastName)).toContainText("E-postadress");

  // The row that cannot be read says why, in the board's own language.
  await expect(previewRow(page, BENGT.lastName)).toContainText(
    "Datum måste skrivas som ÅÅÅÅ-MM-DD.",
  );

  // Nothing is written while a row still matches two people.
  const apply = page.getByRole("button", { name: "Genomför importen" });
  await expect(apply).toBeDisabled();
  await expect(
    page.getByText(
      "Vissa rader matchar fler än en person. Välj vilken var och en är innan du importerar.",
    ),
  ).toBeVisible();

  /*
   * The decision, and the one the board can make here. Both candidates carry
   * the same name - that is what made the row ambiguous - so neither of them
   * can be picked out of the select by what it reads; leaving the row out is
   * the answer a board gives when the file cannot tell them apart either.
   */
  await previewRow(page, BO.lastName)
    .getByRole("combobox", { name: "Den här raden är" })
    .selectOption({ label: "Importeras inte" });
  await expect(apply).toBeEnabled();

  await apply.click();

  // --- the import ------------------------------------------------------------

  /*
   * Only the terminal state is asserted. The register write is a background
   * job, so "Importen pågår" is a state the screen may pass through in less
   * time than a poll takes, and a spec that waited for it would fail on a fast
   * machine rather than on a broken import.
   */
  await expect(
    page.getByRole("heading", { name: "Importen är klar" }),
  ).toBeVisible({ timeout: 30_000 });

  const progress = page.getByRole("progressbar", {
    name: "Hur stor del av filen som importerats",
  });
  await expect(progress).toHaveAttribute("aria-valuemax", "4");
  await expect(progress).toHaveAttribute("aria-valuenow", "4");

  /*
   * What the import wrote, row by row: Gunnar created with a residency and the
   * statutory entry his membership requires, Greta found and given the
   * residency she did not have, Bo's row left out by the decision above, and
   * the unreadable date counted as a problem rather than guessed at.
   *
   * These six are read off the apply service rather than observed; the first
   * real run against the image is what pins them, and "Uppdaterade personer" is
   * the one to look at first - the update path counts a row it matched whether
   * or not the row had anything left to fill in.
   */
  await expect(countBeside(page, "Tillagda personer")).toHaveText("1");
  await expect(countBeside(page, "Uppdaterade personer")).toHaveText("1");
  await expect(countBeside(page, "Skapade boenden")).toHaveText("2");
  await expect(
    countBeside(page, "Skrivna poster i medlemsförteckningen"),
  ).toHaveText("1");
  await expect(countBeside(page, "Överhoppade rader")).toHaveText("1");
  await expect(countBeside(page, "Rader med problem")).toHaveText("1");

  // A board member who closed the tab finds the import again by asking the API
  // which one ran, rather than by holding on to anything.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Importen är klar" }),
  ).toBeVisible();
  await expect(page.getByText(`Från ${CSV_NAME}`)).toBeVisible();

  // And the statutory entry is in the archive, under the name the register
  // recorded at the time.
  await expect
    .poll(
      async () =>
        (await memberRegisterEntriesByRecordedName(GUNNAR.lastName)).map(
          (entry) => entry.eventType,
        ),
      {
        message: "the import wrote the member register entry",
        timeout: 10_000,
      },
    )
    .toEqual(["ENTRY"]);
});

test("a workbook is read to the mapping step", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await signInAsAdmin(page);
  await openImport(page);

  // The screen opens on the import that ran last, which is the one above.
  await expect(
    page.getByRole("heading", { name: "Importen är klar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Importera en annan lista" }).click();

  const workbook = buildWorkbook([
    [...HEADERS],
    [
      "Storgatan 12",
      MEMBER_APARTMENT,
      "Signe",
      uniqueSurname("Holmgren"),
      "Boende",
      "",
      "",
      "2023-02-01",
      "Från kalkylbladet",
    ],
  ]);

  await page.getByLabel("Välj en fil").setInputFiles({
    name: WORKBOOK_NAME,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await page.getByRole("button", { name: "Läs filen" }).click();

  await expect(page.getByRole("heading", { name: "Kolumnerna" })).toBeVisible();
  await expect(
    page.getByText(`${WORKBOOK_NAME}: 1 rader, 9 kolumner`),
  ).toBeVisible();
  await expect(fieldFor(page, "Personnummer")).toHaveValue(
    "personalIdentityNumber",
  );
  await expect(fieldFor(page, "Lägenhetsnummer")).toHaveValue(
    "apartmentNumber",
  );

  /*
   * And no further. The criterion's end-to-end path is the CSV above; what a
   * browser adds here is that the upload control takes a real workbook. Backing
   * out leaves the register untouched, which is the point of stopping here.
   */
  await page.getByRole("button", { name: "Välj en annan fil" }).click();
  await expect(page.getByRole("heading", { name: "Filen" })).toBeVisible();
});
