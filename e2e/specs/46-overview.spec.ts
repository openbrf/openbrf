import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { createPerson } from "../src/api";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { primaryNavigation } from "../src/navigation";
import { ensureAccountFor, ensureRegisterFixture } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The overview, end to end: the page every sign-in lands on.
 *
 * A resident sees what they sent in and are still waiting on, their bookings,
 * the next events and the newest news, and nothing of the board's. The board
 * sees the same below one line led by its sign: how much is waiting in the
 * queues it works, and the way to the board's front page, where each queue has
 * a row with a count that matches what the queue's own endpoint answers.
 *
 * What only the deployed stack can show: that a sign-in lands here, that the
 * page asks for nothing the account is refused - every 403 the page draws is
 * collected and must be none - and that the counts are the server's.
 *
 * The queues are the whole instance's and every spec shares them, so a count
 * is compared with the API's own answer at the same moment rather than with a
 * number written here.
 */

test.describe.configure({ mode: "serial" });

/** The password spec 03 activates the shared fixture's accounts with. */
const PASSWORD = "granngarden-kastanj-2026";

/** From the shared fixture: he lives in 12/1001 and holds no tenant-ownership. */
const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * Somebody on the board, with a seat and no home here.
 *
 * Of this run's own rather than the administrator: the administrator holds
 * every capability and no seat, and the board's queue of reported messages is
 * answered from the seat. A seat granted to somebody in the shared fixture
 * would change what every later spec is offered as them.
 */
async function ensureBoardMember(
  request: APIRequestContext,
  clientAddress: string,
): Promise<{ email: string; password: string }> {
  const email = uniqueEmail("oversikt-styrelse");
  const password = "trappstadning-cykelrum-2026";
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: "Siv",
    lastName: uniqueSurname("Styrelse"),
    email,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password,
    clientAddress,
  });
  await grantBoardSeat(personId);
  return { email, password };
}

async function browseAs(
  page: Page,
  clientAddress: string,
  persona: string,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
}

/**
 * Signs in through the screen and waits for the overview it lands on.
 *
 * From a browser holding no session, for the reason spec 34 gives: the
 * sign-in screen sends somebody already signed in straight on.
 */
