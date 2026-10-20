import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import {
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { slugFromTitle } from "@openbrf/shared";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { clientAddressFor } from "../src/fixtures";
import {
  chooseFrontPage,
  deleteSitePage,
  frontPage,
  pngPicture,
} from "../src/site";
import { appPath } from "../src/stack";

/**
 * The board writing the association's own website.
 *
 * Not one of the numbered exit criteria. It is here because the page editor is
 * the one screen whose output is served to people with no account, and some
 * of its properties cannot be seen from the screen itself: that the page the
 * board edits as it looks is the page the website serves, laid out the same
 * way; that it is built, arranged and published without leaving the editor,
 * with a pointer or with the keyboard alone; that publishing is refused while
 * the text carries a personal identity number; that the page the board
 * chooses as the front page is the one the root serves; and that a claimed
 * instance links a privacy notice from the footer of every page it publishes.
 *
 * This spec navigates the instance root, which the guard in
 * 93-public-site.spec.ts allows it by name: reading the published page on the
 * website is the assertion, and the website really is at the root.
 */

test.describe.configure({ mode: "serial" });

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse: the scan runs the anchored validator over unanchored candidates
 * precisely so that an invoice number does not stop a board publishing.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

/** The + at the end of the page. */
const ADD_AT_END = "Lägg till ett block sist på sidan";

/**
 * One address per test, which is what the shared fixture already gives it.
 *
 * Every test below acts as one person - the administrator, who holds
 * site:manage - so the test's own address is the only one needed. The
 * authentication endpoints allow twenty requests a minute per address, and one
 * browser sign-in that lands on a screen costs about five of them, because
 * every guarded route reads the session on the way.
 */
async function signIn(page: Page): Promise<void> {
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
 * A request context carrying no session at all.
 *
 * The browser's own context is signed in as the board, and its request object
 * carries those cookies. Reading the published page through it would prove
 * that the board can read it, which is not the question.
 */
async function anonymousRequest(
  clientAddress: string,
): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: { "x-forwarded-for": clientAddress },
  });
}

/**
 * Writes into a paragraph the way a person does.
 *
 * A paragraph is a rich-text surface, not a field. `fill()` writes into a
 * contenteditable element directly, which dispatches nothing: the editor's own
 * document never changes, so the page serialises to no blocks and publishes
 * blank. The text has to arrive through the input pipeline, which means
 * clicking into the surface and pressing keys.
 *
 * The check at the end belongs here rather than at whatever the test does
 * next. If the text never reached the editor, this is where it went wrong, and
 * a failure three assertions later reads as a broken renderer instead.
 */
async function writeParagraph(
  page: Page,
  label: string,
  text: string,
): Promise<void> {
  const surface = page.getByLabel(label, { exact: true });
  await surface.focus();
  await surface.pressSequentially(text);
  await expect(surface).toHaveText(text);
}

/**
 * Adds a block with a +, as a person does: the + opens the list of blocks,
 * one is chosen, and the new block takes the focus where it stands.
 */
async function addBlock(
  page: Page,
  kind: string,
  where = ADD_AT_END,
): Promise<void> {
  await page.getByRole("button", { name: where, exact: true }).click();
  const list = page.getByRole("dialog", { name: "Lägg till ett block" });
  await list.getByRole("button", { name: kind, exact: true }).click();
  await expect(list).toHaveCount(0);
  await expect(page.locator("[data-canvas-block] :focus")).toHaveCount(1);
}

/** The settings beside the page. */
function settings(page: Page): Locator {
  return page.getByRole("complementary", { name: "Inställningar" });
}

/**
 * Creates a page from the new-page panel and leaves its editor open, returning
 * the address it was given.
 *
 * Nothing but the title is typed. The address is made from it, and the panel
 * says which one before the page is created - which is the whole of what a
 * board member has to know about addresses.
 */
