import type { Locator, Page } from "@playwright/test";

import * as api from "../src/api";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import { offeredDestinations, primaryNavigation } from "../src/navigation";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The navigation, end to end.
 *
 * The destinations are grouped into four sections. On a desk the band carries
 * one sign per section the account has anything in, and a sign opens its
 * destinations under it; below 1024px a bar carries three destinations chosen
 * for the account and a menu button whose sheet holds every section. Nothing
 * moves with the window's width except that one switch.
 *
 * What only a browser can show: that the board's band fits at the widths it is
 * shown at, that a section opens, closes and hands focus back the way the
 * disclosure pattern says, that the sheet makes the room behind it inert and
 * lets it go again, and that the property manager's band is exactly two links.
 *
 * This is the one spec that changes the window. Every other spec reads the
 * navigation at the suite's 1280px through the helpers in src/navigation.ts;
 * here the switch itself is the subject, so the widths either side of it are
 * set by hand.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the invitation spec sets on the shared fixture's accounts.
 * Nothing in the suite can change a password, so a second one here would only
 * fail to sign in.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * The shared fixture's resident without the tenant-ownership: he lives in
 * Storgatan 12/1001 and holds nothing but that residency.
 */
const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/*
 * The external property manager. Written by this spec and never removed again -
 * nothing in the suite can delete a person - so the identity is this run's, and
 * so is the password `ensureAccountFor` sets the first time it is asked.
 */
const MANAGER = {
  firstName: "Tove",
  lastName: uniqueSurname("Sundin"),
  email: uniqueEmail("tove"),
  password: "sophus-cykelrum-trapphus-2026",
} as const;

/** The Mobil artboard's size, below the switch. */
const PHONE = { width: 390, height: 844 } as const;

/** The board's whole offer, in band order. */
const EVERY_DESTINATION = [
  "Adressbok",
  "Nyheter",
  "Evenemang",
  "Chatt",
  "Dokument",
  "Stämmor",
  "Motioner",
  "Ärenden",
  "Bokningar",
  "Nycklar",
  "Lägenhetspärm",
  "Andrahand",
  "Styrelsens post",
  "Skriv nyheter",
  "Webbplatsen",
  "Avgifter",
  "Debiteringar",
  "Dataskydd",
  "Inställningar",
  "Tillägg",
  "Anslutna appar",
];

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * The wait belongs here rather than to the callers: clicking only starts the
 * sign-in, so a caller that navigates on the next line cancels the request in
 * flight and the route guard sends the browser back to the form.
 */