async function signInThroughTheScreen(
  page: Page,
  who: { email: string; password: string },
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(who.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`^${stack.baseUrl}${appPath()}/?$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Översikt" }),
  ).toBeVisible();
}

/** Every API path the page was refused, from here on. */
function refusals(page: Page): string[] {
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 403 && response.url().includes("/api/")) {
      refused.push(new URL(response.url()).pathname);
    }
  });
  return refused;
}

/** The panel with this heading. */
function panel(page: Page, heading: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: heading }) });
}

/** The board's one line on the overview, a group named by its sign. */
function boardLine(page: Page): Locator {
  return page
    .getByRole("main")
    .getByRole("group", { name: "Styrelsen", exact: true });
}

/** One queue's row on the board's front page, found by the queue's name. */
function queueRow(page: Page, name: string): Locator {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

/** The queues a board seat works, by the names their rows carry. */
const BOARD_QUEUES = [
  "Nya ärenden",
  "Obesvarade trådar i styrelsens brevlåda",
  "Motioner som inte är mottagna",
  "Ansökningar om andrahandsupplåtelse att besluta om",
  "Nyckelbeställningar att besvara",
  "Mäklares förfrågningar om uppdatering",
  "Kontoansökningar att besluta om",
  "Anmälda inlägg",
];

/** What a row says is waiting; `more` when it reads "N eller fler". */
interface Shown {
  count: number;
  more: boolean;
}

/**
 * What the overview's line says is waiting: "Inget väntar" is nought, "N saker
 * väntar" the sum of the queues, and "Minst N saker väntar" a floor, when one
 * of the queues answered with one page of a longer one.
 */
async function totalOn(line: Locator): Promise<Shown> {
  await expect(line).not.toContainText("Laddar");
  const text = (await line.textContent()) ?? "";
  if (text.includes("Inget väntar")) {
    return { count: 0, more: false };
  }
  const match = /(Minst )?(\d+) sak(?:er)? väntar/.exec(text);
  if (match === null) {
    throw new Error(`no total on the line: ${text}`);
  }
  return { count: Number(match[2]), more: match[1] !== undefined };
}

/**
 * What a row says is waiting: "Inget väntar" is nought, and "N eller fler" is
 * a floor, shown when the queue's answer was one page of a longer one.
 *
 * Read once the row has stopped loading, so a count is never read off the
 * moment before it arrives.
 */
async function countOn(row: Locator): Promise<Shown> {
  await expect(row).not.toContainText("Laddar");
  const text = (await row.textContent()) ?? "";
  if (text.includes("Inget väntar")) {
    return { count: 0, more: false };
  }
  const match = /(\d+)( eller fler)?\s*$/.exec(text.trim());
  if (match === null) {
    throw new Error(`no count on the row: ${text}`);
  }
  return { count: Number(match[1]), more: match[2] !== undefined };
}

/** A whole queue, read in one answer. */
const all = (count: number): Shown => ({ count, more: false });

/**
 * The report queue's page size, as the API sets it (REPORTS_PER_PAGE). The
 * queue says nothing about a page behind this one, so the overview reads a
 * full page as a floor.
 */
const REPORTS_PER_PAGE = 50;

test("a resident lands on their own matters, bookings, events and news", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const people = await ensureRegisterFixture(request);
  const personId = people.get(RESIDENT.name);
  if (personId === undefined) {
    throw new Error(`${RESIDENT.name} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId,
    email: RESIDENT.email,
    password: RESIDENT.password,
    clientAddress: clientAddressFor(clientAddress, "resident"),
  });

  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT);

  // Something of his own to wait on: a key order the board has not answered.
  await page.goto(appPath("/key-orders"));
  const note = `Till förrådet ${String(Date.now())}`;
  const form = panel(page, "Beställ en nyckel eller en tagg");
  await form.getByLabel("Vad du behöver").selectOption("KEY");
  await form.getByLabel("Hur många").fill("3");
  await form
    .getByLabel("Vilken dörr, eller vad den ska användas till")
    .fill(note);
  await form.getByRole("button", { name: "Skicka beställningen" }).click();
  await expect(panel(page, "Dina beställningar").getByText(note)).toBeVisible();

  // From here on, every refusal the overview draws is collected.
  const refused = refusals(page);
  await primaryNavigation(page)
    .getByRole("button", { name: "Föreningen" })
    .click();
  await page.getByRole("link", { name: "Översikt", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${stack.baseUrl}${appPath()}/?$`));

  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Väntar på föreningen",
    "Dina kommande bokningar",
    "Nästa evenemang",
    "Senaste nyheterna",
  ]);
  // Nothing of the board's: no line led by its sign, and no way to its front
  // page.
  await expect(boardLine(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Att hantera" })).toHaveCount(0);

  const waiting = panel(page, "Väntar på föreningen");
  const order = waiting
    .getByRole("listitem")
    .filter({ hasText: "3 x Nyckel" })
    .first();
  await expect(order).toContainText("Nyckelbeställning");
  await expect(order).toContainText("Hos styrelsen");
  await expect(order.getByRole("link")).toHaveAttribute(
    "href",
    appPath("/key-orders"),
  );

  // Every panel has read: none is still loading and none failed.
  for (const heading of [
    "Väntar på föreningen",
    "Dina kommande bokningar",
    "Nästa evenemang",
    "Senaste nyheterna",
  ]) {
    await expect(panel(page, heading)).not.toContainText("Laddar");
    await expect(panel(page, heading)).not.toContainText("kunde inte läsas");
  }
  expect(refused).toEqual([]);
});

test("a board member gets one line, and a row per queue on the board's front page", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureRegisterFixture(request);
  const member = await ensureBoardMember(
    request,
    clientAddressFor(clientAddress, "board"),
  );
  await browseAs(page, clientAddress, "board");
  const refused = refusals(page);
  await signInThroughTheScreen(page, member);

  // One line led by the board's sign, then the panels every resident has. The
  // queues themselves are on the board's own page.
  const line = boardLine(page);
  await expect(line).toBeVisible();
  await expect(line.getByRole("link", { name: "Att hantera" })).toHaveAttribute(
    "href",
    appPath("/board"),
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Nästa evenemang" }),
  ).toBeVisible();
  const total = await totalOn(line);

  await line.getByRole("link", { name: "Att hantera" }).click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/board")}`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Styrelsen Att hantera",
      exact: true,
    }),
  ).toBeVisible();

  // Each count against the endpoint the queue's own screen reads, at the
  // same moment: the suite runs one spec at a time, so nothing writes between.
  const read = async (path: string): Promise<unknown> => {
    const response = await page.request.get(`${stack.baseUrl}${path}`);
    expect(response.ok(), `GET ${path}`).toBe(true);
    return response.json();
  };
  const issues = (await read("/api/issue-queue?status=NEW")) as unknown[];
  const keyOrders = (
    (await read("/api/key-order-queue?status=SUBMITTED")) as {
      orders: unknown[];
    }
  ).orders;
  const sublets = (
    (await read("/api/sublet-queue?status=SUBMITTED")) as {
      applications: unknown[];
    }
  ).applications;
  const brokerRequests = (await read("/api/broker-update-requests")) as {
    openTotal: number;
  };
  const signups = (await read("/api/signup-requests")) as unknown[];
  const motions = (await read("/api/motion-queue?status=SUBMITTED")) as {
    motions: unknown[];
    nextCursor: string | null;
  };
  const reports = ((await read("/api/feed/reports")) as { reports: unknown[] })
    .reports;

  expect(await countOn(queueRow(page, "Nya ärenden"))).toEqual(
    all(issues.length),
  );
  expect(
    await countOn(queueRow(page, "Nyckelbeställningar att besvara")),
  ).toEqual(all(keyOrders.length));
  expect(
    await countOn(
      queueRow(page, "Ansökningar om andrahandsupplåtelse att besluta om"),
    ),
  ).toEqual(all(sublets.length));
  expect(
    await countOn(queueRow(page, "Mäklares förfrågningar om uppdatering")),
  ).toEqual(all(brokerRequests.openTotal));
  expect(
    await countOn(queueRow(page, "Kontoansökningar att besluta om")),
  ).toEqual(all(signups.length));
  // The two queues that answer a page at a time. A stack reused from an
  // earlier run (OPENBRF_E2E_REUSE_STACK) can hold more than a page of either,
  // and the row then shows the first page's length as a floor.
  expect(
    await countOn(queueRow(page, "Motioner som inte är mottagna")),
  ).toEqual({
    count: motions.motions.length,
    more: motions.nextCursor !== null,
  });
  expect(await countOn(queueRow(page, "Anmälda inlägg"))).toEqual({
    count: reports.length,
    more: reports.length >= REPORTS_PER_PAGE,
  });
  // The resident's order from the test above is among them.
  expect(keyOrders.length).toBeGreaterThan(0);

  // The overview's line is the sum of the same reads, so the two agree.
  const rows: Shown[] = [];
  for (const name of BOARD_QUEUES) {
    rows.push(await countOn(queueRow(page, name)));
  }
  expect(total).toEqual({
    count: rows.reduce((sum, row) => sum + row.count, 0),
    more: rows.some((row) => row.more),
  });
  // Read before leaving: the counts are all in, and nothing was refused.
  expect(refused).toEqual([]);

  // Each row is the way to its queue.
  await queueRow(page, "Nyckelbeställningar att besvara")
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/key-orders")}`);

  // The address book is a page of its own, under the board's sign.
  const board = primaryNavigation(page).getByRole("button", {
    name: "Styrelsen",
    exact: true,
  });
  await board.click();
  await page.getByRole("link", { name: "Adressbok", exact: true }).click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/address-book")}`,
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Styrelsen Adressbok" }),
  ).toBeVisible();
});
