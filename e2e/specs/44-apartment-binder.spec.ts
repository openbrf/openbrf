import type { APIRequestContext, Page } from "@playwright/test";

import { createPerson, moveIn, moveOut } from "../src/api";
import {
  binderEntry,
  type BinderEntryFixture,
  fetchStored,
  readBinders,
} from "../src/apartment-binder";
import { claimApartment, type ClaimedApartment } from "../src/apartments";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import {
  ensureAccountFor,
  ensureInstance,
  signInAsAdministrator,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The apartment binder, as far as a deployed instance can show it.
 *
 * What is here is the half that only exists once the image is serving one
 * origin and four people with real residencies are looking at it.
 *
 * **The papers belong to the apartment and the reading follows the residency.**
 * The board files a drawing and an alteration permission into one home's
 * binder; the tenant-owner reads both and adds a manual of her own; the person
 * who lives there without holding the apartment reads the two addressed to the
 * household and never the one addressed to the tenant-owners - neither on the
 * screen nor at the file's own address. Then the apartment changes hands on one
 * day, and the same entries are read by somebody who has never met any of them
 * while the person who filed one of them has no binder at all. That whole path
 * crosses four sessions, two capabilities and a move, which is what makes it a
 * test only a served instance can carry.
 *
 * **A household is never shown who filed an entry.** Asserted as an absence on
 * the screen, because that is where it would leak: the answer a household is
 * given carries no name, and the row says the board or a tenant-owner instead.
 *
 * **A refusal says which of the two fields was wrong.** A title and a file name
 * are both checked for a personal identity number, and the person filing can
 * only act on the refusal if it says which of them carried one - the title is
 * retyped in the field above, the file name is changed on their own computer.
 *
 * Every person here is created by this spec. The shared fixture writes
 * residencies and not the member register, none of its four people holds a
 * board seat, and specs 24, 27 and 35 seat the shared administrator - so a test
 * built on any of them would pass or fail on the order the suite happened to
 * run in.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "parmhylla-snickarglad-2026";

/** Today, on the association's clock rather than on this machine's. */
function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const field = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${field("year")}-${field("month")}-${field("day")}`;
}

interface Person {
  personId: string;
  email: string;
  name: string;
}

/** Fills in the sign-in form on screen and waits for the answer. */
async function submitSignIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  // exact, because "Logga in" is a prefix of the passkey button's
  // "Logga in med en nyckel" and the accessible-name match is a substring one.
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
}

/** Signs one person in on their own client address and opens the binder. */
async function openBinderAs(
  page: Page,
  person: Person,
  clientAddress: string,
  persona: string,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await submitSignIn(page, person.email, PASSWORD);
  await expect(page).not.toHaveURL(/\/sign-in(\?|$)/);
  await page.goto(appPath("/apartment-binder"));
}

/** Somebody living in an apartment, created and moved in by this spec. */
async function ensureResident(
  request: APIRequestContext,
  input: {
    firstName: string;
    local: string;
    apartmentId: string;
    role: "MEMBER" | "RESIDENT";
    movedInOn: string;
    clientAddress: string;
  },
): Promise<Person & { residencyId: string }> {
  const lastName = uniqueSurname("Parm");
  const email = uniqueEmail(input.local);
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: input.firstName,
    lastName,
    email,
  });
  const moved = await moveIn(request, stack.baseUrl, {
    personId,
    apartmentId: input.apartmentId,
    role: input.role,
    movedInOn: input.movedInOn,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: PASSWORD,
    clientAddress: input.clientAddress,
  });

  return {
    personId,
    email,
    name: `${input.firstName} ${lastName}`,
    residencyId: moved.residencyId,
  };
}

/** A board member with a seat and no home here: the other half of the screen. */
async function ensureBoardMember(
  request: APIRequestContext,
  clientAddress: string,
): Promise<Person> {
  const lastName = uniqueSurname("Styrelse");
  const email = uniqueEmail("parm-styrelse");
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: "Bo",
    lastName,
    email,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: PASSWORD,
    clientAddress,
  });
  await grantBoardSeat(personId);

  return { personId, email, name: `Bo ${lastName}` };
}

/**
 * Files one entry through the form on screen.
 *
 * The audience is left at what the kind preset, which is what a person filing
 * ordinarily does: the form offers the answer the kind implies. That the preset
 * is the right one is asserted where it decides something - the permission is
 * the tenant-owners' and the lodger below never sees it.
 */
async function fileThroughTheForm(
  page: Page,
  input: { kind: string; entry: BinderEntryFixture; datedOn?: string },
): Promise<void> {
  // getByRole for the select: a label element's text carries every option
  // inside it, so getByLabel would match on the options as well.
  await page
    .getByRole("combobox", { name: /^Vad det är/ })
    .selectOption({ label: input.kind });
  await page.getByLabel(/^Titel/).fill(input.entry.title);
  if (input.datedOn !== undefined) {
    await page
      .getByLabel(/^(Beslutsdatum|Datum på handlingen)/)
      .fill(input.datedOn);
  }
  await page.getByLabel("Fil", { exact: true }).setInputFiles({
    name: input.entry.fileName,
    mimeType: "application/pdf",
    buffer: input.entry.bytes,
  });
  await page.getByRole("button", { name: "Lägg in handlingen" }).click();
}

/*
 * What the first test makes, held for the tests after it.
 *
 * The file is serial and runs in one worker, so this is the order the tests are
 * written in rather than an assumption about them. A test that finds them
 * missing says so on the line that needs them.
 */
let home: ClaimedApartment | null = null;
let owner: (Person & { residencyId: string }) | null = null;
let lodger: Person | null = null;
let board: Person | null = null;
/** The permission's own address, read off the link the board's screen renders. */
let permissionUrl: string | null = null;
const drawing = binderEntry("Ritning badrum");
const permission = binderEntry("Tillstand stambyte");
const manual = binderEntry("Bruksanvisning tvattmaskin");

function made<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`${what} was not created: an earlier test did not finish`);
  }
  return value;
}

test.describe("an apartment binder", () => {
  test("is filled by the board and read by the household with no name on it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    home = await claimApartment(request, "12");
    owner = await ensureResident(request, {
      firstName: "Elin",
      local: "parm-elin",
      apartmentId: home.id,
      role: "MEMBER",
      movedInOn: "2026-01-02",
      clientAddress: clientAddressFor(clientAddress, "owner"),
    });
    lodger = await ensureResident(request, {
      firstName: "Nils",
      local: "parm-nils",
      apartmentId: home.id,
      role: "RESIDENT",
      movedInOn: "2026-01-02",
      clientAddress: clientAddressFor(clientAddress, "lodger"),
    });
    board = await ensureBoardMember(
      request,
      clientAddressFor(clientAddress, "board"),
    );

    await openBinderAs(page, board, clientAddress, "board");

    /*
     * Nothing is chosen for them. Opening a binder is what discloses a
     * household's papers and what the server writes to the audit log, so the
     * board picks the door it means to open.
     */
    await expect(
      page.getByRole("heading", { name: "Alla lägenheters pärmar" }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: /^Lägenhet/ })
      .selectOption(home.id);
    await expect(
      page.getByText("Ingenting har lagts i den här pärmen ännu."),
    ).toBeVisible();

    await fileThroughTheForm(page, { kind: "Ritning", entry: drawing });
    await expect(
      page.getByRole("link", { name: `Öppna ${drawing.title}` }),
    ).toBeVisible();

    /*
     * The board's own kind, with the day it decided. The database refuses the
     * combination without one, and the form asks for it - and the kind presets
     * the audience to the tenant-owners, which is what decides that the lodger
     * below never sees this entry at all.
     */
    await page
      .getByRole("combobox", { name: /^Vad det är/ })
      .selectOption({ label: "Tillstånd till ändring" });
    await expect(page.getByLabel(/^Bostadsrättshavarna/)).toBeChecked();
    await fileThroughTheForm(page, {
      kind: "Tillstånd till ändring",
      entry: permission,
      datedOn: "2026-02-17",
    });
    const filed = page.getByRole("link", {
      name: `Öppna ${permission.title}`,
    });
    await expect(filed).toBeVisible();
    // Where the bytes are, as the screen itself points at them: the media route
    // decides for itself who may have them, and the test after this one asks
    // it with the wrong session.
    permissionUrl = await filed.getAttribute("href");

    // The board's half names who filed what, which is the half a household
    // never sees.
    await expect(
      page.getByText(`Inlagd av ${board.name}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Visas i dag för 1 bostadsrättshavare och 1 övrig boende.",
      ),
    ).toBeVisible();

    await openBinderAs(page, owner, clientAddress, "owner");

    await expect(
      page.getByRole("link", { name: `Öppna ${drawing.title}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: `Öppna ${permission.title}` }),
    ).toBeVisible();
    // The board filed both, and that is the whole of what this household is
    // told about who: no name, here or anywhere else on the screen. Counted in
    // the room, because the band's board section is signed with the same word.
    await expect(
      page.getByRole("main").getByText("Styrelsen", { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText(board.name)).toHaveCount(0);
    await expect(page.getByText(/Inlagd av/)).toHaveCount(0);

    // And she files her own, which the form says will stay with the apartment.
    await expect(
      page.getByText(/Det du lägger i pärmen följer lägenheten/),
    ).toBeVisible();
    await fileThroughTheForm(page, {
      kind: "Bruksanvisning och garanti",
      entry: manual,
    });
    await expect(
      page.getByRole("link", { name: `Öppna ${manual.title}` }),
    ).toBeVisible();
    await expect(page.getByText("Du", { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: `Ta ut ${manual.title} ur pärmen` }),
    ).toBeVisible();
  });

  test("shows a resident who is not a tenant-owner less than it shows one", async ({
    page,
    clientAddress,
  }) => {
    const household = made(lodger, "the lodger");
    await openBinderAs(page, household, clientAddress, "lodger");

    // What is addressed to the household, and nothing else.
    await expect(
      page.getByRole("link", { name: `Öppna ${drawing.title}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: `Öppna ${manual.title}` }),
    ).toBeVisible();
    await expect(page.getByText(permission.title)).toHaveCount(0);

    // No form either: filing is the tenant-owner's, and an offer this account
    // would only be refused is worse than no offer.
    await expect(page.getByText("Lägg i pärmen")).toHaveCount(0);
    await expect(page.getByText("Ta ut", { exact: true })).toHaveCount(0);

    /*
     * And the file behind the entry is refused as well, at its own address,
     * with the same answer a file that does not exist gets. The screen not
     * showing a row is a screen; this is the decision.
     */
    const listing = await readBinders(page.request);
    expect(listing).toHaveLength(1);
    const titles = listing[0]?.entries.map((entry) => entry.title) ?? [];
    expect(titles).not.toContain(permission.title);

    const [refused, missing] = await Promise.all([
      fetchStored(page.request, made(permissionUrl, "the permission's file")),
      fetchStored(
        page.request,
        "/api/media/00000000-0000-4000-8000-000000000000",
      ),
    ]);
    expect(refused.status).toBe(404);
    expect(refused.body).toBe(missing.body);
  });

  test("refuses a filing that carries a personal identity number, and says which field", async ({
    page,
    clientAddress,
  }) => {
    const tenantOwner = made(owner, "the tenant-owner");
    await openBinderAs(page, tenantOwner, clientAddress, "owner");

    /*
     * The file name, which is the half a screen can get wrong: it is stored on
     * the row, answered in every listing and echoed in the download
     * disposition, so a number in it reaches the next household exactly as one
     * in the title would - and somebody told only that "the filing" carries one
     * will retype the title, be refused again, and have learnt nothing.
     */
    const named = binderEntry("Besiktning");
    await fileThroughTheForm(page, {
      kind: "Besiktning och kontroll",
      entry: { ...named, fileName: `19811218-9876-${named.fileName}` },
    });

    const refusal = page.getByRole("alert");
    await expect(refusal).toContainText("innehåller ett personnummer");
    await expect(refusal).toContainText("Det står i filnamnet");
    await expect(refusal).not.toContainText("Det står i titeln");
    // Never the value the scan caught: that is exactly what must not travel
    // back into a response, a log or a screen.
    await expect(refusal).not.toContainText("19811218");

    // And the title, which is the other half.
    const inTitle = binderEntry("Besiktning 19811218-9876");
    await fileThroughTheForm(page, {
      kind: "Besiktning och kontroll",
      entry: inTitle,
    });
    await expect(refusal).toContainText("Det står i titeln");
    await expect(refusal).not.toContainText("Det står i filnamnet");
  });

  test("stays with the apartment when it changes hands on one day", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    // The request context is one per test, and the register writes below are
    // the board's: the test that made the instance signed in on its own.
    await signInAsAdministrator(request);
    const leaving = made(owner, "the tenant-owner");
    const apartment = made(home, "the apartment");
    const day = today();

    /*
     * A transfer as the register records one: the residency ends today and the
     * next one begins today. Nothing is copied and nothing is moved - the last
     * household stops on the day its residency ends, and the next reads the
     * same rows from the day its own begins.
     */
    await moveOut(request, stack.baseUrl, {
      residencyId: leaving.residencyId,
      movedOutOn: day,
    });
    const arriving = await ensureResident(request, {
      firstName: "Karin",
      local: "parm-karin",
      apartmentId: apartment.id,
      role: "MEMBER",
      movedInOn: day,
      clientAddress: clientAddressFor(clientAddress, "arriving"),
    });

    await openBinderAs(page, arriving, clientAddress, "arriving");

    for (const entry of [drawing, permission, manual]) {
      await expect(
        page.getByRole("link", { name: `Öppna ${entry.title}` }),
      ).toBeVisible();
    }
    // Two from the board and one from whoever held the apartment before her,
    // and not one of the three names a person. Counted in the room, as above.
    await expect(
      page.getByRole("main").getByText("Styrelsen", { exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByText("En bostadsrättshavare", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText(leaving.name)).toHaveCount(0);
    // Nothing of hers to take out: she filed none of it.
    await expect(page.getByText("Ta ut", { exact: true })).toHaveCount(0);

    // And the household that left reads no binder at all, although one of the
    // entries is still the one it filed.
    await openBinderAs(page, leaving, clientAddress, "owner");
    await expect(
      page.getByText(/Registret har ingen lägenhet för det här kontot/),
    ).toBeVisible();
    expect(await readBinders(page.request)).toHaveLength(0);
  });
});
