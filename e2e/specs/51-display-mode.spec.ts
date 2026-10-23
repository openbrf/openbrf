import {
  FULLEST_SLIDES,
  LAYOUT_NOW,
  LAYOUT_SECONDS,
  layoutDocument,
  measureSlide,
} from "../src/display-layout";
import { expect, stack, test, clientAddressFor } from "../src/fixtures";
import { createNews, publishNews } from "../src/news";
import { uniqueSurname } from "../src/identity";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The display mode for screens (ADR 0050), on a deployed instance.
 *
 * The board marks a news item "show on screens", issues a display link on the
 * display screen and opens it in a browser that has never signed in, as a
 * kiosk browser on the wall would. The page takes the token out of the
 * address, keeps it, and shows the rotation from the core's display route.
 * Revoking the link on the devices screen ends it: the next time the page
 * asks, it says the display link is no longer valid and forgets the token.
 *
 * Whatever a document holds, a screen shows all of it: the fullest slide the
 * contract allows, on a landscape and on a portrait screen, has nothing cut
 * off, a page of its list or of its text at a time.
 */

test("a display link issued by the board shows the marked news on a screen until it is revoked", async ({
  browser,
  clientAddress,
  api: request,
}) => {
  await ensureInstance(request);

  const title = uniqueSurname("Skärmnytt");
  const unmarked = uniqueSurname("Bara webben");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const marked = await createNews(request, {
    slug,
    title,
    paragraphs: ["Tvättstugan är stängd på fredag."],
    onScreens: true,
  });
  await publishNews(request, marked.id, { published: true });
  const other = await createNews(request, {
    slug: `${slug}-webb`,
    title: unmarked,
    paragraphs: ["Bara för webbplatsen."],
  });
  await publishNews(request, other.id, { published: true });

  const label = uniqueSurname("Port A");
  const board = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "board"),
    },
  });
  // A browser that has never signed in: the screen on the wall.
  const screen = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "screen"),
    },
  });

  try {
    const page = await board.newPage();
    await page.goto(appPath("/sign-in"));
    await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
    await page
      .getByLabel("Lösenord", { exact: true })
      .fill(ADMINISTRATOR.password);
    await page.getByRole("button", { name: "Logga in", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Översikt" }),
    ).toBeVisible();

    // Reached from the website's own screen, beside the devices screen.
    await page.goto(appPath("/admin/site"));
    await page.getByRole("link", { name: "Visningsläge", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Visningsläge" }),
    ).toBeVisible();

    await page.getByLabel("Var skärmen sitter").fill(label);
    await page
      .getByLabel("Ledigt och bokat för bokningsbara resurser")
      .uncheck();
    await page.getByRole("button", { name: "Utfärda länken" }).click();

    const linkField = page.getByRole("textbox", { name: /^Visningslänk/ });
    await expect(linkField).toBeVisible();
    await expect(
      page.getByRole("img", { name: "QR-kod för visningslänken" }),
    ).toBeVisible();
    const link = await linkField.inputValue();
    expect(link).toMatch(
      /\/app\/display\?sources=news,events,meeting#obrf_dt_/,
    );

    const wall = await screen.newPage();
    const contentRequests: { cookie?: string; authorization?: string }[] = [];
    wall.on("request", (sent) => {
      if (sent.url().includes("/api/display/content")) {
        const headers = sent.headers();
        contentRequests.push({
          cookie: headers.cookie,
          authorization: headers.authorization,
        });
      }
    });
    await wall.goto(link);

    await expect(wall.getByText(title, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(wall.getByText(unmarked, { exact: true })).toHaveCount(0);
    // The token is out of the address, and kept for the next visit.
    expect(new URL(wall.url()).hash).toBe("");
    expect(
      await wall.evaluate(() =>
        window.localStorage.getItem("openbrf.display.token"),
      ),
    ).toMatch(/^obrf_dt_/);
    expect(contentRequests.length).toBeGreaterThan(0);
    for (const sent of contentRequests) {
      expect(sent.authorization).toMatch(/^Bearer obrf_dt_/);
      expect(sent.cookie).toBeUndefined();
    }

    // Listed on the devices screen under the display mode, and revoked there.
    await page.goto(appPath("/admin/site/devices"));
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Visningsläge" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `Återkalla token för ${label}` })
      .click();
    await page
      .getByRole("button", { name: "Återkalla token", exact: true })
      .click();
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);

    await wall.reload();
    await expect(
      wall.getByText("Visningslänken gäller inte längre", { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(wall.getByText(title, { exact: true })).toHaveCount(0);
    expect(
      await wall.evaluate(() =>
        window.localStorage.getItem("openbrf.display.token"),
      ),
    ).toBeNull();
  } finally {
    await board.close();
    await screen.close();
  }
});

test("a screen shows every item and every word of the fullest slides, a page at a time", async ({
  browser,
  clientAddress,
}) => {
  test.setTimeout(240_000);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ]) {
    for (const { name, slide, texts = [] } of FULLEST_SLIDES) {
      const where = `${name}, ${viewport.width}×${viewport.height}`;
      // A context of its own, so no content kept from another slide is shown.
      const screen = await browser.newContext({
        baseURL: stack.baseUrl,
        locale: "sv-SE",
        viewport,
        extraHTTPHeaders: {
          "x-forwarded-for": clientAddressFor(clientAddress, "layout"),
        },
      });
      try {
        const wall = await screen.newPage();
        await wall.clock.install({ time: new Date(LAYOUT_NOW) });
        await wall.route(
          (url) => url.pathname === "/api/display/content",
          (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(layoutDocument(slide)),
            }),
        );
        await wall.goto(appPath("/display#obrf_dt_layout"));
        // What is measured is the renderer's own boxes, which have no role or
        // label: its classes are the published stylesheet's, not test ids.
        await expect(wall.locator(".obrf-display-slide")).toBeVisible({
          timeout: 30_000,
        });
        await wall.evaluate(() => document.fonts.ready.then(() => undefined));

        const seen = new Set<number>();
        const pages: string[] = [];
        let items = 0;
        for (let page = 1; page <= 40; page += 1) {
          const measure = await wall.evaluate(measureSlide);
          expect(measure, where).not.toBeNull();
          if (measure === null) {
            return;
          }
          // Back on the first page: every page has been seen.
          if (
            page > 1 &&
            measure.text === pages[0] &&
            (measure.items === 0 || measure.shown[0] === 0)
          ) {
            break;
          }
          expect(measure.outside, `${where}, page ${page}`).toEqual([]);
          expect(measure.clipped, `${where}, page ${page}`).toEqual([]);
          expect(measure.scale, `${where}, page ${page}`).toBeGreaterThan(0.59);
          items = measure.items;
          for (const index of measure.shown) {
            seen.add(index);
          }
          pages.push(measure.text);
          await wall.clock.runFor(LAYOUT_SECONDS * 1000);
        }
        expect(seen.size, where).toBe(items);
        // A text broken across pages reads whole from one page to the next.
        const read = pages.join(" ");
        for (const text of texts) {
          expect(read, where).toContain(text.replace(/\s+/g, " "));
        }
      } finally {
        await screen.close();
      }
    }
  }
});
