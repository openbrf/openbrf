import type { Locator, Page } from "@playwright/test";

import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import {
  createSitePage,
  deleteSitePage,
  frontPage,
  setInMenu,
} from "../src/site";
import { appPath } from "../src/stack";

/**
 * The menu on the association's own website.
 *
 * Two promises meet here and neither can be seen from one screen. The board
 * arranges the menu in the application; a visitor with no account reads it on
 * the website, and what they read is not what a member reads - a page kept for
 * the members is not named to them at all, because a navigation that listed it
 * would be the navigation telling them it exists. The other is the dropdown:
 * the site runs no JavaScript, so the only proof that a second level can be
 * opened at all is to open it the way a person without a mouse would, with the
 * keyboard, in a real browser.
 *
 * The board's own person is used for both halves. They hold site:manage and
 * they hold a session, so the same context that built the menu is the signed-in
 * reader - one sign-in rather than two, on an instance whose authentication
 * endpoints are rate limited per client address.
 */

test.describe.configure({ mode: "serial" });

/** What the board types into the menu, in the order the entries are added. */
const ENTRIES = {
  parent: "Om föreningen",
  child: "Stadgar",
  member: "Styrelseprotokoll",
  external: "Boverket",
  builtIn: "Aktuellt",
} as const;

const EXTERNAL_URL = "https://boverket.invalid/bostadsratt";

async function signInAsBoard(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Översikt" }),
  ).toBeVisible();
}

/**
 * Adds a link to an address elsewhere, through the board's "Add a link" form.
 *
 * A page is not added here: the pages are listed in their own panel, one button
 * each, and the entry takes the page's title as its text.
 */
async function addLink(
  page: Page,
  entry: { label: string; url: string },
): Promise<void> {
  await page.getByLabel(/^Adress/).fill(entry.url);
  await page.getByLabel(/^Vad menyn säger/).fill(entry.label);
  await page
    .getByRole("button", { name: "Lägg till posten", exact: true })
    .click();
  await expect(page.getByText("Posten ligger i menyn.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Ändra ${entry.label}`, exact: true }),
  ).toBeVisible();
}

/**
 * Puts a page in the menu with its button in the "Add a page" panel. The entry
 * is last on the top level and says what the page is called; `label` renames
 * it afterwards, for the entries whose text should not change with the run.
 */
async function addPage(
  page: Page,
  title: string,
  label: string = title,
): Promise<void> {
  await page
    .getByRole("button", { name: `Lägg till ${title} i menyn`, exact: true })
    .click();
  await expect(page.getByText(`${title} ligger i menyn.`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Ändra ${title}`, exact: true }),
  ).toBeVisible();

  if (label !== title) {
    await page
      .getByRole("button", { name: `Ändra ${title}`, exact: true })
      .click();
    await page
      .getByLabel(/^Vad menyn säger/)
      .first()
      .fill(label);
    await page
      .getByRole("button", { name: "Spara ändringarna", exact: true })
      .click();
    await expect(page.getByText("Ändringarna är sparade.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Ändra ${label}`, exact: true }),
    ).toBeVisible();
  }
}

