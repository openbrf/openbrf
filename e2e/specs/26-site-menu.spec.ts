import type { Page } from "@playwright/test";

import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { createSitePage, deleteSitePage } from "../src/site";
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
} as const;

const EXTERNAL_URL = "https://boverket.invalid/bostadsratt";

async function signInAsBoard(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * Adds one entry through the board's own form.
 *
 * The label is always typed, though a page entry may be left to take the
 * page's own title: the pages this spec writes are named for the run they
 * belong to, and an assertion reading "Sida 4f3a1c" would say nothing about
 * whether the menu works. That the title is borrowed when the field is empty
 * is pinned where it belongs, next to the rule.
 */
async function addEntry(
  page: Page,
  entry: { label: string; parent?: string } & (
    { pageTitle: string } | { url: string }
  ),
): Promise<void> {
  if ("url" in entry) {
    await page
      .getByRole("radio", { name: "En adress någon annanstans", exact: true })
      .check();
    await page.getByLabel(/^Adress/).fill(entry.url);
  } else {
    await page
      .getByRole("combobox", { name: /^Sida/ })
      .selectOption({ label: entry.pageTitle });
  }

  await page.getByLabel(/^Vad menyn säger/).fill(entry.label);
  await page
    .getByRole("combobox", { name: /^Ligger under/ })
    .selectOption({ label: entry.parent ?? "Toppnivå" });

  await page
    .getByRole("button", { name: "Lägg till posten", exact: true })
    .click();
  await expect(page.getByText("Posten ligger i menyn.")).toBeVisible();

  // The row itself, not only the confirmation: the entry is in the menu when
  // the list the server answered with has it.
  await expect(
    page.getByRole("button", { name: `Ändra ${entry.label}`, exact: true }),
  ).toBeVisible();
}

test("the board arranges the menu and the website answers each visitor with their own", async ({
  browser,
  clientAddress,
  api: request,
}) => {
  await ensureInstance(request);

  /*
   * Three pages, written the way the board writes them and therefore at the
   * end of the site's own order: a page created through the API is given the
   * position after every page the instance already has. That is what makes the
   * front-page assertion below say something. The root serves the menu's first
   * page entry and falls back to the lowest sort order only when the menu names
   * no page at all, so a page this spec created can never win that fallback -
   * and the association's front page moving to `about` is therefore the menu's
   * doing rather than an accident of where these three landed.
   */
  const about = await createSitePage(request, { visibility: "PUBLIC" });
  const bylaws = await createSitePage(request, { visibility: "PUBLIC" });
  const minutes = await createSitePage(request, { visibility: "MEMBER" });

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

    await addEntry(boardPage, {
      label: ENTRIES.parent,
      pageTitle: about.title,
    });
    await addEntry(boardPage, {
      label: ENTRIES.child,
      pageTitle: bylaws.title,
      parent: ENTRIES.parent,
    });
    await addEntry(boardPage, {
      label: ENTRIES.member,
      pageTitle: minutes.title,
    });
    await addEntry(boardPage, { label: ENTRIES.external, url: EXTERNAL_URL });

    // The board's row says why the members' page is not on everyone's menu,
    // so they need not go and look at the website to find out.
    await expect(
      boardPage.getByText(/Endast medlemmar, så posten döljs/),
    ).toBeVisible();

    /*
     * And the entry is moved to the top of the menu, which is how the front
     * page is chosen: the association's website has no "this is the home page"
     * setting, because the menu is the ordering and a second way to say which
     * page comes first would only be a second way for the two to disagree.
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

      // The root serves the menu's first page entry, whatever order the pages
      // themselves sit in.
      await expect(
        visitor.getByRole("heading", { name: about.title }),
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
     * The external entry points at no page, so nothing removes it when the
     * pages go: the entries for the three pages cascade with them, and this
     * one is taken out by name. The menu is left as the wizard wrote it.
     */
    const listed = await request.get(`${stack.baseUrl}/api/site/menu`, {
      failOnStatusCode: false,
    });
    if (listed.ok()) {
      const menu = (await listed.json()) as { id: string; label: string }[];
      for (const entry of menu.filter(
        (candidate) => candidate.label === ENTRIES.external,
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
