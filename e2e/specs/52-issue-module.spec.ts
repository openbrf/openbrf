import { formatLocalDay, localDayOf, addLocalDays } from "@openbrf/shared";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
} from "@playwright/test";

import * as api from "../src/api";
import { claimApartment } from "../src/apartments";
import { signInThroughTheScreen } from "../src/feed";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  linkFrom,
  listMessages,
  messageContent,
  waitForMessage,
} from "../src/mailpit";
import {
  holdPendingChange,
  releasePendingChange,
} from "../src/pending-changes";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The issue module from sign-in to a reopened case, as the plan's "Done
 * means" lists it (APT-9354): one flow, in the order the owner shows it.
 *
 *  1. A resident reports, and the type's default assignee is mailed.
 *  2. The board assigns the case to itself, so it leaves the property
 *     manager's Mina and lands on the board's; a target date in the past
 *     puts it on Försenade, and a website report given to nobody is on Ej
 *     tilldelade.
 *  3. A conversation with the resident, signed as the board.
 *  4. An internal note the resident never sees.
 *  5. A conversation with a reporter who has no account, through the
 *     private link mailed to them.
 *  6. A work order to a contractor, carrying the handler's text and nothing
 *     of the case.
 *  7. A charge made from the case, which the property manager is never shown.
 *  8. The case closed, and opened again by the resident's reply.
 *
 * And the negatives the plan holds the release to:
 *
 *  - A reporter with protected personal data stays masked throughout: on the
 *    queue the board and the property manager read, in the handling, on the
 *    work order form and on the issue's charges panel.
 *  - A ring-fenced case never reaches the property manager, nor the `ai`
 *    surface: a proposal the AI package would hold for it reads as gone and
 *    confirming it is refused. The `mcp` half runs through the MCP Connector,
 *    a plugin of its own repository that this stack does not install;
 *    `apps/api/src/issues/ring-fence.int-spec.ts` holds it against the
 *    registry the instance runs.
 *  - No mail carries free text. Every mail this flow caused is read, in every
 *    part, against everything anybody wrote in it; the one exception is the
 *    work order, which carries the handler's own text and nothing else
 *    (decision 21).
 *
 * One test rather than one per step, because each step is the state the next
 * one stands on. Every name, address and text is this run's own, and on a
 * retry this attempt's own too, so a reused stack and a retried run read only
 * their own rows.
 */

test.describe.configure({ mode: "serial" });

type Persona =
  "administrator" | "manager" | "resident" | "protected" | "public";

/** A browser of its own for one person, on that person's client address. */
async function browserFor(
  browser: Browser,
  clientAddress: string,
  persona: Persona,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, persona),
    },
  });
  return { context, page: await context.newPage() };
}

/** The queue, on one of its four views. */
async function openQueue(
  page: Page,
  view: "mine" | "unassigned" | "overdue" | "all",
): Promise<Locator> {
  await page.goto(appPath(`/board/issues?view=${view}`));
  await expect(
    page.getByRole("heading", { name: "Ärendekön", exact: true }),
  ).toBeVisible();
  return page.getByRole("main");
}

/** One of the queue's filter selects, by the word that labels it. */
function queueSelect(page: Page, label: string): Locator {
  return page
    .getByRole("search", { name: "Sök och filtrera ärenden" })
    .getByRole("combobox", { name: new RegExp(`^${label}(\\s|$)`) });
}

/** The queue's row for the issue whose description holds this text. */
function rowOf(queue: Locator, text: string): Locator {
  return queue.getByRole("listitem").filter({ hasText: text }).first();
}

/** Opens a row's handling: the assignee, the timeline and the conversation. */
async function openHandling(row: Locator, type: string): Promise<void> {
  const summary = row.locator("summary", {
    hasText: `Hantera ${type}:`,
  });
  await summary.click();
  await expect(row.getByText("Tidslinje", { exact: true })).toBeVisible();
}

/** Saves one of the handling's select forms, waiting for the server. */
async function saveChoice(
  page: Page,
  row: Locator,
  select: string,
  option: string,
  route: RegExp,
): Promise<void> {
  const field = row.getByRole("combobox", { name: select, exact: true });
  await field.selectOption({ label: option });
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      route.test(new URL(response.url()).pathname),
  );
  // The inner locator of `has` is matched inside the form, so it is written
  // from the page rather than from the row.
  await row
    .locator("form")
    .filter({ has: page.getByRole("combobox", { name: select, exact: true }) })
    .getByRole("button", { name: "Spara" })
    .click();
  expect((await saved).ok()).toBe(true);
}

/** Moves a row to a status of its type, with an outcome when it closes. */
async function moveTo(
  page: Page,
  row: Locator,
  status: string,
  outcome?: string,
): Promise<void> {
  await row
    .getByRole("combobox", { name: /: status$/ })
    .selectOption({ label: status });
  if (outcome !== undefined) {
    await row
      .getByRole("combobox", { name: /: utfall$/ })
      .selectOption({ label: outcome });
  }
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/issue-queue\/[^/]+\/status$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await row.getByRole("button", { name: "Spara status" }).click();
  expect((await saved).ok()).toBe(true);
}