test("the board arranges the menu and the website answers each visitor with their own", async ({
  browser,
  clientAddress,
  api: request,
}) => {
  await ensureInstance(request);

  /*
   * Three pages, written the way the board writes them. The front page is
   * read first: it is the board's own choice - the wizard's page, on a
   * claimed instance - and the assertion at the end is that putting `about`
   * at the top of the menu has not changed it.
   */
  const front = await frontPage(request);
  const about = await createSitePage(request, { status: "PUBLIC" });
  const bylaws = await createSitePage(request, { status: "PUBLIC" });
  const minutes = await createSitePage(request, { status: "MEMBERS_ONLY" });

  /*
   * The board acts from an address of its own. Signing in through the browser
   * costs about four of the twenty requests a minute an address is allowed,
   * and the API context above has already spent one of the test's own on
   * establishing the instance.
   *
   * Both contexts below are opened by hand rather than taken from the suite's
   * fixtures, so each names its own language - the same reason
   * 93-public-site.spec.ts names it on every context it opens. The website
   * answers in the language the browser asks for, having nobody signed in
   * whose preference it could read, and a context that asked for nothing in
   * particular would be served in whatever Playwright's default happens to be.
   */
  const board = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "board"),
    },
  });
  const boardPage = await board.newPage();

  try {
    await signInAsBoard(boardPage);
    await boardPage.goto(appPath("/admin/site/menu"));
    // Exact: the panel below it is headed "Menyns poster", and a substring
    // match would find both and refuse to choose.
    await expect(
      boardPage.getByRole("heading", { name: "Meny", exact: true }),
    ).toBeVisible();

    await addPage(boardPage, about.title, ENTRIES.parent);
    await addPage(boardPage, bylaws.title, ENTRIES.child);
    // Under the entry above it, with the button that does what a drag sideways
    // does: the page becomes a dropdown item of "Om föreningen".
    await boardPage
      .getByRole("button", {
        name: `Gör ${ENTRIES.child} till en undermenypost under posten ovanför`,
        exact: true,
      })
      .click();
    await expect(
      boardPage.getByRole("button", {
        name: `Flytta ${ENTRIES.child} ut ur undermenyn, till toppnivån`,
        exact: true,
      }),
    ).toBeVisible();
    await addPage(boardPage, minutes.title, ENTRIES.member);
    await addLink(boardPage, { label: ENTRIES.external, url: EXTERNAL_URL });
    // A built-in page, from the same list as the association's own: the news
    // index is one of the pages, named as built in so it is not mistaken for
    // a page of the board's own.
    await addPage(boardPage, "Nyheter", ENTRIES.builtIn);
    await expect(
      boardPage.getByText("Nyheter, en inbyggd sida", { exact: true }),
    ).toBeVisible();

    // The board's row says why the members' page is not on everyone's menu,
    // so they need not go and look at the website to find out.
    await expect(
      boardPage.getByText(/Endast medlemmar, så posten döljs/),
    ).toBeVisible();

    /*
     * And the entry is moved to the top of the menu. That arranges the menu
     * and nothing else: which page the root serves is chosen on the page, so
     * the front page must not move with it.
     */
    await boardPage
      .getByRole("button", {
        name: `Flytta ${ENTRIES.parent} uppåt`,
        exact: true,
      })
      .click();
    await expect(
      boardPage.getByRole("button", {
        name: `Flytta ${ENTRIES.parent} uppåt`,
        exact: true,
      }),
    ).toBeDisabled();

    /*
     * --- what the log says about the arranging ----------------------------
     *
     * The menu was deliberately unaudited until something other than a board
     * member in a browser could write it. This is the end-to-end proof that
     * the edits above are recorded and that the record says how they were
     * made: the board member asks for their own data subject access report -
     * the document the association hands a person under art. 15 - and reads
     * their own menu edit on it, attributed to the web interface.
     */
    await boardPage.goto(appPath("/address-book"));
    await boardPage.getByLabel("Sök i registret").fill(ADMINISTRATOR.lastName);
    await boardPage
      .getByRole("cell", {
        name: `Öppna ${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`,
      })
      .click();
    await boardPage
      .getByRole("button", { name: "Ta fram registerutdraget" })
      .click();

    await expect(
      boardPage.getByRole("heading", { name: "Registerutdrag" }),
    ).toBeVisible();
    const audit = boardPage
      .getByRole("row")
      .filter({ hasText: "Menypost tillagd" })
      .first();
    await expect(audit).toBeVisible();
    // The column exists and this act came through the web interface, in the
    // association's own words rather than as an enum value.
    await expect(audit.getByText("Webbgränssnittet")).toBeVisible();

    await boardPage.goto(appPath("/admin/site/menu"));

    // --- the visitor with no account ---------------------------------------
    const anonymous = await browser.newContext({
      baseURL: stack.baseUrl,
      locale: "sv-SE",
      extraHTTPHeaders: {
        "x-forwarded-for": clientAddressFor(clientAddress, "anonymous"),
      },
    });
    const visitor = await anonymous.newPage();

    try {
      await visitor.goto("/");

      const nav = visitor.locator("nav");
      await expect(
        nav.getByRole("link", { name: ENTRIES.parent, exact: true }),
      ).toBeVisible();
      await expect(
        nav.getByRole("link", { name: ENTRIES.external, exact: true }),
      ).toBeVisible();
      // At the address the news index has always had.
      await expect(
        nav.getByRole("link", { name: ENTRIES.builtIn, exact: true }),
      ).toHaveAttribute("href", "/nyheter");

      /*
       * The whole point of the session-aware menu. The members' page is not
       * named, not linked and not mentioned - the anonymous visitor learns
       * nothing from the navigation that the byte-identical not-found page
       * would not already have refused to tell them.
       */
      await expect(nav).not.toContainText(ENTRIES.member);
      expect(await visitor.content()).not.toContain(minutes.slug);

      /*
       * The second level is closed until it is asked for, and asking is a
       * keyboard's business as much as a pointer's: nothing here runs a
       * script, so focus is what opens it.
       *
       * Two locators for one link, because the difference between them is the
       * property under test. A role locator reads the accessibility tree, and
       * ARIA excludes what is display:none - so `collapsed` has to say
       * includeHidden to find the entry at all, and `exposed` finding nothing
       * is what says the closed dropdown is genuinely not offered to a screen
       * reader rather than merely painted out of sight.
       */
      const collapsed = nav.getByRole("link", {
        name: ENTRIES.child,
        exact: true,
        includeHidden: true,
      });
      const exposed = nav.getByRole("link", {
        name: ENTRIES.child,
        exact: true,
      });

      // In the markup, and offered to nobody yet. A dropdown that was simply
      // absent would satisfy a hidden check while being no dropdown at all,
      // which is why the first of these asserts the entry is really there.
      await expect(collapsed).toBeAttached();
      await expect(collapsed).not.toBeVisible();
      await expect(exposed).toHaveCount(0);

      // Focus alone opens it - no click, no script - and the entry is then in
      // the accessibility tree rather than only on the screen.
      await nav
        .getByRole("link", { name: ENTRIES.parent, exact: true })
        .focus();
      await expect(exposed).toBeVisible();

      // And the next tab lands on it, which is the whole claim: a person with
      // no pointer can reach the second level of a menu that runs no script.
      await visitor.keyboard.press("Tab");
      await expect(exposed).toBeFocused();

      // An external entry is a link and never a request: nothing on the page
      // is fetched from the other host while it is being read.
      const external = nav.getByRole("link", {
        name: ENTRIES.external,
        exact: true,
      });
      await expect(external).toHaveAttribute("href", EXTERNAL_URL);
      await expect(external).toHaveAttribute("rel", /noopener/);
      expect(await visitor.evaluate(() => document.scripts.length)).toBe(0);
      expect(await anonymous.cookies()).toEqual([]);

      // The root serves the front page the board chose, wherever the menu
      // puts its entries. Only an instance with no choice made falls back to
      // the menu's first page entry.
      await expect(
        visitor.getByRole("heading", {
          level: 1,
          name: front?.title ?? about.title,
        }),
      ).toBeVisible();
    } finally {
      await anonymous.close();
    }

    // --- the same website, to somebody signed in ---------------------------
    await boardPage.goto("/");
    const memberNav = boardPage.locator("nav");
    await expect(
      memberNav.getByRole("link", { name: ENTRIES.member, exact: true }),
    ).toBeVisible();
    await expect(
      memberNav.getByRole("link", { name: ENTRIES.parent, exact: true }),
    ).toBeVisible();
  } finally {
    /*
     * The external entry points at no page, and the news index is never
     * removed, so nothing takes their entries when the pages go: the entries
     * for the three pages cascade with them, and these two are taken out by
     * name. The menu is left as the wizard wrote it.
     */
    const listed = await request.get(`${stack.baseUrl}/api/site/menu`, {
      failOnStatusCode: false,
    });
    if (listed.ok()) {
      const menu = (await listed.json()) as { id: string; label: string }[];
      for (const entry of menu.filter(
        (candidate) =>
          candidate.label === ENTRIES.external ||
          candidate.label === ENTRIES.builtIn,
      )) {
        await request.delete(`${stack.baseUrl}/api/site/menu/${entry.id}`, {
          failOnStatusCode: false,
        });
      }
    }

    await board.close();
    for (const written of [about, bylaws, minutes]) {
      await deleteSitePage(request, written.id);
    }
  }
});