async function signInThroughTheScreen(
  page: Page,
  who: { email: string; password: string },
): Promise<void> {
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(who.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(who.password);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  // exact, because "Logga in" is a prefix of the passkey button's
  // "Logga in med en nyckel" and the accessible-name match is a substring one.
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${who.email} answered ${String(response.status())}`,
  ).toBe(true);

  await expect(page).not.toHaveURL(/\/sign-in$/);
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

/** The panel or sheet a sign or the menu button controls, while it is open. */
async function controlledBy(page: Page, trigger: Locator): Promise<Locator> {
  const id = await trigger.getAttribute("aria-controls");
  expect(id, "an open section names its panel").not.toBeNull();
  // An attribute selector: an id React generates is not a valid CSS id.
  return page.locator(`[id="${id ?? ""}"]`);
}

/** Whether the header holds its content without running off to the right. */
async function headerFits(page: Page): Promise<boolean> {
  return page
    .getByRole("banner")
    .evaluate((header) => header.scrollWidth <= header.clientWidth);
}

test("the board's band holds four sections and fits", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureRegisterFixture(request);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  const band = primaryNavigation(page);
  // Waits for the viewer: until the capabilities arrive the band carries the
  // settings sign alone, as a link.
  await expect(band.getByRole("button")).toHaveText([
    "Föreningen",
    "Huset",
    "Styrelsen",
    "Inställningar",
  ]);
  expect(await offeredDestinations(page)).toEqual(EVERY_DESTINATION);
  expect(await headerFits(page)).toBe(true);

  // The narrowest window the band is shown at.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(band.getByRole("button")).toHaveCount(4);
  expect(await headerFits(page)).toBe(true);

  // One pixel less, and the bar takes over from the band.
  await page.setViewportSize({ width: 1023, height: 768 });
  await expect(page.getByRole("banner").locator("nav")).toBeHidden();
  await expect(page.getByRole("button", { name: "Meny" })).toBeVisible();
});

test("a section opens, closes, and hands focus back", async ({
  page,
  clientAddress,
}) => {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  const sign = primaryNavigation(page).getByRole("button", {
    name: "Styrelsen",
    exact: true,
  });

  await sign.click();
  await expect(sign).toHaveAttribute("aria-expanded", "true");
  const panel = await controlledBy(page, sign);
  await expect(panel.getByRole("link")).toHaveCount(6);

  // Escape closes it, and focus goes back to the sign rather than the body.
  await page.keyboard.press("Escape");
  await expect(sign).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await expect(sign).toBeFocused();

  // A press anywhere else on the page closes it too.
  await sign.click();
  await expect(sign).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("main").click({ position: { x: 8, y: 8 } });
  await expect(sign).toHaveAttribute("aria-expanded", "false");

  // And choosing a destination goes there, with the section marked as where
  // the reader now is. The general meeting is in the association's section,
  // with the motions set in under it.
  const association = primaryNavigation(page).getByRole("button", {
    name: "Föreningen",
    exact: true,
  });
  await association.click();
  const associationPanel = await controlledBy(page, association);
  const links = associationPanel.getByRole("link");
  await expect(links.nth(5)).toHaveText("Stämmor");
  await expect(links.nth(6)).toHaveText("Motioner");
  await links.nth(5).click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/meetings")}`);
  await expect(page.getByRole("link", { name: "Stämmor" })).toHaveCount(0);
  await expect(association).toHaveAttribute("aria-current", "true");
  await expect(association).toHaveAttribute("aria-expanded", "false");
});

/** The settings screen's own navigation between its sections. */
function settingsSections(page: Page): Locator {
  return page.getByRole("navigation", {
    name: "Delar av inställningarna",
    exact: true,
  });
}

test("the settings open on a section of their own, and the back button walks them", async ({
  page,
  clientAddress,
}) => {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  // The screen itself has no address of its own: it opens the first section,
  // in place, so going back does not return to a page that sends you on.
  await page.goto(appPath("/settings"));
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/account")}`,
  );
  const sections = settingsSections(page);
  await expect(sections.getByRole("link")).toHaveText([
    "Mitt konto",
    "Föreningen",
    "Utseende",
    "E-post och sms",
    "Kontoansökningar och kontakt",
    "Ärenden och bokningar",
    "Föreningsstämman",
    "Dataskydd och ekonomi",
  ]);

  // The account is the administrator's own and stands first and bare; the
  // association's sections follow under the board's sign, and their panels sit
  // in a zone carrying it.
  const boardGroup = sections.getByRole("group", {
    name: "Styrelsen Föreningens administration",
  });
  await expect(boardGroup.getByRole("link")).toHaveCount(7);
  await expect(
    boardGroup.getByRole("link", { name: "Mitt konto" }),
  ).toHaveCount(0);
  await expect(page.getByRole("region")).toHaveCount(0);
  await expect(
    sections.getByRole("link", { name: "Mitt konto", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Din profil", level: 2 }),
  ).toBeVisible();

  // Each section is a page: its own address, and only its own panels.
  await sections.getByRole("link", { name: "E-post och sms" }).click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/communication")}`,
  );
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Styrelsen E-post och sms" })
      .getByRole("heading", { name: "E-post", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Din profil", level: 2 }),
  ).toHaveCount(0);
  await expect(
    sections.getByRole("link", { name: "E-post och sms" }),
  ).toHaveAttribute("aria-current", "page");

  await sections.getByRole("link", { name: "Föreningsstämman" }).click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/meetings")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Sista dag för motioner", level: 2 }),
  ).toBeVisible();

  // The browser's own history moves between them.
  await page.goBack();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/communication")}`,
  );
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true, level: 2 }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/meetings")}`,
  );

  // A section that does not exist opens the first one instead.
  await page.goto(appPath("/settings/smtp"));
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/account")}`,
  );

  // Below the switch the sections are a row above the content, still links.
  await page.setViewportSize(PHONE);
  await expect(
    sections.getByRole("link", { name: "Mitt konto", exact: true }),
  ).toBeVisible();
});