/** A resident reports through the house's page, and waits for the receipt. */
async function reportThroughTheScreen(
  page: Page,
  report: { type: string; location: string; description: string },
  warning: RegExp,
): Promise<void> {
  await page.goto(appPath("/issues"));
  await expect(
    page.getByRole("heading", { name: "Gör en felanmälan" }),
  ).toBeVisible();
  await page.getByLabel("Vad gäller det").selectOption({ label: report.type });
  // What the form warns of is the type's: a ring-fenced type says who will
  // never read it, any other who will.
  await expect(page.getByText(warning)).toBeVisible();
  await page.getByLabel("Var i huset").fill(report.location);
  await page.getByLabel("Vad har hänt").fill(report.description);
  await page.getByRole("button", { name: "Skicka anmälan" }).click();
  await expect(
    page.getByText("Anmälan är skickad och ligger nu i kön."),
  ).toBeVisible();
}

/** The queue row the board reads for a description, over HTTP. */
async function queuedByDescription(
  request: APIRequestContext,
  description: string,
): Promise<api.QueuedIssueRow & { number: number; priority: string }> {
  const row = (await api.listIssueQueue(request, stack.baseUrl)).find(
    (candidate) => candidate.description === description,
  );
  if (row === undefined) {
    throw new Error(`no issue in the queue says "${description}"`);
  }
  return row as api.QueuedIssueRow & { number: number; priority: string };
}