/** One top-level entry of the website's menu and the dropdown under it. */
interface PublicEntry {
  label: string;
  children: string[];
}

/**
 * The menu as a visitor reads it, reduced to the entries named.
 *
 * Read from the markup the website sends, not from the board's screen: the
 * claim is that what the board arranged is what a visitor gets, and the two
 * can only be compared from the outside.
 */
async function publicMenu(
  visitor: Page,
  titles: readonly string[],
): Promise<PublicEntry[]> {
  await visitor.goto("/");
  const entries = await visitor
    .locator("nav.site-nav > ul > li")
    .evaluateAll((items) =>
      items.map((item) => ({
        label: item.querySelector(":scope > a")?.textContent ?? "",
        children: Array.from(
          item.querySelectorAll(":scope > ul > li > a"),
          (link) => link.textContent ?? "",
        ),
      })),
    );
  return entries
    .map((entry) => ({
      label: entry.label,
      children: entry.children.filter((child) => titles.includes(child)),
    }))
    .filter(
      (entry) => titles.includes(entry.label) || entry.children.length > 0,
    );
}

/**
 * Drags an entry by its handle with the pointer: onto another entry's handle,
 * and a number of pixels to the side. The pointer moves in steps because the
 * drag library works from the pointer's moves and not from where it ends.
 */