async function createPage(page: Page, title: string): Promise<string> {
  const slug = slugFromTitle(title);
  const panel = page.locator("section").filter({ hasText: "Ny sida" });
  await panel.getByLabel(/^Rubrik/).fill(title);
  await expect(panel.getByText(`Den hamnar på /${slug}.`)).toBeVisible();
  await panel.getByRole("button", { name: "Skapa sidan" }).click();

  // The editor opens on the page that was just written, at its own address,
  // as a draft.
  await expect(page).toHaveURL(/\/board\/site\/pages\//);
  await expect(page.getByRole("radio", { name: /^Utkast/ })).toBeChecked();
  return slug;
}

/** Chooses a status in the editor and saves the page with it. */
async function saveAs(page: Page, status: RegExp): Promise<void> {
  await page.getByRole("radio", { name: status }).check();
  await page.getByRole("button", { name: "Spara", exact: true }).click();
}

test("the board writes a page and publishes it to the website", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  const run = randomUUID().slice(0, 8);
  const sentence = `Trapphuset städas varje tisdag, ${run}.`;

  await page.goto(appPath("/board/site"));
  await expect(
    page.getByRole("heading", { name: "Föreningens webbplats" }),
  ).toBeVisible();

  const slug = await createPage(page, `Trapphuset ${run}`);
  expect(slug).toBe(`trapphuset-${run}`);

  // The warning about special-category free text stands on the editor whether
  // or not anything is wrong with what has been written.
  await expect(page.getByText(/namngiven persons hälsa/i)).toBeVisible();

  await addBlock(page, "Stycke");
  await writeParagraph(page, "Stycke 1", sentence);

  // Written where the website shows it: in the page's own column, under the
  // website's own rules.
  await expect(
    page
      .locator(".site-canvas .site-main")
      .getByLabel("Stycke 1", { exact: true }),
  ).toHaveText(sentence);

  await saveAs(page, /^Öppen/);
  await expect(page.getByText("Sparad.")).toBeVisible();

  /*
   * Read again, so the paragraph comes back out of the database rather than
   * out of the state the browser still holds. This is the assertion that
   * fails if a page ever serialises to no blocks on the way in: the editor
   * would still look right, because it shows the draft.
   */
  await page.reload();
  await expect(page.getByLabel("Stycke 1", { exact: true })).toHaveText(
    sentence,
  );

  // And now the website itself, asked by somebody with no account at all.
  const anonymous = await anonymousRequest(clientAddress);
  try {
    const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain(sentence);
    expect(body.includes("<script")).toBe(false);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  } finally {
    await anonymous.dispose();
  }
});

test("publishing is refused while the page carries a personal identity number", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  await page.goto(appPath("/board/site"));
  const slug = await createPage(page, `Styrelsen ${randomUUID().slice(0, 8)}`);

  await addBlock(page, "Stycke");
  await writeParagraph(
    page,
    "Stycke 1",
    `Ordförande är Anna, ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER}.`,
  );

  // The browser says so before the server has to. That is a courtesy; the
  // refusal below is the control.
  await expect(page.getByText(/ser ut som ett personnummer/i)).toBeVisible();

  await saveAs(page, /^Öppen/);
  await expect(page.getByText(/innehåller ett personnummer/i)).toBeVisible();

  // Nothing was published, so the website answers as it does for an address
  // with nothing behind it.
  const anonymous = await anonymousRequest(clientAddress);
  try {
    const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(404);
  } finally {
    await anonymous.dispose();
  }
});