test("an issue goes from a report to a reopened case, and nothing leaks on the way", async ({
  browser,
  api: board,
  clientAddress,
}, testInfo) => {
  // Nine people and a mailbox, every mail job a worker run away.
  test.setTimeout(10 * 60_000);

  /** This run's, and on a retry this attempt's, so a rerun reads its own rows. */
  const own = (name: string): string =>
    uniqueSurname(
      `${name}${testInfo.retry === 0 ? "" : `r${String(testInfo.retry)}`}`,
    );
  // The run id alone is shared by every spec, and others take the same first
  // names ("elsa" signs up in 04, "greta" is imported in 07), so the spec's
  // own prefix keeps its accounts and mailboxes apart from theirs.
  const ownEmail = (local: string): string =>
    uniqueEmail(
      `issue-${local}${testInfo.retry === 0 ? "" : `r${String(testInfo.retry)}`}`,
    );

  // --- the instance ---------------------------------------------------------

  await ensureRegisterFixture(board);
  const administrator = await api.viewer(board, stack.baseUrl);
  const administratorName = `${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`;

  // A resident of this run's own, so nothing another spec did to a shared
  // fixture person (a board seat, a protection) changes what they are shown.
  const resident = {
    firstName: "Elsa",
    lastName: own("Lundgren"),
    email: ownEmail("elsa"),
    password: "vindsforrad-cykelpump-2026",
  };
  const residentName = `${resident.firstName} ${resident.lastName}`;
  const apartment = await claimApartment(board, "12");
  const residentId = await api.createPerson(board, stack.baseUrl, {
    firstName: resident.firstName,
    lastName: resident.lastName,
    email: resident.email,
  });
  await api.moveIn(board, stack.baseUrl, {
    personId: residentId,
    apartmentId: apartment.id,
    role: "MEMBER",
    movedInOn: "2026-01-01",
  });
  await ensureAccountFor(board, {
    personId: residentId,
    email: resident.email,
    password: resident.password,
    clientAddress: clientAddressFor(clientAddress, "resident"),
  });

  /*
   * And one with protected personal data, also this run's own: the budget of
   * reports a reporter has the handlers mailed about is per hour, and a shared
   * fixture person would spend it across reruns on a kept stack.
   */
  const shielded = {
    // This run's own first name too: the mail scan below fails a mail to the
    // shared administrator that names the protected reporter, and another
    // spec's delayed mail may name a Greta.
    firstName: own("Greta"),
    lastName: own("Skyddad"),
    email: ownEmail("greta"),
    password: "kallarforrad-sopkarl-2026",
  };
  const shieldedApartment = await claimApartment(board, "12");
  const shieldedId = await api.createPerson(board, stack.baseUrl, {
    firstName: shielded.firstName,
    lastName: shielded.lastName,
    email: shielded.email,
  });
  await api.moveIn(board, stack.baseUrl, {
    personId: shieldedId,
    apartmentId: shieldedApartment.id,
    role: "MEMBER",
    movedInOn: "2026-01-01",
  });
  await api.setProtectedPersonalData(board, stack.baseUrl, shieldedId, true);
  await ensureAccountFor(board, {
    personId: shieldedId,
    email: shielded.email,
    password: shielded.password,
    clientAddress: clientAddressFor(clientAddress, "protected"),
  });
  /** What would tell anybody who the protected reporter is, or where. */
  const SHIELDED_TELLS = [
    shielded.firstName,
    shielded.lastName,
    shieldedApartment.number,
  ];

  const manager = {
    firstName: "Malte",
    lastName: own("Forvaltare"),
    email: ownEmail("malte"),
    password: "takstol-hissmaskin-2026",
  };
  const managerId = await api.createPerson(board, stack.baseUrl, {
    firstName: manager.firstName,
    lastName: manager.lastName,
    email: manager.email,
  });
  await grantPropertyManager(managerId);
  await ensureAccountFor(board, {
    personId: managerId,
    email: manager.email,
    password: manager.password,
    clientAddress: clientAddressFor(clientAddress, "manager"),
  });

  /*
   * Three types of this run's own. A leak, given to the property manager by
   * default (decision 12); a website type with no default, so its reports land
   * on Ej tilldelade; and a disturbance type, ring-fenced (decision 32).
   */
  const LEAK = own("Vattenlacka");
  const WEBSITE = own("Webbanmalan");
  const FENCED = own("Storningar");
  await api.createIssueType(board, stack.baseUrl, {
    name: LEAK,
    reporters: ["RESIDENTS"],
    defaultAssigneePersonId: managerId,
  });
  const website = await api.createIssueType(board, stack.baseUrl, {
    name: WEBSITE,
    reporters: ["PUBLIC"],
  });
  const fenced = await api.createIssueType(board, stack.baseUrl, {
    name: FENCED,
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
  });
  await api.ringFenceIssueType(board, stack.baseUrl, fenced.id);

  const contractor = {
    name: own("Rorfirman"),
    trade: "Rörmokare",
    email: ownEmail("ror"),
  };
  await api.createContractor(board, stack.baseUrl, contractor);

  const publicReporter = ownEmail("granne");

  /*
   * Everything anybody writes in this flow. None of it may be in a mail; the
   * work order's text alone may be in the contractor's.
   */
  const LEAK_TEXT = `Det droppar från taket i badrummet, ${own("droppe")}.`;
  const LEAK_PLACE = `Badrummet, ${own("plats")}`;
  const PROTECTED_TEXT = `Elementet i sovrummet är kallt, ${own("element")}.`;
  const FENCED_TEXT = `Grannen spelar hög musik varje natt, ${own("musik")}.`;
  const PUBLIC_TEXT = `Porten mot gården går inte i lås, ${own("port")}.`;
  const TO_RESIDENT = `Vi skickar en rörmokare i veckan, ${own("svar")}.`;
  const FROM_RESIDENT = `Jag är hemma på tisdag förmiddag, ${own("hemma")}.`;
  const NOTE = `Läckan kan komma från lägenheten ovanför, ${own("anteckning")}.`;
  const TO_PUBLIC = `Tack, vi tittar på låset i morgon, ${own("lasvar")}.`;
  const PUBLIC_NOTE = `Låskistan byttes för två år sedan, ${own("laskista")}.`;
  const FROM_PUBLIC = `Det gäller porten närmast cykelrummet, ${own("cykel")}.`;
  const WORK_ORDER = `Byt packningen under handfatet, ${own("arbetsorder")}.`;
  const REOPENING = `Det droppar igen sedan i går, ${own("igen")}.`;
  const FREE_TEXT = [
    LEAK_TEXT,
    LEAK_PLACE,
    PROTECTED_TEXT,
    FENCED_TEXT,
    PUBLIC_TEXT,
    TO_RESIDENT,
    FROM_RESIDENT,
    NOTE,
    TO_PUBLIC,
    PUBLIC_NOTE,
    FROM_PUBLIC,
    REOPENING,
  ];

  const adminBrowser = await browserFor(
    browser,
    clientAddress,
    "administrator",
  );
  const managerBrowser = await browserFor(browser, clientAddress, "manager");
  const residentBrowser = await browserFor(browser, clientAddress, "resident");
  const protectedBrowser = await browserFor(
    browser,
    clientAddress,
    "protected",
  );
  const publicBrowser = await browserFor(browser, clientAddress, "public");
  const admin = adminBrowser.page;
  const managerPage = managerBrowser.page;
  const residentPage = residentBrowser.page;
  const protectedPage = protectedBrowser.page;

  // Where the mail this flow causes starts: the invitations above are the
  // setup's, and the only mail sent to a person that is about them by name.
  // By what the mailbox held rather than by the clock, which the mail
  // server's container keeps for itself.
  const sentBefore = new Set(
    (await listMessages()).map((message) => message.ID),
  );

  try {
    // --- 1. a report arrives, and its assignee is mailed ---------------------

    await test.step("a resident reports and the default assignee is mailed", async () => {
      await signInThroughTheScreen(residentPage, resident);
      await reportThroughTheScreen(
        residentPage,
        { type: LEAK, location: LEAK_PLACE, description: LEAK_TEXT },
        /extern förvaltare/i,
      );

      const leak = await queuedByDescription(board, LEAK_TEXT);
      const { text } = await waitForMessage(manager.email, {
        subjectMatch: new RegExp(
          `^Ärende ${String(leak.number)} har tilldelats dig`,
        ),
        timeoutMs: 60_000,
      });
      // The number and the type, never what was written.
      expect(text).toContain(LEAK);
      expect(text).not.toContain(LEAK_TEXT);
    });

    await test.step("the property manager finds it on Mina", async () => {
      await signInThroughTheScreen(managerPage, manager);
      const queue = await openQueue(managerPage, "mine");
      const row = rowOf(queue, LEAK_TEXT);
      await expect(row).toBeVisible();
      await expect(row.getByText(residentName)).toBeVisible();
      await openHandling(row, LEAK);
      await expect(
        row.getByText("Tilldelat enligt typens standard"),
      ).toBeVisible();
      // The charges are the board's: the property manager is never shown
      // them, nor an amount (decision 26).
      await expect(row.getByText("Debiteringar", { exact: true })).toHaveCount(
        0,
      );
    });

    // --- the protected reporter and the ring-fenced case ---------------------

    await test.step("a reporter with protected personal data is masked on the queue", async () => {
      await signInThroughTheScreen(protectedPage, shielded);
      await reportThroughTheScreen(
        protectedPage,
        {
          type: LEAK,
          location: "Sovrummet",
          description: PROTECTED_TEXT,
        },
        /extern förvaltare/i,
      );
      await waitForMessage(manager.email, {
        subjectMatch: new RegExp(
          `^Ärende ${String((await queuedByDescription(board, PROTECTED_TEXT)).number)} har tilldelats dig`,
        ),
        timeoutMs: 60_000,
      });

      const queue = await openQueue(managerPage, "mine");
      const row = rowOf(queue, PROTECTED_TEXT);
      await expect(row).toBeVisible();
      await expect(
        row.getByText("Skyddade personuppgifter: fråga styrelsen."),
      ).toBeVisible();
      await openHandling(row, LEAK);
      await expect(row.getByText("Anmält", { exact: true })).toBeVisible();
      for (const told of SHIELDED_TELLS) {
        await expect(row).not.toContainText(told);
      }
    });

    await test.step("a ring-fenced report never reaches the property manager", async () => {
      await reportThroughTheScreen(
        residentPage,
        { type: FENCED, location: "Trapphuset", description: FENCED_TEXT },
        /aldrig av förvaltaren/,
      );
      const fencedIssue = await queuedByDescription(board, FENCED_TEXT);

      // Not on any view of theirs, and not by its address either: the
      // property manager is told it does not exist.
      const queue = await openQueue(managerPage, "all");
      await expect(rowOf(queue, LEAK_TEXT)).toBeVisible();
      await expect(
        queue.getByRole("listitem").filter({ hasText: FENCED_TEXT }),
      ).toHaveCount(0);
      expect(
        (await api.listIssueQueue(managerPage.request, stack.baseUrl)).some(
          (row) => row.id === fencedIssue.id,
        ),
      ).toBe(false);
      expect(
        await api.issueTimelineStatus(
          managerPage.request,
          stack.baseUrl,
          fencedIssue.id,
        ),
      ).toBe(404);
    });

    // --- the reporter without an account files from the website -------------

    await test.step("a report from the website lands on Ej tilldelade", async () => {
      const wasOpen = (await api.settings(board, stack.baseUrl)).issueReporting
        .publicFormEnabled;
      const slug = `felanmalan-${own("flode").toLowerCase()}`;
      const page = await api.createSitePage(board, stack.baseUrl, {
        slug,
        title: "Felanmälan",
        blocks: [{ type: "issueReportForm" }],
      });
      try {
        if (!wasOpen) {
          await api.setPublicIssueReporting(board, stack.baseUrl, true);
        }
        await api.publishSitePage(board, stack.baseUrl, page.id);
        await api.postIssueReportForm(board, stack.baseUrl, slug, {
          type: website.id,
          description: PUBLIC_TEXT,
          email: publicReporter,
        });
      } finally {
        await api.deleteSitePage(board, stack.baseUrl, page.id);
        if (!wasOpen) {
          await api.setPublicIssueReporting(board, stack.baseUrl, false);
        }
      }

      // The private link is mailed by a job after the report is stored.
      await waitForMessage(publicReporter, {
        subjectMatch: /^Ditt ärende hos /,
        timeoutMs: 60_000,
      });
      await expect
        .poll(
          async () =>
            (await queuedByDescription(board, PUBLIC_TEXT)).reporter.link,
          { timeout: 30_000 },
        )
        .toBe("live");

      await signInThroughTheScreen(admin, ADMINISTRATOR);
      await openQueue(admin, "unassigned");
      await queueSelect(admin, "Typ").selectOption({ label: WEBSITE });
      const views = admin.getByRole("navigation", { name: "Vyer" });
      await expect(
        views.getByRole("link", { name: "Ej tilldelade 1", exact: true }),
      ).toBeVisible();
      const row = rowOf(admin.getByRole("main"), PUBLIC_TEXT);
      await expect(row).toBeVisible();
      await expect(row.getByText("Från webbplatsen")).toBeVisible();
    });

    // --- 2. assign and reassign; Mina and Försenade --------------------------

    await test.step("the board takes the leak over from the property manager", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, LEAK_TEXT);
      await openHandling(row, LEAK);
      await expect(
        row.getByRole("combobox", { name: `${LEAK}: ansvarig`, exact: true }),
      ).toHaveValue(managerId);

      // Reassigned to the board member themselves, who is not mailed about
      // their own act.
      await saveChoice(
        admin,
        row,
        `${LEAK}: ansvarig`,
        administratorName,
        /\/api\/issue-queue\/[^/]+\/assignee$/,
      );
      await expect(
        row.getByRole("combobox", { name: `${LEAK}: ansvarig`, exact: true }),
      ).toHaveValue(administrator.personId);
      // The timeline says who gave it to whom.
      await expect(
        row
          .getByRole("listitem")
          .filter({
            // Spaced by the layout rather than by the text, so read loosely.
            hasText: new RegExp(
              `Tilldelat\\s*${administratorName}\\s*av\\s*${administratorName}`,
            ),
          })
          .first(),
      ).toBeVisible();

      // Off the property manager's Mina and on the board member's.
      const theirs = await openQueue(managerPage, "mine");
      await expect(rowOf(theirs, PROTECTED_TEXT)).toBeVisible();
      await expect(
        theirs.getByRole("listitem").filter({ hasText: LEAK_TEXT }),
      ).toHaveCount(0);

      await openQueue(admin, "mine");
      await queueSelect(admin, "Typ").selectOption({ label: LEAK });
      await expect(rowOf(admin.getByRole("main"), LEAK_TEXT)).toBeVisible();
      await expect(
        admin
          .getByRole("main")
          .getByRole("listitem")
          .filter({ hasText: PROTECTED_TEXT }),
      ).toHaveCount(0);
    });

    await test.step("a target date in the past puts it on Försenade", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, LEAK_TEXT);
      await openHandling(row, LEAK);
      // Two days back, so the morning after it has passed whatever the hour
      // and the reminder is owed at once.
      const overdueSince = formatLocalDay(
        addLocalDays(localDayOf(new Date()), -2),
      );
      const field = row.getByLabel(`${LEAK}: senast klart`, { exact: true });
      await field.fill(overdueSince);
      const saved = admin.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/issue-queue\/[^/]+\/target-date$/.test(
            new URL(response.url()).pathname,
          ),
      );
      await row
        .locator("form")
        .filter({
          has: admin.getByLabel(`${LEAK}: senast klart`, { exact: true }),
        })
        .getByRole("button", { name: "Spara" })
        .click();
      expect((await saved).ok()).toBe(true);

      await openQueue(admin, "overdue");
      await queueSelect(admin, "Typ").selectOption({ label: LEAK });
      const late = rowOf(admin.getByRole("main"), LEAK_TEXT);
      await expect(late).toBeVisible();
      await expect(late.getByText("Försenat", { exact: true })).toBeVisible();

      // The assignee, the board member, is reminded once, and the mail is in
      // the box before the privacy scan at the end reads it.
      const leak = await queuedByDescription(board, LEAK_TEXT);
      await waitForMessage(ADMINISTRATOR.email, {
        subjectMatch: new RegExp(
          `^Ärende ${String(leak.number)} har passerat senast klart`,
        ),
        timeoutMs: 60_000,
      });
    });

    // --- 3 and 4. the conversation with the resident, and a note -------------

    await test.step("the board answers the resident, who answers back", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, LEAK_TEXT);
      await openHandling(row, LEAK);
      await row
        .getByLabel(`${LEAK}: meddelande till anmälaren`, { exact: true })
        .fill(TO_RESIDENT);
      await row.getByRole("button", { name: "Skicka", exact: true }).click();
      await expect(row.getByText(TO_RESIDENT)).toBeVisible();

      await row
        .getByLabel(`${LEAK}: intern anteckning`, { exact: true })
        .fill(NOTE);
      await row.getByRole("button", { name: "Lägg till anteckning" }).click();
      await expect(row.getByText(NOTE)).toBeVisible();

      // The resident is told there is an answer, and not what it says.
      const leak = await queuedByDescription(board, LEAK_TEXT);
      await waitForMessage(resident.email, {
        subjectMatch: new RegExp(
          `^Nytt svar i ditt ärende ${String(leak.number)}`,
        ),
        timeoutMs: 60_000,
      });

      await residentPage.goto(appPath("/issues"));
      const mine = residentPage
        .getByRole("listitem")
        .filter({ hasText: LEAK_TEXT })
        .first();
      await mine
        .locator("summary", { hasText: `Meddelanden om ${LEAK}` })
        .click();
      const answer = mine
        .getByRole("listitem")
        .filter({ hasText: TO_RESIDENT });
      await expect(answer).toBeVisible();
      // Signed as the board, never with the name of whoever wrote it.
      await expect(
        answer.getByText("Styrelsen", { exact: true }),
      ).toBeVisible();
      await expect(mine).not.toContainText(administratorName);
      // The internal note is the handlers' alone (decision 18).
      await expect(residentPage.getByText(NOTE)).toHaveCount(0);

      await mine
        .getByLabel(`${LEAK}: ditt meddelande`, { exact: true })
        .fill(FROM_RESIDENT);
      await mine.getByRole("button", { name: "Skicka", exact: true }).click();
      await expect(mine.getByText(FROM_RESIDENT)).toBeVisible();

      // The assignee, now the board member, is told the reporter answered.
      await waitForMessage(ADMINISTRATOR.email, {
        subjectMatch: new RegExp(`^Nytt svar i ärende ${String(leak.number)}:`),
        timeoutMs: 60_000,
      });
      const again = rowOf(await openQueue(admin, "all"), LEAK_TEXT);
      await openHandling(again, LEAK);
      await expect(again.getByText(FROM_RESIDENT)).toBeVisible();
    });

    // --- 5. the reporter without an account ----------------------------------

    await test.step("the board and a reporter without an account talk through the private link", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, PUBLIC_TEXT);
      await openHandling(row, WEBSITE);
      await expect(
        row.getByText(/^Anmälaren har inget konto och läser svaren/),
      ).toBeVisible();
      await row
        .getByLabel(`${WEBSITE}: intern anteckning`, { exact: true })
        .fill(PUBLIC_NOTE);
      await row.getByRole("button", { name: "Lägg till anteckning" }).click();
      await expect(row.getByText(PUBLIC_NOTE)).toBeVisible();
      await row
        .getByLabel(`${WEBSITE}: meddelande till anmälaren`, { exact: true })
        .fill(TO_PUBLIC);
      await row.getByRole("button", { name: "Skicka", exact: true }).click();
      await expect(row.getByText(TO_PUBLIC)).toBeVisible();

      const { text } = await waitForMessage(publicReporter, {
        subjectMatch: /^Ditt ärende hos /,
      });
      const link = new URL(linkFrom(text, "/arende/")).pathname;
      const page = publicBrowser.page;
      await page.goto(link);
      await expect(page.getByText(TO_PUBLIC)).toBeVisible();
      await expect(page.getByText("Styrelsen", { exact: true })).toBeVisible();
      await expect(page.getByText(PUBLIC_NOTE)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(administratorName);

      await page.getByLabel("Skriv till föreningen").fill(FROM_PUBLIC);
      await page.getByRole("button", { name: "Skicka", exact: true }).click();
      await expect(
        page.getByText("Ditt meddelande har skickats till föreningen."),
      ).toBeVisible();

      const again = rowOf(await openQueue(admin, "all"), PUBLIC_TEXT);
      await openHandling(again, WEBSITE);
      await expect(again.getByText(FROM_PUBLIC)).toBeVisible();
    });

    // --- 6. a work order to a contractor -------------------------------------

    await test.step("a work order goes to the contractor with the handler's text alone", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, LEAK_TEXT);
      await row
        .locator("summary", { hasText: `Arbetsorder för ${LEAK}` })
        .click();
      await row
        .getByRole("combobox", { name: `${LEAK}: entreprenör`, exact: true })
        .selectOption({ label: `${contractor.name} (${contractor.trade})` });
      await row
        .getByLabel(`${LEAK}: arbetsorder`, { exact: true })
        .fill(WORK_ORDER);
      await row.getByRole("button", { name: "Förhandsgranska" }).click();

      // The preview is the mail: the handler's text, and nothing of the case.
      const preview = row
        .getByRole("region", { name: "Mejlet som entreprenören kommer att få" })
        .or(
          row
            .locator("section, div")
            .filter({ hasText: "Mejlet som entreprenören kommer att få" })
            .last(),
        );
      await expect(preview.getByText(WORK_ORDER)).toBeVisible();
      await expect(preview).not.toContainText(LEAK_TEXT);
      await expect(preview).not.toContainText(residentName);

      await row
        .getByRole("button", { name: `Skicka till ${contractor.name}` })
        .click();
      await expect(
        row.getByText(
          new RegExp(`^Arbetsordern till ${contractor.name} är sparad`),
        ),
      ).toBeVisible();

      const sent = await waitForMessage(contractor.email, {
        timeoutMs: 60_000,
      });
      const content = await messageContent(sent.message.ID);
      expect(content).toContain(WORK_ORDER);
      for (const withheld of [
        LEAK_TEXT,
        LEAK_PLACE,
        residentName,
        apartment.number,
        "/arende/",
        "/board/issues",
      ]) {
        expect(
          content,
          `the work order mail carries ${withheld}`,
        ).not.toContain(withheld);
      }
    });

    await test.step("the protected reporter is masked on the work order and the charges", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, PROTECTED_TEXT);
      await expect(
        row.getByText("Skyddade personuppgifter: fråga styrelsen."),
      ).toBeVisible();
      await openHandling(row, LEAK);
      await expect(
        row.getByText(/^Visas inte: den som anmälde ärendet har skyddade/),
      ).toBeVisible();
      await row
        .locator("summary", { hasText: `Arbetsorder för ${LEAK}` })
        .click();
      await expect(
        row.getByText(/^Den som anmälde har skyddade personuppgifter/),
      ).toBeVisible();
      for (const told of SHIELDED_TELLS) {
        await expect(row).not.toContainText(told);
      }
    });

    // --- 7. a charge from the case -------------------------------------------

    await test.step("the board makes a charge from the case", async () => {
      const queue = await openQueue(admin, "all");
      const row = rowOf(queue, LEAK_TEXT);
      await openHandling(row, LEAK);
      await saveChoice(
        admin,
        row,
        `${LEAK}: vem betalar`,
        "Bostadsrättshavaren",
        /\/api\/issue-queue\/[^/]+\/cost-responsibility$/,
      );
      await row
        .getByRole("link", { name: `${LEAK}: skapa debitering`, exact: true })
        .click();

      await expect(admin).toHaveURL(/\/board\/charges\?issue=/);
      await expect(
        admin.getByText(
          `Debiteringen görs från ärendet ${LEAK} och kopplas till det.`,
          { exact: false },
        ),
      ).toBeVisible();
      // The reason names the type and nothing the reporter wrote.
      await expect(admin.getByLabel("Vad debiteringen avser")).toHaveValue(
        `Ärende: ${LEAK}`,
      );
      await admin
        .getByLabel("Debiteringsdatum")
        .fill(formatLocalDay(localDayOf(new Date())));
      await admin.getByLabel("Belopp i kronor").fill("1250");
      const recorded = admin.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/member-charges",
      );
      await admin
        .getByRole("button", { name: "Registrera debiteringen" })
        .click();
      expect((await recorded).ok()).toBe(true);

      const back = rowOf(await openQueue(admin, "all"), LEAK_TEXT);
      await openHandling(back, LEAK);
      await expect(back.getByText(`Ärende: ${LEAK}`)).toBeVisible();

      // Still not to the property manager, who handles the same case.
      const theirs = rowOf(await openQueue(managerPage, "all"), LEAK_TEXT);
      await openHandling(theirs, LEAK);
      await expect(
        theirs.getByText("Debiteringar", { exact: true }),
      ).toHaveCount(0);
      await expect(theirs).not.toContainText(`Ärende: ${LEAK}`);
    });

    // --- 8. closed, and reopened by a reply ----------------------------------

    await test.step("the closed case is opened again by the resident's reply", async () => {
      const queue = await openQueue(admin, "all");
      await queueSelect(admin, "Status").selectOption({
        label: "Alla, även klara",
      });
      const row = rowOf(queue, LEAK_TEXT);
      await moveTo(admin, row, "Klar", "Åtgärdat");
      await expect(row.getByText("Utfall: Åtgärdat")).toBeVisible();
      const leak = await queuedByDescription(board, LEAK_TEXT);
      expect(leak.meaning).toBe("DONE");

      await residentPage.goto(appPath("/issues"));
      const mine = residentPage
        .getByRole("listitem")
        .filter({ hasText: LEAK_TEXT })
        .first();
      await mine
        .locator("summary", { hasText: `Meddelanden om ${LEAK}` })
        .click();
      await expect(
        mine.getByText(/^Anmälan är avslutad\. Skriver du här öppnas den igen/),
      ).toBeVisible();
      await mine
        .getByLabel(`${LEAK}: ditt meddelande`, { exact: true })
        .fill(REOPENING);
      await mine.getByRole("button", { name: "Skicka", exact: true }).click();
      await expect(mine.getByText(REOPENING)).toBeVisible();

      await expect
        .poll(async () => (await queuedByDescription(board, LEAK_TEXT)).meaning)
        .not.toBe("DONE");
      await waitForMessage(ADMINISTRATOR.email, {
        subjectMatch: new RegExp(
          `^Ärende ${String(leak.number)} har öppnats igen`,
        ),
        timeoutMs: 60_000,
      });

      const again = rowOf(await openQueue(admin, "all"), LEAK_TEXT);
      await openHandling(again, LEAK);
      await expect(again.getByText(REOPENING)).toBeVisible();
      await expect(
        again.getByText(/efter ett svar från anmälaren/),
      ).toBeVisible();
    });

    // --- the ring-fence on the ai surface ------------------------------------

    await test.step("a proposal for the ring-fenced case reads as gone and is refused", async () => {
      const fencedIssue = await queuedByDescription(board, FENCED_TEXT);
      // The board reads it, kept to the board.
      const row = rowOf(await openQueue(admin, "all"), FENCED_TEXT);
      await expect(row).toBeVisible();
      await expect(
        row.getByText("Bara styrelsen", { exact: true }),
      ).toBeVisible();
      // And no work order may take it out of the house.
      await row
        .locator("summary", { hasText: `Arbetsorder för ${FENCED}` })
        .click();
      await expect(
        row.getByText(
          "Inget om ett ärende av den här typen får nå en entreprenör, så ingen arbetsorder kan skickas.",
        ),
      ).toBeVisible();

      /*
       * What the AI package's proposal writes, held for the board member as
       * the package would hold it. Read back, it names an issue that is not
       * there, and confirming it is refused as if it never existed: nothing
       * of the case reached the proposal, and nothing reaches the case.
       */
      const input = { id: fencedIssue.id, priority: "LOW" };
      await holdPendingChange({
        actionName: "issue_set_priority",
        input,
        proposedByPersonId: administrator.personId,
      });
      const held = (await api.listPendingChanges(board, stack.baseUrl)).find(
        (change) =>
          change.actionName === "issue_set_priority" &&
          change.target?.id === fencedIssue.id,
      );
      if (held === undefined) {
        throw new Error("the proposal for the ring-fenced issue was not held");
      }
      try {
        expect(held.target?.state).toBe("missing");
        expect(
          await api.confirmPendingChange(board, stack.baseUrl, held.id),
        ).toEqual({ status: 404, reason: "issue-not-found" });
        expect((await queuedByDescription(board, FENCED_TEXT)).priority).toBe(
          fencedIssue.priority,
        );
      } finally {
        // The administrator is shared by every spec, and the change is held
        // for seven days: this one, by its id, and not what else they hold.
        await releasePendingChange(held.id);
      }
    });

    // --- no mail carries free text -------------------------------------------

    await test.step("no mail this flow caused carries anything anybody wrote", async () => {
      const ours = new Set(
        [
          manager.email,
          resident.email,
          shielded.email,
          publicReporter,
          contractor.email,
          ADMINISTRATOR.email,
        ].map((address) => address.toLowerCase()),
      );
      // Every mail the mailbox gained since the flow began, whoever it went
      // to: the scan below reads them all, so one that went to somebody the
      // flow does not know of is read as well.
      const mails = (await listMessages()).filter(
        (message) => !sentBefore.has(message.ID),
      );
      // At least the ones waited for above, to the people the flow made.
      const toOurs = mails.filter((message) =>
        message.To.some((to) => ours.has(to.Address.toLowerCase())),
      );
      expect(toOurs.length).toBeGreaterThanOrEqual(9);
      // The overdue reminder is among those read.
      expect(
        mails.some((message) =>
          /^Ärende \d+ har passerat senast klart/.test(message.Subject),
        ),
      ).toBe(true);
      // The ring-fenced issue is never mailed about, so no mail names its
      // type or carries its number.
      const fencedIssue = await queuedByDescription(board, FENCED_TEXT);
      const fencedNumber = new RegExp(
        `ärende\\s+${String(fencedIssue.number)}(?!\\d)`,
        "i",
      );
      for (const mail of mails) {
        const content = await messageContent(mail.ID);
        const to = mail.To.map((recipient) => recipient.Address).join(", ");
        expect(
          `${mail.Subject}\n${content}`,
          `"${mail.Subject}" to ${to} names the ring-fenced type`,
        ).not.toContain(FENCED);
        expect(
          `${mail.Subject}\n${content}`,
          `"${mail.Subject}" to ${to} is about the ring-fenced issue`,
        ).not.toMatch(fencedNumber);
        for (const written of FREE_TEXT) {
          expect(
            content,
            `"${mail.Subject}" to ${to} carries "${written}"`,
          ).not.toContain(written);
        }
        for (const told of [shielded.firstName, shielded.lastName]) {
          expect(
            content,
            `"${mail.Subject}" to ${to} names the protected reporter`,
          ).not.toContain(told);
        }
        // The work order's text, in the contractor's mail and nowhere else.
        const toContractor = mail.To.some(
          (recipient) =>
            recipient.Address.toLowerCase() === contractor.email.toLowerCase(),
        );
        if (!toContractor) {
          expect(
            content,
            `"${mail.Subject}" to ${to} carries the work order`,
          ).not.toContain(WORK_ORDER);
        }
      }
    });
  } finally {
    for (const opened of [
      adminBrowser,
      managerBrowser,
      residentBrowser,
      protectedBrowser,
      publicBrowser,
    ]) {
      await opened.context.close();
    }
  }
});
