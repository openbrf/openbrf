import type {
  APIRequestContext,
  Locator,
  Page,
  Response,
} from "@playwright/test";

import * as api from "../src/api";
import { BOARD_PAGE_NOT_OFFERED, grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import { offeredDestinations, primaryNavigation } from "../src/navigation";
import { ensureAccountFor, ensureRegisterFixture } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * One page, one audience (ADR 0049): the board's pages, every one of them
 * under /app/board.
 *
 * A house page carries no board half any more. What the board does on the
 * issues, the bookings, the motions, the sublets, the keys, the events, the
 * archive, the binders, the reported posts and the general meeting is a page
 * of its own, with the board's sign in its heading, and the board's front page
 * gathers the queues it works. The band's board section lists those pages grouped by the
 * kind of work.
 *
 * What only a browser can show: that the band's section, the front page's rows
 * and the overview's line all arrive at those addresses, that a board member on
 * a house page sees the page a resident sees, and that an account with no seat
 * meets a sentence rather than a sign on a board page asked for by hand. The
 * property manager, whose one board page is the issue queue, finds it as a
 * sign of its own in the band and in the middle of the phone bar.
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
 * Somebody on the board, with a seat and no home here, of this run's own: a
 * seat granted to somebody in the shared fixture would change what every later
 * spec is offered as them.
 */
const BOARD_MEMBER = {
  firstName: "Berit",
  lastName: uniqueSurname("Styrelsesidor"),
  email: uniqueEmail("styrelsesidor"),
  password: "porttelefon-tvattstuga-2026",
} as const;

/** The external property manager, of this run's own as well. */
const MANAGER = {
  firstName: "Ove",
  lastName: uniqueSurname("Forvaltare"),
  email: uniqueEmail("ove"),
  password: "takrannor-cykelrum-2026",
} as const;

/** The Mobil artboard's size, below the switch from the band to the bar. */
const PHONE = { width: 390, height: 844 } as const;

/**
 * The person named, found or written, holding an account. Looked up before
 * being created, because nothing in the suite can delete a person and every
 * test here asks for the people it signs in as.
 */
async function ensurePerson(
  request: APIRequestContext,
  clientAddress: string,
  who: { firstName: string; lastName: string; email: string; password: string },
): Promise<string> {
  const personId =
    (await api.findPersonIdByName(
      request,
      stack.baseUrl,
      `${who.firstName} ${who.lastName}`,
    )) ??
    (await api.createPerson(request, stack.baseUrl, {
      firstName: who.firstName,
      lastName: who.lastName,
      email: who.email,
    }));
  await ensureAccountFor(request, {
    personId,
    email: who.email,
    password: who.password,
    clientAddress,
  });
  return personId;
}

async function ensureBoardMember(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
  await ensureRegisterFixture(request);
  const personId = await ensurePerson(
    request,
    clientAddressFor(clientAddress, "board"),
    BOARD_MEMBER,
  );
  await grantBoardSeat(personId);
}

async function ensureResident(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
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
}

async function ensureManager(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
  await ensureRegisterFixture(request);
  const personId = await ensurePerson(
    request,
    clientAddressFor(clientAddress, "manager"),
    MANAGER,
  );
  await grantPropertyManager(personId);
}

/**
 * Puts this browser on one person's own client address, so each person's
 * sign-in is counted against their own budget; see spec 28 for why. Call it
 * before the first navigation.
 */
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

/** The band's sign for the board's section. */
function boardSign(page: Page): Locator {
  return primaryNavigation(page).getByRole("button", {
    name: "Styrelsen",
    exact: true,
  });
}

/** Opens the board's section in the band and returns its panel. */
async function openBoardSection(page: Page): Promise<Locator> {
  const sign = boardSign(page);
  await sign.click();
  await expect(sign).toHaveAttribute("aria-expanded", "true");
  const id = await sign.getAttribute("aria-controls");
  expect(id, "an open section names its panel").not.toBeNull();
  // An attribute selector: an id React generates is not a valid CSS id.
  return page.locator(`[id="${id ?? ""}"]`);
}

/** A page's own heading, the sign and the title in one. */
function pageHeading(page: Page, name: string): Locator {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

/** One queue's row on the board's front page, found by the queue's name. */
function queueRow(page: Page, name: string): Locator {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

test("a board member finds the board's pages in the band, grouped by the kind of work", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBoardMember(request, clientAddress);
  await browseAs(page, clientAddress, "board");
  await signInThroughTheScreen(page, BOARD_MEMBER);

  const panel = await openBoardSection(page);
  /*
   * The front page first and under no heading; then a heading over each group
   * of two or more, naming its list; and the data protection desk, one row, as
   * a row of its own without one.
   */
  await expect(panel.getByRole("list")).toHaveCount(6);
  await expect(panel.getByRole("list").first().getByRole("link")).toHaveText([
    "Att hantera",
  ]);
  for (const [heading, rows] of [
    [
      "Köer",
      [
        "Hantera ärenden",
        "Hantera motioner",
        "Pröva ansökningar",
        "Hantera beställningar",
        "Styrelsens post",
        "Granska anmälda inlägg",
      ],
    ],
    ["Register", ["Adressbok", "Alla lägenheters pärmar", "Import"]],
    [
      "Publicera",
      [
        "Skriv nyheter",
        "Webbplatsen",
        "Hantera evenemang",
        "Hantera arkivet",
        "Hantera bokningar",
        "Stämmor",
      ],
    ],
    ["Ekonomi", ["Avgifter", "Debiteringar"]],
  ] as const) {
    await expect(
      panel.getByRole("list", { name: heading, exact: true }).getByRole("link"),
    ).toHaveText([...rows]);
  }
  await expect(panel.getByRole("list").last().getByRole("link")).toHaveText([
    "Dataskydd",
  ]);
  await expect(panel.getByRole("list", { name: "Dataskydd" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Each of the pages made for the board, reached from the band, at its
  // address under /board and with the board's sign in its heading. The issue
  // queue is signed for the property manager as well, who works it too.
  for (const [row, path, heading] of [
    ["Att hantera", "/board", "Styrelsen Att hantera"],
    [
      "Hantera ärenden",
      "/board/issues",
      "Styrelse och förvaltare Hantera ärenden",
    ],
    ["Hantera motioner", "/board/motions", "Styrelsen Hantera motioner"],
    ["Pröva ansökningar", "/board/sublets", "Styrelsen Pröva ansökningar"],
    [
      "Hantera beställningar",
      "/board/key-orders",
      "Styrelsen Hantera beställningar",
    ],
    [
      "Granska anmälda inlägg",
      "/board/reports",
      "Styrelsen Granska anmälda inlägg",
    ],
    [
      "Alla lägenheters pärmar",
      "/board/binders",
      "Styrelsen Alla lägenheters pärmar",
    ],
    ["Hantera evenemang", "/board/events", "Styrelsen Hantera evenemang"],
    ["Hantera arkivet", "/board/documents", "Styrelsen Hantera arkivet"],
    ["Hantera bokningar", "/board/bookings", "Styrelsen Hantera bokningar"],
    ["Stämmor", "/board/meetings", "Styrelsen Föreningsstämmor"],
  ] as const) {
    await (
      await openBoardSection(page)
    )
      .getByRole("link", { name: row, exact: true })
      .click();
    await expect(page).toHaveURL(`${stack.baseUrl}${appPath(path)}`);
    await expect(pageHeading(page, heading)).toBeVisible();
    await expect(boardSign(page)).toHaveAttribute("aria-current", "true");
  }
});

test("the board's front page leads to each queue's own page", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBoardMember(request, clientAddress);
  await browseAs(page, clientAddress, "board");
  await signInThroughTheScreen(page, BOARD_MEMBER);

  for (const [row, path, heading] of [
    ["Nya ärenden", "/board/issues", "Styrelse och förvaltare Hantera ärenden"],
    [
      "Motioner som inte är mottagna",
      "/board/motions",
      "Styrelsen Hantera motioner",
    ],
    [
      "Ansökningar om andrahandsupplåtelse att besluta om",
      "/board/sublets",
      "Styrelsen Pröva ansökningar",
    ],
    [
      "Nyckelbeställningar att besvara",
      "/board/key-orders",
      "Styrelsen Hantera beställningar",
    ],
    ["Anmälda inlägg", "/board/reports", "Styrelsen Granska anmälda inlägg"],
  ] as const) {
    await page.goto(appPath("/board"));
    await expect(pageHeading(page, "Styrelsen Att hantera")).toBeVisible();
    await queueRow(page, row).getByRole("link").click();
    await expect(page).toHaveURL(`${stack.baseUrl}${appPath(path)}`);
    await expect(pageHeading(page, heading)).toBeVisible();
  }
});

test("the overview's line leads a board member to the board's front page", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBoardMember(request, clientAddress);
  await browseAs(page, clientAddress, "board");
  await signInThroughTheScreen(page, BOARD_MEMBER);

  const line = page
    .getByRole("main")
    .getByRole("group", { name: "Styrelsen", exact: true });
  await expect(line).toBeVisible();
  await line.getByRole("link", { name: "Att hantera", exact: true }).click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/board")}`);
  await expect(pageHeading(page, "Styrelsen Att hantera")).toBeVisible();
});

test("a board member on the house's pages sees no sign and no queue", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBoardMember(request, clientAddress);
  await browseAs(page, clientAddress, "board");
  await signInThroughTheScreen(page, BOARD_MEMBER);

  /*
   * Each page's heading, then its loading status gone: the status shares the
   * heading's first render and goes when the page's read has answered, so the
   * absences after it are read from a finished page rather than from one that
   * had not got that far yet.
   */
  for (const [path, heading, loading, queue] of [
    ["/issues", "Ärenden", "Hämtar ärendena...", "Ärendekön"],
    ["/bookings", "Bokningar", "Läser in bokningarna...", "Hela kalendern"],
    [
      "/motions",
      "Motioner till stämman",
      "Läser in motionerna...",
      "Motioner från medlemmarna",
    ],
    [
      "/sublets",
      "Hyra ut i andra hand",
      "Hämtar ansökningarna ...",
      "Ansökningar om andrahandsupplåtelse",
    ],
    [
      "/key-orders",
      "Nycklar och taggar",
      "Hämtar beställningarna ...",
      "Nyckelbeställningar",
    ],
    ["/events", "Evenemang", "Läser in kalendern...", "Styrelsens kalender"],
    [
      "/apartment-binder",
      "Lägenhetspärm",
      "Hämtar pärmen",
      "Alla lägenheters pärmar",
    ],
  ] as const) {
    await page.goto(appPath(path));
    await expect(pageHeading(page, heading)).toBeVisible();
    await expect(page.getByText(loading)).toHaveCount(0);

    const main = page.getByRole("main");
    await expect(main.getByText("Styrelsen", { exact: true })).toHaveCount(0);
    await expect(
      main.getByText("Styrelse och förvaltare", { exact: true }),
    ).toHaveCount(0);
    await expect(
      main.getByRole("heading", { name: queue, exact: true }),
    ).toHaveCount(0);
  }

  /*
   * The archive is the one house page that keeps something of the board's: a
   * document's edit control, in place on its shelf under the board's sign
   * (ADR 0049, decision 2). Filing a document and the filter over the
   * audiences are the board's page.
   */
  await page.goto(appPath("/documents"));
  await expect(pageHeading(page, "Dokumentarkiv")).toBeVisible();
  await expect(page.getByText("Läser in arkivet")).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Lägg in ett dokument", exact: true }),
  ).toHaveCount(0);
  await expect(main.getByRole("radio")).toHaveCount(0);
});

test("a resident is offered no board section, and a board page says it is not theirs", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureResident(request, clientAddress);
  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT);

  // Read once the band has filled in, so the absence is the whole offer's.
  await expect.poll(() => offeredDestinations(page)).toContain("Ärenden");
  // A section's unread count may follow its name ("Föreningen2").
  await expect(primaryNavigation(page).getByRole("button")).toHaveText([
    /^Föreningen\d*$/,
    /^Huset\d*$/,
  ]);
  const offered = await offeredDestinations(page);
  for (const destination of [
    "Att hantera",
    "Hantera ärenden",
    "Hantera bokningar",
    "Adressbok",
  ]) {
    expect(offered).not.toContain(destination);
  }

  // The queue asked for by hand: the sentence, and neither sign nor queue.
  await page.goto(appPath("/board/issues"));
  const main = page.getByRole("main");
  await expect(main.getByText(BOARD_PAGE_NOT_OFFERED)).toBeVisible();
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(
    main.getByText("Styrelse och förvaltare", { exact: true }),
  ).toHaveCount(0);
  await expect(main.getByText("Styrelsen", { exact: true })).toHaveCount(0);
  await expect(
    main.getByRole("heading", { name: "Ärendekön", exact: true }),
  ).toHaveCount(0);
});