test("the board chooses the front page, and the root serves it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  // The front page the wizard chose, put back afterwards: the specs after
  // this one read the root as a claimed instance serves it.
  const before = await frontPage(request);
  const anonymous = await anonymousRequest(clientAddress);
  try {
    await signIn(page);

    const run = randomUUID().slice(0, 8);
    const sentence = `Välkommen till gården, ${run}.`;

    await page.goto(appPath("/board/site"));
    const slug = await createPage(page, `Gården ${run}`);
    await addBlock(page, "Stycke");
    await writeParagraph(page, "Stycke 1", sentence);

    // Only a public page can be the front page, so the switch waits for it.
    const front = page.getByRole("switch", { name: "Använd som startsida" });
    await expect(front).toBeDisabled();
    await page.getByRole("radio", { name: /^Öppen/ }).check();
    await front.check();
    await page.getByRole("button", { name: "Spara", exact: true }).click();
    await expect(page.getByText("Sparad.")).toBeVisible();

    // The front page stays public, and stays, until another one is chosen.
    await expect(page.getByRole("radio", { name: /^Utkast/ })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Ta bort sidan" }),
    ).toBeDisabled();
    await expect(page.getByText("Öppen · Startsida")).toBeVisible();
    await page.goto(appPath("/board/site"));
    await expect(
      page.locator("li").filter({ hasText: slug }).getByText("Startsida"),
    ).toBeVisible();

    const root = await anonymous.get(`${stack.baseUrl}/`, {
      failOnStatusCode: false,
    });
    expect(root.status()).toBe(200);
    expect(await root.text()).toContain(sentence);
  } finally {
    await anonymous.dispose();
    // Runs whichever step failed. The page this spec chose can only be
    // deleted once another is the front page, so with none before it stays,
    // public.
    const chosen = await frontPage(request);
    if (before !== null && chosen !== null && chosen.id !== before.id) {
      await chooseFrontPage(request, before.id);
      await deleteSitePage(request, chosen.id);
    }
  }
});

test("a plugin's block the instance cannot show is kept when the board saves around it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  /*
   * What a page holds once the plugin that wrote a block is switched off: a
   * namespaced type nothing on this instance defines. Written through the API,
   * because no screen here can make one.
   */
  const slug = `omrostning-${randomUUID().slice(0, 8)}`;
  const question = `Ska vi måla om trapphuset, ${slug}?`;
  const poll = { type: "example-plugin/poll", question };
  const written = await api.createSitePage(request, stack.baseUrl, {
    slug,
    title: "Omröstning",
    blocks: [{ type: "paragraph", runs: [{ text: "Före." }] }, poll],
  });

  try {
    await page.goto(appPath(`/board/site/pages/${written.id}`));

    // Named as what it is, with the controls every block has, and said to be
    // unavailable rather than broken: its plugin is not installed, is off or
    // does not offer it.
    await expect(
      page.locator("[data-canvas-content]").getByText("Block från ett tillägg"),
    ).toBeVisible();
    await expect(
      page.getByText(/Blocket är inte tillgängligt just nu/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Ta bort, block 2/ }),
    ).toBeVisible();

    await addBlock(page, "Stycke");
    await writeParagraph(page, "Stycke 3", "Svara senast fredag.");
    await saveAs(page, /^Öppen/);
    await expect(page.getByText("Sparad.")).toBeVisible();

    const pages = await request.get(`${stack.baseUrl}/api/site/pages`);
    const stored = (
      (await pages.json()) as {
        id: string;
        content: { blocks: Record<string, unknown>[] };
      }[]
    ).find((one) => one.id === written.id);
    expect(stored?.content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Före." }] },
      poll,
      { type: "paragraph", runs: [{ text: "Svara senast fredag." }] },
    ]);

    // And a visitor is served the page around it, and nothing of it.
    const anonymous = await anonymousRequest(clientAddress);
    try {
      const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
        failOnStatusCode: false,
      });
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).toContain("Svara senast fredag.");
      expect(body).not.toContain(question);
    } finally {
      await anonymous.dispose();
    }
  } finally {
    await api.deleteSitePage(request, stack.baseUrl, written.id);
  }
});

