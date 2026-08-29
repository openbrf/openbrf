import * as api from "../src/api";
import { grantBoardSeat } from "../src/board";
import { expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import { clearMailbox, waitForMessage } from "../src/mailpit";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";

/**
 * The two forms the association's website offers somebody with no account.
 *
 * Not one of the numbered exit criteria. It is here because the property these
 * forms exist to have cannot be seen from any unit test: a real browser, on a
 * page served under the site's own content policy, with JavaScript doing
 * nothing at all, sends a plain HTML form and lands on a confirmation. Every
 * other test in the tree renders the markup and reasons about it; this one
 * makes a browser act on it.
 *
 * Three things are held here.
 *
 * A neighbour writes to the board and it arrives twice over: as an email to
 * the board, and as a row in the inbox the board reads. The row is the record
 * and the email is a notification about it - the message is stored before
 * anything is enqueued, so a mail server that is down cannot lose it.
 *
 * A passer-by reports a fault and it appears in the triage queue under a type
 * the public was offered, attributed to somebody with no account.
 *
 * And the board can close the public report form without taking the page down.
 * The block stays where it was put and comes back when reporting is opened
 * again, which is what lets a board change its mind without editing a page.
 *
 * The website sets no cookie on any of it, including the submissions. That is
 * asserted here because this is the only place a real browser is in the room.
 *
 * The labels below are Swedish because the website renders its chrome in the
 * VISITOR's own language, falling back to the association's, and the suite's
 * browser context asks for Swedish. Only the chrome is translated: the page
 * titles, the intro sentences and the issue types are the association's own
 * writing and are stored as written (decision 59).
 */

test.describe.configure({ mode: "serial" });

/*
 * This run's own pages and type, so a rerun against a kept stack reads its own
 * rows and a slug never collides with one a previous run left behind.
 */
const CONTACT_SLUG = `kontakta-oss-${uniqueSurname("k").toLowerCase()}`;
const REPORT_SLUG = `felanmalan-${uniqueSurname("f").toLowerCase()}`;
const REPORT_TYPE = uniqueSurname("Trasig port");

const CONTACT_INTRO = `Styrelsen läser detta, ${uniqueSurname("intro")}.`;
const REPORT_INTRO = `Anmäl fel i huset, ${uniqueSurname("intro")}.`;

const SENDER = {
  name: `Bo ${uniqueSurname("Granne")}`,
  email: `bo-${uniqueSurname("granne").toLowerCase()}@exempel.se`,
  message: `Porten mot gatan går inte att stänga, ${uniqueSurname("brev")}.`,
} as const;

const REPORTER = {
  name: `Nina ${uniqueSurname("Forbipasserande")}`,
  email: `nina-${uniqueSurname("nina").toLowerCase()}@exempel.se`,
  description: `Porten står på glänt hela dygnet, ${uniqueSurname("anmalan")}.`,
} as const;

/**
 * The instance this file needs, established once and then found again.
 *
 * Idempotent against the instance rather than against this process, like every
 * other fixture in the suite: the pages are looked up by slug before they are
 * written, so a rerun against a kept stack does not try to claim an address it
 * already holds.
 *
 * It also puts the administrator on the board. Nothing in phase 1 elects
 * anybody, so the fixture instance has no board at all - and who is emailed
 * when the public writes to the association is the one thing that depends on
 * there being one.
 */
async function ensureFormPages(
  request: Parameters<typeof ensureInstance>[0],
): Promise<void> {
  await ensureInstance(request);

  const administratorId = await api.findPersonIdByName(
    request,
    stack.baseUrl,
    `${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`,
  );
  if (administratorId === undefined) {
    throw new Error("the administrator is not in the address book");
  }
  await grantBoardSeat(administratorId);

  const types = await api.listIssueTypes(request, stack.baseUrl);
  if (!types.some((type) => type.name === REPORT_TYPE)) {
    await api.createIssueType(request, stack.baseUrl, {
      name: REPORT_TYPE,
      audience: "NON_MEMBER",
      sortOrder: 900,
    });
  }

  /*
   * Two pages rather than one carrying both forms. That is how an association
   * actually arranges them - a page to write to the board, a page to report a
   * fault - and it keeps each field's label unique on the page a test is
   * looking at, which is what lets these tests select by label at all.
   */
  await ensurePage(request, {
    slug: CONTACT_SLUG,
    title: "Kontakta oss",
    blocks: [{ type: "contactForm", intro: [{ text: CONTACT_INTRO }] }],
  });
  await ensurePage(request, {
    slug: REPORT_SLUG,
    title: "Felanmälan",
    blocks: [
      { type: "paragraph", runs: [{ text: REPORT_INTRO }] },
      { type: "issueReportForm" },
    ],
  });
}

async function ensurePage(
  request: Parameters<typeof ensureInstance>[0],
  input: {
    slug: string;
    title: string;
    blocks: readonly api.SitePageBlock[];
  },
): Promise<void> {
  const existing = await request.get(`${stack.baseUrl}/${input.slug}`, {
    failOnStatusCode: false,
  });
  if (existing.status() === 200) {
    return;
  }

  const page = await api.createSitePage(request, stack.baseUrl, {
    slug: input.slug,
    title: input.title,
    blocks: input.blocks,
    visibility: "PUBLIC",
  });
  await api.publishSitePage(request, stack.baseUrl, page.id);
}

test("a neighbour writes to the board from the association's website", async ({
  page,
  context,
  api: request,
}) => {
  await ensureFormPages(request);
  await clearMailbox();

  await page.goto(`/${CONTACT_SLUG}`);
  await expect(
    page.getByRole("heading", { name: "Kontakta oss" }),
  ).toBeVisible();
  await expect(page.getByText(CONTACT_INTRO)).toBeVisible();

  // Genuine input and textarea elements, so fill() is the right instrument:
  // there is no rich-text surface anywhere on this page, and nothing on it runs.
  await page.getByLabel("Ditt namn (frivilligt)").fill(SENDER.name);
  await page.getByLabel("Din e-postadress", { exact: true }).fill(SENDER.email);
  await page.getByLabel("Ditt meddelande").fill(SENDER.message);

  // Nothing runs, so nothing intercepts this: the browser posts the form and
  // follows the 303 to the page it came from.
  await page.getByRole("button", { name: "Skicka meddelandet" }).click();

  await expect(
    page.getByText("Meddelandet har nått styrelsen", { exact: false }),
  ).toBeVisible();
  // The form is gone from the page it landed on, so a reload cannot send it a
  // second time.
  await expect(
    page.getByRole("button", { name: "Skicka meddelandet" }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  // A public page that set a cookie on a submission would be a public page that
  // tracks the people who write to it.
  expect(await context.cookies()).toEqual([]);

  // The email to the board, through the queue.
  const { text } = await waitForMessage(ADMINISTRATOR.email, {
    subjectMatch: /skrivit till föreningen/,
  });
  expect(text).toContain(SENDER.message);
  expect(text).toContain(SENDER.email);

  // And the record the board reads, which exists whether or not that mail went
  // anywhere: the message is stored before anything is enqueued.
  const inbox = await api.listContactSubmissions(request, stack.baseUrl);
  const stored = inbox.find((row) => row.message === SENDER.message);
  expect(stored?.name).toBe(SENDER.name);
  expect(stored?.email).toBe(SENDER.email);
  expect(stored?.handled).toBe(false);
});

test("a passer-by reports a fault and it reaches the triage queue", async ({
  page,
  api: request,
}) => {
  await ensureFormPages(request);

  await page.goto(`/${REPORT_SLUG}`);
  // Level 1 is the page's own title. The form below it carries an h2 reading
  // the same word, which is the glossary's term for what the form is, so the
  // level is what tells the two apart.
  await expect(
    page.getByRole("heading", { name: "Felanmälan", level: 1 }),
  ).toBeVisible();

  // The types the association put in front of the public, and no others. The
  // filter is the server's: this select is rendered from it.
  await page.getByLabel("Vad det gäller").selectOption({ label: REPORT_TYPE });
  await page
    .getByLabel("Var i fastigheten (frivilligt)")
    .fill("Porten mot gatan");
  await page.getByLabel("Beskriv felet").fill(REPORTER.description);
  await page.getByLabel("Ditt namn (frivilligt)").fill(REPORTER.name);
  await page.getByLabel("Din e-postadress (frivilligt)").fill(REPORTER.email);

  // The warning the law research asks for, beside the field rather than in a
  // policy elsewhere.
  await expect(
    page.getByText("Utelämna uppgifter om hälsa", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Skicka anmälan" }).click();
  await expect(page.getByText("Anmälan har nått föreningen.")).toBeVisible();

  const queue = await api.listIssueQueue(request, stack.baseUrl);
  const reported = queue.find(
    (issue) => issue.description === REPORTER.description,
  );
  expect(reported?.typeName).toBe(REPORT_TYPE);
  expect(reported?.status).toBe("NEW");
  // Nobody signed in filed it, and the association still knows who to answer.
  expect(reported?.reporter.kind).toBe("external");
  expect(reported?.reporter.name).toBe(REPORTER.name);
});

test("the board closes the report form without taking the page down", async ({
  page,
  context,
  api: request,
}) => {
  await ensureFormPages(request);

  await api.setPublicIssueReporting(request, stack.baseUrl, false);
  try {
    await page.goto(`/${REPORT_SLUG}`);

    // The page survives the switch. Everything the board wrote is still on it;
    // only the form is gone, so closing the form is not an edit to the page.
    await expect(
      page.getByRole("heading", { name: "Felanmälan", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(REPORT_INTRO)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skicka anmälan" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Felanmälan", level: 2 }),
    ).toHaveCount(0);
    await expect(page.getByText(REPORT_TYPE)).toHaveCount(0);

    // And the endpoint behind it answers exactly as an address that names no
    // page at all does. The block being absent and the endpoint being absent
    // are one fact seen twice.
    const closed = await context.request.post(
      `${stack.baseUrl}/${REPORT_SLUG}/felanmalan`,
      {
        form: { type: "whatever", description: "Stängd anmälan." },
        failOnStatusCode: false,
      },
    );
    const missing = await context.request.get(
      `${stack.baseUrl}/en-sida-som-aldrig-skrivits`,
      { failOnStatusCode: false },
    );
    expect(closed.status()).toBe(404);
    expect(await closed.text()).toBe(await missing.text());
  } finally {
    // Restored whatever happened above: the default is on, and a switch left
    // off here would take the form away from every spec that runs afterwards.
    await api.setPublicIssueReporting(request, stack.baseUrl, true);
  }

  // Reopened, and the form is back on the page nobody edited.
  await page.goto(`/${REPORT_SLUG}`);
  await expect(
    page.getByRole("button", { name: "Skicka anmälan" }),
  ).toBeVisible();
});