test("a resident's phone carries three destinations and a menu of the rest", async ({
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
  await page.setViewportSize(PHONE);
  await page.goto(appPath("/news"));

  // Below the switch the navigation a person can see is the bar.
  const bar = primaryNavigation(page);
  await expect(bar.getByRole("link")).toHaveText([
    "Nyheter",
    "Ärenden",
    "Bokningar",
  ]);
  const sheetButton = bar.getByRole("button", { name: "Meny", exact: true });
  await expect(sheetButton).toHaveAttribute("aria-expanded", "false");

  await sheetButton.click();
  await expect(sheetButton).toHaveAttribute("aria-expanded", "true");
  const sheet = await controlledBy(page, sheetButton);
  await expect(sheet.getByRole("heading", { level: 2 })).toHaveText([
    "Föreningen",
    "Huset",
    "Inställningar",
  ]);
  await expect(sheet.getByRole("link")).toHaveText([
    "Adressbok",
    "Nyheter",
    "Evenemang",
    "Chatt",
    "Dokument",
    "Ärenden",
    "Bokningar",
    "Nycklar",
    "Lägenhetspärm",
    "Inställningar",
  ]);
  // The room behind the sheet is out of reach while it covers it.
  await expect(page.locator("main")).toHaveAttribute("inert");

  await page.keyboard.press("Escape");
  await expect(sheetButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("main")).not.toHaveAttribute("inert");
  await expect(sheetButton).toBeFocused();

  await sheetButton.click();
  await (
    await controlledBy(page, sheetButton)
  )
    .getByRole("link", { name: "Lägenhetspärm", exact: true })
    .click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/apartment-binder")}`,
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Huset" }),
  ).toHaveCount(0);
  // The binder is not one of the bar's three, so the menu button says this is where
  // the reader is.
  await expect(sheetButton).toHaveAttribute("aria-current", "true");
  await expect(page.locator("main")).not.toHaveAttribute("inert");

  // Their settings are their own account and nothing else, and an address
  // for a section about the instance opens that instead.
  await page.goto(appPath("/settings/communication"));
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/settings/account")}`,
  );
  await expect(settingsSections(page).getByRole("link")).toHaveText([
    "Mitt konto",
  ]);
});

test("the property manager's band is two links", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureRegisterFixture(request);
  const name = `${MANAGER.firstName} ${MANAGER.lastName}`;
  const personId =
    (await api.findPersonIdByName(request, stack.baseUrl, name)) ??
    (await api.createPerson(request, stack.baseUrl, {
      firstName: MANAGER.firstName,
      lastName: MANAGER.lastName,
      email: MANAGER.email,
    }));
  await grantPropertyManager(personId);
  await ensureAccountFor(request, {
    personId,
    email: MANAGER.email,
    password: MANAGER.password,
    clientAddress: clientAddressFor(clientAddress, "manager"),
  });

  await browseAs(page, clientAddress, "manager");
  await signInThroughTheScreen(page, MANAGER);
  await page.goto(appPath("/issues"));

  /*
   * Decision 11 in the band's own shape: one destination in the building and
   * the account's own settings, each a sign that is a link, and no section to
   * open at all - so nothing behind a closed sign could hold the address book.
   */
  const band = primaryNavigation(page);
  await expect(band.getByRole("link")).toHaveText(["Ärenden", "Inställningar"]);
  await expect(band.getByRole("button")).toHaveCount(0);
});
