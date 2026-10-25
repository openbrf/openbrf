import type { Locator, Page } from "@playwright/test";

import * as api from "../src/api";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  goToDestination,
  offeredDestinations,
  primaryNavigation,
} from "../src/navigation";
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
 * lets it go again, and that the property manager's band is exactly three
 * links.
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

/**
 * The administrator's whole offer, in band order. They hold every capability
 * the board does and the member's two besides, so the house's pages and the
 * board's pages are both here, each under its own section.
 */
const BOARD_DESTINATIONS = [
  "Att hantera",
  "Hantera ärenden",
  "Hantera motioner",
  "Pröva ansökningar",
  "Hantera beställningar",
  "Styrelsens post",
  "Granska anmälda inlägg",
  "Adressbok",
  "Alla lägenheters pärmar",
  "Import",
  "Skriv nyheter",
  "Webbplatsen",
  "Hantera evenemang",
  "Hantera arkivet",
  "Hantera bokningar",
  "Stämmor",
  "Avgifter",
  "Debiteringar",
  "Dataskydd",
  "Föreningens inställningar",
  "Tillägg",
  "Licenser",
  "Anslutna appar",
];
const EVERY_DESTINATION = [
  "Översikt",
  "Nyheter",
  "Evenemang",
  "Flöde",
  "Dokument",
  "Motioner",
  "Ärenden",
  "Bokningar",
  "Nycklar",
  "Lägenhetspärm",
  "Andrahand",
  ...BOARD_DESTINATIONS,
  "Inställningar",
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
  // overview's sign alone. The settings are the administrator's own account and
  // nothing else, so their sign is that page's own link, at the band's end.
  await expect(band.getByRole("button")).toHaveText([
    /^Föreningen\s*\d*$/,
    "Huset",
    "Styrelsen",
  ]);
  await expect(
    band.getByRole("link", { name: "Inställningar", exact: true }),
  ).toBeVisible();
  expect(await offeredDestinations(page)).toEqual(EVERY_DESTINATION);
  expect(await headerFits(page)).toBe(true);

  // The narrowest window the band is shown at.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(band.getByRole("button")).toHaveCount(3);
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
  await expect(panel.getByRole("link")).toHaveCount(BOARD_DESTINATIONS.length);

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
  // the reader now is.
  const association = primaryNavigation(page).getByRole("button", {
    // With the feed's unread count after it, when there is one.
    name: /^Föreningen\s*\d*$/,
  });
  await association.click();
  const associationPanel = await controlledBy(page, association);
  const links = associationPanel.getByRole("link");
  await expect(links.nth(5)).toHaveText("Motioner");
  await links.nth(5).click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/motions")}`);
  await expect(page.getByRole("link", { name: "Motioner" })).toHaveCount(0);
  await expect(association).toHaveAttribute("aria-current", "true");
  await expect(association).toHaveAttribute("aria-expanded", "false");
});

/** The association's settings' own navigation between their sections. */
function settingsSections(page: Page): Locator {
  return page.getByRole("navigation", {
    name: "Delar av inställningarna",
    exact: true,
  });
}

test("the settings are the account's own, and the association's are a board page", async ({
  page,
  clientAddress,
}) => {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  // The band's settings are the administrator's own account, one page with no
  // sections and no sign.
  await primaryNavigation(page)
    .getByRole("link", { name: "Inställningar", exact: true })
    .click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/settings")}`);
  await expect(
    page.getByRole("heading", { name: "Inställningar", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Din profil", level: 2 }),
  ).toBeVisible();
  await expect(settingsSections(page)).toHaveCount(0);
  // Exact: the export's paragraph names the board ("styrelsen tar fram ...").
  await expect(
    page.getByRole("main").getByText("Styrelsen", { exact: true }),
  ).toHaveCount(0);

  // The association's are the board's page, reached from the board's section,
  // and open the first section in place, so going back does not return to a
  // page that sends you on.
  await goToDestination(page, "Föreningens inställningar");
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/association")}`,
  );
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Styrelsen Föreningens inställningar",
    }),
  ).toBeVisible();
  const sections = settingsSections(page);
  await expect(sections.getByRole("link")).toHaveText([
    "Föreningen",
    "Utseende",
    "E-post och sms",
    "Kontoansökningar och kontakt",
    "Ärenden och bokningar",
    "Föreningsstämman",
    "Dataskydd och ekonomi",
    "Supportåtkomst",
  ]);
  // The page's heading carries the sign, and nothing else on it does.
  await expect(sections.getByRole("group")).toHaveCount(0);
  await expect(page.getByRole("region")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Din profil", level: 2 }),
  ).toHaveCount(0);

  // Each section is a page: its own address, and only its own panels.
  await sections.getByRole("link", { name: "E-post och sms" }).click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/communication")}`,
  );
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true, level: 2 }),
  ).toBeVisible();
  await expect(
    sections.getByRole("link", { name: "E-post och sms" }),
  ).toHaveAttribute("aria-current", "page");

  await sections.getByRole("link", { name: "Föreningsstämman" }).click();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/meetings")}`,
  );
  await expect(
    page.getByRole("heading", { name: "Sista dag för motioner", level: 2 }),
  ).toBeVisible();

  // The browser's own history moves between them.
  await page.goBack();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/communication")}`,
  );
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true, level: 2 }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/meetings")}`,
  );

  // A section that does not exist opens the first one instead.
  await page.goto(appPath("/board/settings/smtp"));
  await expect(page).toHaveURL(
    `${stack.baseUrl}${appPath("/board/settings/association")}`,
  );

  // Below the switch the sections are a row above the content, still links.
  await page.setViewportSize(PHONE);
  await expect(
    sections.getByRole("link", { name: "Föreningen", exact: true }),
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
    "Översikt",
    "Ärenden",
    "Bokningar",
  ]);
  const sheetButton = bar.getByRole("button", { name: /^Meny\s*\d*$/ });
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
    "Översikt",
    "Nyheter",
    "Evenemang",
    /^Flöde\d*$/,
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

  // Their settings are their own account and nothing else, and the
  // association's are the board's page, which says so and shows nothing.
  await page.goto(appPath("/settings"));
  await expect(
    page.getByRole("heading", { name: "Din profil", level: 2 }),
  ).toBeVisible();
  await expect(settingsSections(page)).toHaveCount(0);
  await page.goto(appPath("/board/settings/communication"));
  await expect(
    page.getByText(
      "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
    ),
  ).toBeVisible();
  await expect(settingsSections(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true }),
  ).toHaveCount(0);
});

test("the property manager's band is three links", async ({
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
  await page.goto(appPath("/board/issues"));

  /*
   * Decision 11 in the band's own shape: the overview everybody lands on, the
   * one board page they work - the issue queue, standing as its own sign - and
   * the account's own settings, each a sign that is a link, and no section to
   * open at all - so nothing behind a closed sign could hold the address book.
   */
  const band = primaryNavigation(page);
  await expect(band.getByRole("link")).toHaveText([
    "Översikt",
    "Hantera ärenden",
    "Inställningar",
  ]);
  await expect(band.getByRole("button")).toHaveCount(0);
});