test("the board lays a page out with a button and columns, from the keyboard", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  const run = randomUUID().slice(0, 8);
  const heading = `Bokning, ${run}`;

  await page.goto(appPath("/board/site"));
  const slug = await createPage(page, `Tvättstugan ${run}`);

  /*
   * Every control here is reached and worked from the keyboard, because the
   * editor's promise is that nothing about a page needs a pointer: the +, the
   * list of blocks it opens, the field a button's words are written in, the
   * settings beside the page and the tools over a block are all ordinary
   * controls.
   */
  const choose = async (where: string, kind: string): Promise<void> => {
    await page.getByRole("button", { name: where, exact: true }).focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("dialog", { name: "Lägg till ett block" });
    await list.getByLabel("Sök efter ett block").fill(kind);
    await list.getByRole("button", { name: kind, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(page.locator("[data-canvas-block] :focus")).toHaveCount(1);
  };

  await choose(ADD_AT_END, "Knapp");
  // The new button's words are written on the button, which has the focus.
  await page.keyboard.type("Se kalendern");
  await settings(page)
    .getByRole("radio", { name: "En sida webbplatsen bygger själv" })
    .check();
  await settings(page)
    .getByRole("combobox", { name: "Sida" })
    .selectOption("calendar");

  await choose(ADD_AT_END, "Kolumner");
  await choose("Lägg till i kolumn 1", "Knapp");
  await choose("Lägg till ett block efter Knapp 1 i kolumn 1", "Rubrik");
  await page.keyboard.type(heading);

  // The heading went in last; moved above the button, from the keyboard, and
  // the move is announced where a screen reader hears it.
  await page
    .getByRole("button", { name: "Flytta upp, Rubrik 2 i kolumn 1" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Rubrik är nu block 1 av 2 i kolumn 1 i block 2."),
  ).toBeAttached();

  await saveAs(page, /^Öppen/);
  await expect(page.getByText("Sparad.")).toBeVisible();

  const anonymous = await anonymousRequest(clientAddress);
  try {
    const response = await anonymous.get(`${stack.baseUrl}/${slug}`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain('href="/kalender">Se kalendern</a>');
    expect(body).toContain('<div class="site-columns site-columns-2">');
    expect(body).toContain(`<h2>${heading}</h2>`);
    // The button in the column had no words written on it, so it was not
    // saved: a block nobody wrote anything in is not a block on the page.
    // Counted by its class attribute, since the inline stylesheet names the
    // class too.
    expect(body.match(/class="site-button /g)).toHaveLength(1);
    expect(body.includes("<script")).toBe(false);
  } finally {
    await anonymous.dispose();
  }
});

test("the board builds a page with the +, arranges it by dragging and from the keyboard, and publishes it as it looks", async ({
  page,
  browser,
  api: request,
  clientAddress,
}) => {
  await ensureInstance(request);
  await signIn(page);

  const run = randomUUID().slice(0, 8);
  const title = `Sommarfest ${run}`;

  await page.goto(appPath("/board/site"));
  const slug = await createPage(page, title);

  // A paragraph, a banner, and two columns: a button in one, words in the
  // other - every one of them added with a +, without leaving the editor.
  await addBlock(page, "Stycke");
  await writeParagraph(page, "Stycke 1", `Välkomna, ${run}.`);

  await addBlock(page, "Banner");
  await page.keyboard.type(`Midsommar på gården ${run}`);
  await settings(page)
    .getByLabel(/^Bild(?!ens)/)
    .setInputFiles({
      name: "garden.png",
      mimeType: "image/png",
      buffer: pngPicture(),
    });
  await expect(page.locator(".site-canvas .site-banner img")).toHaveAttribute(
    "src",
    /\/api\/media\//,
  );
  await settings(page)
    .getByLabel(/^Beskrivning av bilden/)
    .fill("Gården en sommarkväll");

  await addBlock(page, "Kolumner");
  await addBlock(page, "Knapp", "Lägg till i kolumn 1");
  await page.keyboard.type("Anmäl dig");
  await settings(page)
    .getByRole("radio", { name: "En sida webbplatsen bygger själv" })
    .check();
  await settings(page)
    .getByRole("combobox", { name: "Sida" })
    .selectOption("calendar");
  await addBlock(page, "Stycke", "Lägg till i kolumn 2");
  await writeParagraph(page, "Kolumn 2, stycke 1", "Ta med något att grilla.");

  const order = async (): Promise<string[]> =>
    page
      .locator(".site-canvas .site-main > [data-canvas-block]")
      .evaluateAll((blocks) =>
        blocks.map(
          (block) =>
            block.querySelector("[role=toolbar] span")?.textContent ?? "",
        ),
      );
  expect(await order()).toEqual(["Stycke", "Banner", "Kolumner"]);

  /*
   * Dragged by its handle with a pointer: the paragraph from the top of the
   * page to below the columns. The block has to be selected for its tools to
   * show, as a person clicking it would.
   */
  await page.getByLabel("Stycke 1", { exact: true }).click();
  const handle = page.getByRole("button", { name: "Flytta block 1, Stycke" });
  const from = await handle.boundingBox();
  const to = await page
    .getByRole("button", { name: ADD_AT_END, exact: true })
    .boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  if (from === null || to === null) {
    return;
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + 40, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 20,
  });
  await page.mouse.up();
  expect(await order()).toEqual(["Banner", "Kolumner", "Stycke"]);

  /*
   * And from the keyboard, from the same handle: picked up, moved one place
   * up - into the end of the second column - and put down, each step said
   * where a screen reader hears it.
   */
  await page.getByRole("button", { name: "Flytta block 3, Stycke" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Stycke är släppt. Stycke är nu block 2 av 2 i kolumn 2 i block 2.",
    ),
  ).toBeAttached();
  expect(await order()).toEqual(["Banner", "Kolumner"]);

  // Nothing on the editor is in the way of somebody using assistive
  // technology.
  const editorScan = await new AxeBuilder({ page }).analyze();
  expect(
    editorScan.violations
      .filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      )
      .map((violation) => violation.id),
  ).toEqual([]);

  // Published from the editor: the status beside the page, and one save.
  await saveAs(page, /^Öppen/);
  await expect(page.getByText("Sparad.")).toBeVisible();

  /*
   * The page as a visitor with no account is served it, at the same width,
   * next to the page in the editor. Each part is measured in both: drawn by
   * the same rules at the same width, they have the same size and the same
   * look.
   */
  const visitor = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    viewport: page.viewportSize() ?? undefined,
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "visitor"),
    },
  });
  try {
    const published = await visitor.newPage();
    const response = await published.goto(`/${slug}`);
    expect(response?.status()).toBe(200);
    await expect(
      published.getByRole("heading", { level: 1, name: title }),
    ).toBeVisible();

    const look = async (
      where: Page,
      selector: string,
    ): Promise<Record<string, string | number>> =>
      where
        .locator(selector)
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            width: Math.round(box.width),
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderTopLeftRadius,
            gridTemplateColumns: style.gridTemplateColumns,
          };
        });
    for (const selector of [
      ".site-banner",
      ".site-banner-body h2",
      ".site-banner-image",
      ".site-columns",
      ".site-column p",
    ]) {
      expect(await look(page, `.site-canvas ${selector}`), selector).toEqual(
        await look(published, `.site-main ${selector}`),
      );
    }
    // The button's words are written in a field in the editor, sized to
    // them, so it is held to the same look but not to the same width.
    const { width: _editing, ...button } = await look(
      page,
      ".site-canvas .site-button",
    );
    const { width: _published, ...served } = await look(
      published,
      ".site-main .site-button",
    );
    expect(button).toEqual(served);

    /*
     * And on a telephone, where the page is a single column: the editor's
     * frame leaves the page the width the website gives it, so a line wraps
     * where it will on the public page.
     */
    const phone = { width: 390, height: 844 };
    await page.setViewportSize(phone);
    await published.setViewportSize(phone);
    for (const selector of [
      ".site-banner",
      ".site-banner-body h2",
      ".site-banner-image",
      ".site-columns",
      ".site-column p",
    ]) {
      expect(
        await look(page, `.site-canvas ${selector}`),
        `${selector} at 390px`,
      ).toEqual(await look(published, `.site-main ${selector}`));
    }
    await expect(
      published.getByRole("link", { name: "Anmäl dig" }),
    ).toHaveAttribute("href", "/kalender");
    await expect(
      published.locator(".site-column").nth(1).getByText(`Välkomna, ${run}.`),
    ).toBeVisible();
    expect(await published.evaluate(() => document.scripts.length)).toBe(0);
  } finally {
    await visitor.close();
  }
});

test("a claimed instance links its privacy notice from the footer", async ({
  page,
}) => {
  await page.goto("/");

  const notice = page.getByRole("link", { name: "Integritetspolicy" });
  await expect(notice).toBeVisible();

  await notice.click();

  // The fill-in page the instance ships with: the headings a privacy notice has
  // to answer, and no canned text under them.
  await expect(
    page.getByRole("heading", { name: "Integritetspolicy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Vem som är personuppgiftsansvarig" }),
  ).toBeVisible();

  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await page.context().cookies()).toEqual([]);
});