async function drag(
  page: Page,
  handle: Locator,
  onto: Locator,
  sideways = 0,
): Promise<void> {
  const from = await handle.boundingBox();
  const to = await onto.boundingBox();
  if (from === null || to === null) {
    throw new Error("The drag handle is not on the screen.");
  }
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 8, startY, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2 + sideways, to.y + to.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

/** Presses a button the way a keyboard does: focused, then Enter. */
async function pressWithKeyboard(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
}

test("the board puts pages in the menu, drags them into order and under each other, and does the same from the keyboard", async ({
  browser,
  clientAddress,
  api: request,
}) => {
  await ensureInstance(request);

  const first = await createSitePage(request, { status: "PUBLIC" });
  const second = await createSitePage(request, { status: "PUBLIC" });
  const third = await createSitePage(request, { status: "PUBLIC" });
  const pages = [first, second, third];
  const titles = pages.map((written) => written.title);

  const board = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "board"),
    },
  });
  const anonymous = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "anonymous"),
    },
  });

  try {
    // The page's own switch is what puts a page in the menu, last, in the
    // order they are turned on; spec 22 drives the switch itself.
    for (const written of pages) {
      expect(await setInMenu(request, written.id, true)).toBe(true);
    }

    const boardPage = await board.newPage();
    const visitor = await anonymous.newPage();
    await signInAsBoard(boardPage);
    await boardPage.goto(appPath("/admin/site/menu"));
    await expect(
      boardPage.getByRole("button", {
        name: `Ändra ${first.title}`,
        exact: true,
      }),
    ).toBeVisible();

    const handle = (title: string): Locator =>
      boardPage.getByTitle(`Dra för att flytta ${title}`, { exact: true });

    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: first.title, children: [] },
        { label: second.title, children: [] },
        { label: third.title, children: [] },
      ]);

    // --- by dragging --------------------------------------------------------
    // The last page onto the first: it goes before it.
    await drag(boardPage, handle(third.title), handle(first.title));
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: third.title, children: [] },
        { label: first.title, children: [] },
        { label: second.title, children: [] },
      ]);
    // Said for a screen reader where it went. The menu holds other entries
    // than these three, so the place is not asserted, only the level.
    await expect(
      boardPage.getByRole("status").filter({
        hasText: `${third.title} ligger på toppnivån, nummer`,
      }),
    ).toBeAttached();

    // Sideways, without leaving its place: under the entry above it, which
    // makes it a dropdown item of that entry.
    await drag(boardPage, handle(second.title), handle(second.title), 48);
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: third.title, children: [] },
        { label: first.title, children: [second.title] },
      ]);
    await expect(
      boardPage.getByRole("button", {
        name: `Flytta ${second.title} ut ur undermenyn, till toppnivån`,
        exact: true,
      }),
    ).toBeVisible();

    // --- by keyboard: the same moves, one button each ----------------------
    // Down past the entry and its dropdown.
    await pressWithKeyboard(boardPage, `Flytta ${third.title} nedåt`);
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: first.title, children: [second.title] },
        { label: third.title, children: [] },
      ]);

    // Out of the dropdown, back on the top level after the entry it hung from.
    await pressWithKeyboard(
      boardPage,
      `Flytta ${second.title} ut ur undermenyn, till toppnivån`,
    );
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: first.title, children: [] },
        { label: second.title, children: [] },
        { label: third.title, children: [] },
      ]);

    // And into the dropdown of the entry above.
    await pressWithKeyboard(
      boardPage,
      `Gör ${third.title} till en undermenypost under posten ovanför`,
    );
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: first.title, children: [] },
        { label: second.title, children: [third.title] },
      ]);
    // Said for a screen reader, in the board's language, where it went.
    await expect(
      boardPage.getByRole("status").filter({
        hasText: `${third.title} är en undermenypost under ${second.title}`,
      }),
    ).toBeAttached();

    // The arrangement is the server's: it is still there when the screen is
    // opened again.
    await boardPage.reload();
    await expect(
      boardPage.getByRole("button", {
        name: `Flytta ${third.title} ut ur undermenyn, till toppnivån`,
        exact: true,
      }),
    ).toBeVisible();

    // --- and out again: the switch takes a page's entry away ---------------
    // What hung under the entry stands in its place on the top level.
    expect(await setInMenu(request, second.id, false)).toBe(false);
    await expect
      .poll(() => publicMenu(visitor, titles))
      .toEqual([
        { label: first.title, children: [] },
        { label: third.title, children: [] },
      ]);
  } finally {
    await board.close();
    await anonymous.close();
    for (const written of pages) {
      await deleteSitePage(request, written.id);
    }
  }
});