test("a resident opening the board's other pages by hand reads the same sentence, and nothing is asked for", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureResident(request, clientAddress);
  await browseAs(page, clientAddress, "resident");
  await signInThroughTheScreen(page, RESIDENT);

  /*
   * The rest of the board's pages. Each holds what it offers only for an
   * account offered it, so a resident gets the sentence
   * under no sign, none of the board's controls, and the screen never asks
   * the API for what it would refuse them.
   */
  for (const path of [
    "/board/motions",
    "/board/sublets",
    "/board/key-orders",
    "/board/reports",
    "/board/binders",
    "/board/events",
    "/board/documents",
    "/board/meetings",
    "/board/registers/members",
    "/board/registers/reports",
    "/board/registers/reports/supply",
    "/board/import",
    "/board/mailbox",
    "/board/news",
    "/board/site",
    "/board/site/menu",
    "/board/fees",
    "/board/charges",
    "/board/data-protection",
  ]) {
    const refused: string[] = [];
    const onResponse = (response: Response): void => {
      if (response.status() === 403) {
        refused.push(new URL(response.url()).pathname);
      }
    };
    page.on("response", onResponse);
    await page.goto(appPath(path));
    const main = page.getByRole("main");
    await expect(main.getByText(BOARD_PAGE_NOT_OFFERED), path).toBeVisible();
    await expect(main.getByRole("heading", { level: 1 }), path).toHaveCount(0);
    await expect(
      main.getByText("Styrelsen", { exact: true }),
      path,
    ).toHaveCount(0);
    await expect(main.getByRole("button"), path).toHaveCount(0);
    page.off("response", onResponse);
    expect(refused, path).toEqual([]);
  }
});

