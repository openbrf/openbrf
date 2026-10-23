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
