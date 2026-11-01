import type { Locator, Page } from "@playwright/test";

import * as api from "../src/api";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  accountButton,
  goToDestination,
  offeredDestinations,
  openAccountPanel,
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
 * lets it go again, that the person's own things are under their name at
 * every width, and that the property manager's band is exactly two links.
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

test("the board's band holds three sections and the account panel, and fits", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureRegisterFixture(request);
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  const band = primaryNavigation(page);
  // Waits for the viewer: until the capabilities arrive the band carries the
  // overview's sign alone. The administrator's own settings are not in the
  // navigation: they are under the administrator's name at the band's end.
  await expect(band.getByRole("button")).toHaveText([
    /^Föreningen\s*\d*$/,
    "Huset",
    "Styrelsen",
  ]);
  await expect(accountButton(page)).toHaveText(
    `${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`,
  );
  expect(await offeredDestinations(page)).toEqual(EVERY_DESTINATION);
  expect(await headerFits(page)).toBe(true);

  // The narrowest window the band is shown at.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(band.getByRole("button")).toHaveCount(3);
  expect(await headerFits(page)).toBe(true);

  // One pixel less, and the bar takes over from the band. The account panel
  // stays in the band, down to a phone's width.
  await page.setViewportSize({ width: 1023, height: 768 });
  await expect(page.getByRole("banner").locator("nav")).toBeHidden();
  await expect(page.getByRole("button", { name: "Meny" })).toBeVisible();
  for (const viewport of [{ width: 1023, height: 768 }, PHONE]) {
    await page.setViewportSize(viewport);
    await expect(accountButton(page)).toBeVisible();
    expect(await headerFits(page)).toBe(true);
  }
});

/**
 * A mark as wide as the band allows: 144 by 36, the largest box the dark
 * variant is contained in. The proportions are the association's own, so the
 * band has to hold the widest mark a board can upload.
 */
const WIDE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="36" viewBox="0 0 144 36"><rect width="144" height="36" fill="#c8a24a"/></svg>`;
const WIDE_LOGO_PATH = "/api/media/e2e-wide-logo-for-the-band";

/** What the band holds, as boxes on the page: the logo, the cooperative, the person. */
async function bandBoxes(page: Page): Promise<Record<string, DOMRect>> {
  return page.getByRole("banner").evaluate((header) => {
    const box = (element: Element | null): DOMRect => {
      if (element === null) {
        throw new Error("the band is missing a part of its contents");
      }
      return element.getBoundingClientRect();
    };
    // The last disclosure in the band is the person's; the navigation's signs,
    // hidden on a phone, come before it.
    const trigger = Array.from(
      header.querySelectorAll("button[aria-expanded]"),
    ).at(-1);
    const identity = header.firstElementChild;
    const person = trigger?.firstElementChild ?? null;
    return {
      header: box(header),
      logo: box(identity?.querySelector("img") ?? null),
      cooperative: box(identity?.querySelector("span") ?? null),
      name: box(person?.firstElementChild ?? null),
      role: box(person?.lastElementChild ?? null),
      chevron: box(trigger?.lastElementChild ?? null),
    };
  });
}

/** Whether two boxes share any area. Boxes that only touch do not. */
function overlap(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5
  );
}

test("on a small phone the band keeps a wide mark, the cooperative and the supporter apart", async ({
  page,
  clientAddress,
}) => {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  /*
   * The viewer as a support session reads it, with a mark in the dark variant
   * and a supporter whose name is long. Answered here rather than provisioned:
   * the layout is the subject, not the data, and a support session or an
   * uploaded mark would be state every other spec shared.
   */
  await page.route(`**${WIDE_LOGO_PATH}`, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: WIDE_LOGO }),
  );
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const viewer = (await response.json()) as {
      housingCooperative: {
        logoUrl: string | null;
        logoDarkUrl: string | null;
      };
    };
    await route.fulfill({
      response,
      json: {
        ...viewer,
        housingCooperative: {
          ...viewer.housingCooperative,
          logoUrl: null,
          logoDarkUrl: WIDE_LOGO_PATH,
        },
        support: {
          supporter: "Maximiliana Wilhelmina Lindgren-Söderström",
          endsAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });
  });

  // 320px is the narrowest phone; 360px is the commonest narrow one.
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(appPath("/"));
    await expect(accountButton(page)).toContainText("Support");
    await expect(page.getByRole("banner").locator("img")).toBeVisible();
    // The mark has been drawn: a placeholder for an image that has not
    // arrived would be measured as nothing.
    await expect
      .poll(() =>
        page
          .getByRole("banner")
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);

    const boxes = await bandBoxes(page);
    const parts = ["logo", "cooperative", "name", "role", "chevron"] as const;
    for (const part of parts) {
      const box = boxes[part];
      expect(
        box?.width,
        `${part} has a width at ${String(width)}px`,
      ).toBeGreaterThan(0);
      // Inside the band, not past its edge.
      expect(
        box?.left,
        `${part} starts inside the band`,
      ).toBeGreaterThanOrEqual(0);
      expect(box?.right, `${part} ends inside the band`).toBeLessThanOrEqual(
        width,
      );
    }
    for (const [index, first] of parts.entries()) {
      for (const second of parts.slice(index + 1)) {
        const a = boxes[first];
        const b = boxes[second];
        if (a !== undefined && b !== undefined) {
          expect(
            overlap(a, b),
            `${first} and ${second} do not overlap at ${String(width)}px`,
          ).toBe(false);
        }
      }
    }
    expect(await headerFits(page)).toBe(true);
  }
});

test("the account panel opens from the keyboard, closes, and hands focus back", async ({
  page,
  clientAddress,
}) => {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);

  const trigger = accountButton(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = await controlledBy(page, trigger);
  // Their settings first and signing out last, whatever is offered between.
  await expect(panel.getByRole("listitem").first()).toHaveText(
    "Dina inställningar",
  );
  await expect(panel.getByRole("listitem").last()).toHaveText("Logga ut");

  // Tab walks into it in order, and Escape closes it back onto its trigger.
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("link", { name: "Dina inställningar", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Space opens it as well, and a press anywhere else closes it.
  await page.keyboard.press(" ");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("main").click({ position: { x: 8, y: 8 } });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
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

  // The settings under the administrator's name are their own account, one
  // page with no sections and no sign; the panel closes behind the choice and
  // says that this is where the reader is.
  await (
    await openAccountPanel(page)
  )
    .getByRole("link", { name: "Dina inställningar", exact: true })
    .click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/settings")}`);
  await expect(
    page.getByRole("heading", { name: "Dina inställningar", level: 1 }),
  ).toBeVisible();
  await expect(accountButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(accountButton(page)).toHaveAttribute("aria-current", "true");
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

  // Their settings are under their name in the band, on the phone too, and
  // are their own account and nothing else; the association's are the
  // board's page, which says so and shows nothing.
  await (
    await openAccountPanel(page)
  )
    .getByRole("link", { name: "Dina inställningar", exact: true })
    .click();
  await expect(page).toHaveURL(`${stack.baseUrl}${appPath("/settings")}`);
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
  await page.goto(appPath("/board/issues"));

  /*
   * Decision 11 in the band's own shape: the overview everybody lands on, the
   * one board page they work - the issue queue, standing as its own sign -
   * each a sign that is a link, and no section to open at all - so nothing
   * behind a closed sign could hold the address book.
   */
  const band = primaryNavigation(page);
  await expect(band.getByRole("link")).toHaveText([
    "Översikt",
    "Hantera ärenden",
  ]);
  await expect(band.getByRole("button")).toHaveCount(0);
});