test("the property manager's band shows the issue queue as a sign of its own", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureManager(request, clientAddress);
  await browseAs(page, clientAddress, "manager");
  await signInThroughTheScreen(page, MANAGER);

  /*
   * A section with one destination is that destination's own sign: a link
   * named by the page, not a "Styrelsen" button opening a panel of one row.
   */
  const band = primaryNavigation(page);
  await expect(band.getByRole("link")).toHaveText([
    "Översikt",
    "Hantera ärenden",
    "Inställningar",
  ]);
  await expect(band.getByRole("button")).toHaveCount(0);

  await band
    .getByRole("link", { name: "Hantera ärenden", exact: true })
    .click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/board/issues")}`);
  await expect(
    pageHeading(page, "Styrelse och förvaltare Hantera ärenden"),
  ).toBeVisible();
});

test("the property manager has no front page, and its address says so", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureManager(request, clientAddress);
  await browseAs(page, clientAddress, "manager");
  await signInThroughTheScreen(page, MANAGER);

  // Their one board page is the issue queue, and a front page over that one
  // queue would be a second page saying the same thing (ADR 0049, decision 4).
  // The overview they signed in on counts the same queue for its line, so the
  // line has finished counting before anything is listened for: what is
  // counted after it is the refused page's own.
  const line = page
    .getByRole("main")
    .getByRole("group", { name: "Styrelse och förvaltare", exact: true });
  await expect(line).toBeVisible();
  await expect(line).not.toContainText("Laddar");
  const counted: string[] = [];
  page.on("request", (sent) => {
    const { pathname } = new URL(sent.url());
    if (pathname.endsWith("/api/issue-queue")) {
      counted.push(pathname);
    }
  });
  await page.goto(appPath("/board"));
  const main = page.getByRole("main");
  await expect(main.getByText(BOARD_PAGE_NOT_OFFERED)).toBeVisible();
  await expect(main.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(
    main.getByText("Styrelse och förvaltare", { exact: true }),
  ).toHaveCount(0);
  expect(counted).toEqual([]);
});

test("the property manager's phone bar opens the issue queue from its middle", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureManager(request, clientAddress);
  await browseAs(page, clientAddress, "manager");
  await signInThroughTheScreen(page, MANAGER);
  await page.setViewportSize(PHONE);

  // Below the switch the navigation a person can see is the bar. The third
  // column is the feed's, which the property manager is not offered, so it
  // stays empty rather than being filled from the rest.
  const bar = primaryNavigation(page);
  await expect(bar.getByRole("link")).toHaveText([
    "Översikt",
    "Hantera ärenden",
  ]);

  await bar.getByRole("link", { name: "Hantera ärenden", exact: true }).click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/board/issues")}`);
  await expect(
    pageHeading(page, "Styrelse och förvaltare Hantera ärenden"),
  ).toBeVisible();
});
