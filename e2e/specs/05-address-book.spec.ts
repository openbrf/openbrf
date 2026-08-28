import type { Page } from "@playwright/test";

import { expect, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureRegisterFixture } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Exit criterion 5.
 *
 * The address book renders as the design system describes it: house tabs per
 * address, rows grouped by floor the way a physical porttavla is, the filter
 * tabs on the board, the signs, the colour-as-law legend and the register
 * stamp. In light, in dark, and following the operating system.
 *
 * The assertions are about structure and mechanism rather than pixels. The
 * repository holds no pinned snapshot of the design canvas to compare against
 * (docs/design-refs/ does not exist), so this spec checks what a snapshot would
 * be checking for: that every named part of the board is on the screen, in the
 * language the interface actually renders.
 */

test.describe.configure({ mode: "serial" });

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/** The resolved value of a token, as the browser computes it. */
async function tokenValue(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    token,
  );
}

test("the board renders every part the design system names", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signInAsAdmin(page);

  // House tabs. Shown only because the cooperative has more than one address.
  const houseTabs = page.getByRole("navigation", { name: "Adress" });
  await expect(
    houseTabs.getByRole("button", { name: "Alla adresser" }),
  ).toBeVisible();
  await expect(
    houseTabs.getByRole("button", { name: "Storgatan 12" }),
  ).toBeVisible();
  await expect(
    houseTabs.getByRole("button", { name: "Storgatan 14" }),
  ).toBeVisible();

  // The filter strip sits on the board itself, each tab carrying its count.
  const filters = page.getByRole("navigation", { name: "Filtrera registret" });
  for (const label of [
    "Alla",
    "Medlemmar",
    "Boende",
    "Styrelse",
    "Utflyttade",
  ]) {
    await expect(
      filters.getByRole("button", { name: new RegExp(`^${label}`) }),
    ).toBeVisible();
  }

  // Column heads, on the shared monospace grid.
  for (const column of [
    "Lgh",
    "Namn",
    "Roll",
    "Kontakt",
    "Inflytt",
    "Utflytt",
  ]) {
    await expect(
      page.getByRole("columnheader", { name: column, exact: true }),
    ).toBeVisible();
  }

  // Floor groups, following Lantmateriet numbering: 10XX is the ground floor,
  // 11XX the one above it.
  // One group row per floor per address, so both addresses contribute a
  // ground floor to the board when no house tab is selected.
  await expect(page.getByText(/^Entreplan 10XX/).first()).toBeVisible();
  await expect(page.getByText(/^Plan 1 11XX/).first()).toBeVisible();

  // Role signs. Colour is never the only signal, so each one carries its word.
  await expect(
    page.getByRole("cell", { name: /Medlem/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /Boende/ }).first(),
  ).toBeVisible();

  // The legend and the register stamp close the board.
  await expect(page.getByText("Färg som lag")).toBeVisible();
  await expect(page.getByText("Förtroendeuppdrag")).toBeVisible();
  await expect(
    page.getByText(/^Adressbok - Alla adresser - \d{4}-\d{2}-\d{2}$/),
  ).toBeVisible();

  // A house tab narrows the board and re-stamps it with that address.
  await houseTabs.getByRole("button", { name: "Storgatan 14" }).click();
  await expect(
    page.getByText(/^Adressbok - Storgatan 14 - \d{4}-\d{2}-\d{2}$/),
  ).toBeVisible();
});

test("the register can be searched by name and by apartment number", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signInAsAdmin(page);

  const search = page.getByLabel("Sök i registret");
  await search.fill("Berg");
  await expect(
    page.getByRole("cell", { name: "Öppna Karl Berg" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Öppna Astrid Lindqvist" }),
  ).toHaveCount(0);

  await search.fill("1001");
  await expect(
    page.getByRole("cell", { name: "Öppna Astrid Lindqvist" }),
  ).toBeVisible();
});

test("light, dark and follow-the-system all reach the theme", async ({
  page,
  api: request,
}) => {
  await ensureRegisterFixture(request);
  await signInAsAdmin(page);

  const root = page.locator("html");

  // The default is to follow the system, and that state is the absence of an
  // attribute rather than a third value on it.
  await expect(root).not.toHaveAttribute("data-theme", /.*/);

  await page.getByText("Ljust", { exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  const light = await tokenValue(page, "--obrf-surface-page");

  await page.getByText("Mörkt", { exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  const dark = await tokenValue(page, "--obrf-surface-page");

  expect(light).not.toBe(dark);

  // Back to following the system, where prefers-color-scheme decides and the
  // chosen value has to match what the explicit choice produced.
  await page.getByText("System", { exact: true }).click();
  await expect(root).not.toHaveAttribute("data-theme", /.*/);

  await page.emulateMedia({ colorScheme: "dark" });
  expect(await tokenValue(page, "--obrf-surface-page")).toBe(dark);

  await page.emulateMedia({ colorScheme: "light" });
  expect(await tokenValue(page, "--obrf-surface-page")).toBe(light);
});
