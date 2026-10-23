import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { createPerson, moveIn } from "../src/api";
import { claimApartment } from "../src/apartments";
import { grantBoardSeat } from "../src/board";
import {
  documentFixture,
  fileDocument,
  removeDocument,
} from "../src/documents";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  goToDestination,
  offeredDestinations,
  primaryNavigation,
} from "../src/navigation";
import {
  ensureAccountFor,
  ensureInstance,
  signInAsAdministrator,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The resident preview (ADR 0049): a board member sees the application as a
 * resident sees it, until they stop, open one of the board's pages or sign
 * out.
 *
 * What only a browser can show: that the preview survives the screens' own
 * reads of the viewer and a reload of the tab, that everything the board is
 * offered goes with it - the section, the phone bar's slot, the overview's line
 * and a control the board keeps on a house page - and that what is left is
 * exactly a member's offer. That last comparison is where the client's copy of
 * a resident's and a member's grants meets the server's: a grant added on one
 * side and not the other offers a destination the other does not.
 */

test.describe.configure({ mode: "serial" });

const PASSWORD = "trappuppgang-cykelkallare-2026";

/** The Mobil artboard's size, below the switch from the band to the bar. */
const PHONE = { width: 390, height: 844 } as const;

const START = "Visa som boende";
const NOTICE = "Du tittar som boende.";
const ENDED = "Förhandsgranskningen avslutades: den här sidan är styrelsens.";

interface Person {
  email: string;
  persona: string;
}

/**
 * The people of this run: a board member who lives here and is a member, a
 * member of the same household with no seat, and the property manager. Of the
 * run's own, because a seat granted to somebody in the shared fixture would
 * change what every later spec is offered as them.
 *
 * Made by the first test that asks and kept for the ones after it, since the
 * file runs serially in one worker; the request context is signed in as the
 * administrator either way.
 */
let people: { board: Person; member: Person; manager: Person } | null = null;

async function ensurePeople(
  request: APIRequestContext,
  clientAddress: string,
): Promise<{ board: Person; member: Person; manager: Person }> {
  if (people !== null) {
    await signInAsAdministrator(request);
    return people;
  }
  await ensureInstance(request);
  const home = await claimApartment(request, "14");

  const person = async (
    firstName: string,
    local: string,
    persona: string,
  ): Promise<{ personId: string; person: Person }> => {
    const email = uniqueEmail(local);
    const personId = await createPerson(request, stack.baseUrl, {
      firstName,
      lastName: uniqueSurname("Forhand"),
      email,
    });
    await ensureAccountFor(request, {
      personId,
      email,
      password: PASSWORD,
      clientAddress: clientAddressFor(clientAddress, persona),
    });
    return { personId, person: { email, persona } };
  };

  const board = await person("Berit", "forhand-berit", "board");
  const member = await person("Elin", "forhand-elin", "member");
  for (const { personId } of [board, member]) {
    await moveIn(request, stack.baseUrl, {
      personId,
      apartmentId: home.id,
      role: "MEMBER",
      movedInOn: "2026-01-02",
    });
  }
  await grantBoardSeat(board.personId);

  const manager = await person("Ove", "forhand-ove", "manager");
  await grantPropertyManager(manager.personId);

  people = {
    board: board.person,
    member: member.person,
    manager: manager.person,
  };
  return people;
}

/**
 * Signs in through the screen on the person's own client address and waits
 * for the overview it lands on. From a browser holding no session, for the
 * reason spec 34 gives.
 */
async function signIn(
  page: Page,
  clientAddress: string,
  who: Person,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, who.persona),
  });
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(who.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`^${stack.baseUrl}${appPath()}/?$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Översikt" }),
  ).toBeVisible();
}

/** The band's sign for the board's section. */
function boardSign(page: Page): Locator {
  return primaryNavigation(page).getByRole("button", {
    name: "Styrelsen",
    exact: true,
  });
}

/** The bar under the band, while the preview is on. */
function previewNotice(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: NOTICE });
}

/** The overview's line for whoever works a queue. */
function boardLine(page: Page): Locator {
  return page
    .getByRole("main")
    .getByRole("group", { name: "Styrelsen", exact: true });
}

/** Starts the preview from the band, once the band has offered it. */
async function startPreview(page: Page): Promise<void> {
  await page.getByRole("button", { name: START, exact: true }).click();
  await expect(previewNotice(page)).toBeVisible();
}

test("is offered to a board member who lives here, and not to the property manager", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { board, manager } = await ensurePeople(request, clientAddress);

  await signIn(page, clientAddress, board);
  await expect(
    page.getByRole("button", { name: START, exact: true }),
  ).toBeVisible();

  // The property manager's overview has finished reading once its line has,
  // so the absence is read from a band that had the viewer.
  await signIn(page, clientAddress, manager);
  const line = page
    .getByRole("main")
    .getByRole("group", { name: "Styrelse och förvaltare", exact: true });
  await expect(line).toBeVisible();
  await expect(line).not.toContainText("Laddar");
  await expect(page.getByRole("button", { name: START })).toHaveCount(0);
});

test("offers a board member exactly what a member of the household is offered", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { board, member } = await ensurePeople(request, clientAddress);

  await signIn(page, clientAddress, member);
  await expect.poll(() => offeredDestinations(page)).toContain("Ärenden");
  const membersOffer = await offeredDestinations(page);

  await signIn(page, clientAddress, board);
  await expect(boardLine(page)).toBeVisible();
  await startPreview(page);

  // The section, the overview's line and the switch itself are gone; the
  // notice carries the way out instead.
  await expect(boardSign(page)).toHaveCount(0);
  await expect(boardLine(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: START })).toHaveCount(0);
  await expect.poll(() => offeredDestinations(page)).toEqual(membersOffer);

  // And the phone bar is a resident's: the overview, issues and bookings.
  await page.setViewportSize(PHONE);
  await expect(primaryNavigation(page).getByRole("link")).toHaveText([
    "Översikt",
    "Ärenden",
    "Bokningar",
  ]);
  await expect(previewNotice(page)).toBeVisible();
});

test("takes the board's control off a document on the archive's shelf", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { board } = await ensurePeople(request, clientAddress);
  const document = documentFixture({
    title: "Trivselregler",
    category: "Ordningsregler",
  });
  const filed = await fileDocument(request, {
    ...document,
    audience: "MEMBER",
  });
  try {
    await signIn(page, clientAddress, board);
    await page.goto(appPath("/documents"));
    const row = page
      .getByRole("listitem")
      .filter({ hasText: document.title })
      .first();
    await expect(
      row.getByRole("button", { name: "Ändra", exact: true }),
    ).toBeVisible();

    await startPreview(page);
    // The archive is read again as the preview starts, and the row is there
    // for a member to read, without the board's control.
    await expect(row.getByText(document.title)).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Ändra", exact: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Sluta", exact: true }).click();
    await expect(previewNotice(page)).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Ändra", exact: true }),
    ).toBeVisible();
  } finally {
    await removeDocument(request, filed.id);
  }
});

test("lasts through a reload, and ends on one of the board's pages, which says why", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { board } = await ensurePeople(request, clientAddress);

  await signIn(page, clientAddress, board);
  await startPreview(page);
  await page.reload();
  await expect(previewNotice(page)).toBeVisible();
  await expect(boardSign(page)).toHaveCount(0);

  // An address under /board, typed in the same tab.
  await page.goto(appPath("/board/issues"));
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Styrelse och förvaltare Hantera ärenden",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: ENDED }),
  ).toBeVisible();
  await expect(previewNotice(page)).toHaveCount(0);
  await expect(boardSign(page)).toBeVisible();

  // Said on that page only: the next one is the board member's own again.
  await goToDestination(page, "Översikt");
  await expect(boardLine(page)).toBeVisible();
  await expect(page.getByText(ENDED)).toHaveCount(0);
});

test("ends with signing out", async ({ page, api: request, clientAddress }) => {
  const { board } = await ensurePeople(request, clientAddress);

  await signIn(page, clientAddress, board);
  await startPreview(page);
  await page.getByRole("button", { name: "Logga ut", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await signIn(page, clientAddress, board);
  await expect(boardLine(page)).toBeVisible();
  await expect(previewNotice(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: START, exact: true }),
  ).toBeVisible();
});
