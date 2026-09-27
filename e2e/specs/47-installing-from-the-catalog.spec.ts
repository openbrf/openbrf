import type { BrowserContext, Locator, Page } from "@playwright/test";

import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { cli, waitForRestart } from "../src/plugins";
import { ensureInstance } from "../src/provision";
import { appPath, appStartedAt } from "../src/stack";

/**
 * Criteria 10 and 11, the installing halves: a plugin and a theme installed
 * from a catalog through the admin screens of the production image.
 *
 * The catalog is the fixture index src/stack.ts builds before the stack starts
 * and the overlay mounts at /catalog, listing the fixture plugin and both
 * fixture themes as tarballs beside it. The instance reads it as an uncurated
 * file: index, so everything after the read is the path a curated instance
 * takes - the entry parsed, the tarball read, its digest checked before
 * anything is unpacked - and the suite never touches the network. What the
 * integration suites cannot show is the rest of the path, which only the
 * deployed artefact has: npm in the runtime image installing onto the data
 * volume, the process exiting and the supervisor starting it again, the built
 * client loading the plugin's federated view and its translations from the
 * volume, and the command-line tool run through the entrypoint against a
 * running server.
 *
 * One browser session throughout, signed in once. A session is a row in the
 * database, so it survives every restart here, and a spec that signed in
 * again after each one would spend the sign-in budget on something that is not
 * its subject.
 *
 * The fixture plugin declares the address connected apps sign in to, which
 * only one installed plugin may hold. The spec removes it again before the
 * theme half, so every spec after this one runs, like every spec before it,
 * against an instance with no plugin installed.
 */

/**
 * Serial, because each test starts from the instance the one before it left,
 * and a restart takes longer than the suite's default test timeout allows.
 */
test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });

/** Run-unique, so a rerun against a kept stack writes a heading of its own. */
const suffix = Date.now().toString(36);

const PLUGIN = {
  id: "occupancy",
  name: "Boende och lägenheter",
  package: "@openbrf/example-plugin 1.0.0",
} as const;

/** The index as the container reads it: stack.env names it, the overlay mounts it. */
const CATALOG_SOURCE = "file:///catalog/catalog.json";

const RESTART_NOTICE = "Programmet startas om för att läsa in ändringen.";
const NO_PLUGINS = "Inga tillägg är installerade.";

let context: BrowserContext;
let page: Page;

/** The card a heading of this name sits in, whichever screen carries it. */
function panel(heading: string): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: heading, exact: true, level: 2 }),
  });
}

/** The fixture plugin's row in the list of installed plugins. */
function installedPlugin(): Locator {
  return panel("Installerade tillägg")
    .getByRole("listitem")
    .filter({ hasText: PLUGIN.package });
}

/** One theme's card, in the installed list or in the catalog. */
function themeCard(panelHeading: string, themeName: string): Locator {
  return panel(panelHeading)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: themeName, exact: true }),
    });
}

/** The stylesheet an installed theme is applied through, or nothing. */
function themeStylesheet(): Locator {
  return page.locator("style#openbrf-theme-tokens");
}

/**
 * What that stylesheet declares, or nothing when none is applied.
 *
 * Read as the element's own text content: Playwright's text assertions leave
 * out what a style element holds, the way a reader never sees it.
 */
function themeDeclarations(): Promise<string> {
  return themeStylesheet().evaluateAll((elements) =>
    elements.map((element) => element.textContent).join(""),
  );
}

/** The example theme's trust accent in light mode, as its manifest states it. */
const EXAMPLE_ACCENT = /--obrf-accent-trust: #2f5d50;/i;

/** Which theme the instance renders for everybody, as the client reads it. */
async function activeThemeId(): Promise<string> {
  const response = await page.request.get(`${stack.baseUrl}/api/themes/active`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test.beforeAll(async ({ browser }, testInfo) => {
  context = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(testInfo.file, "administrator"),
    },
  });
  page = await context.newPage();
  // Signs the administrator in on this context's own cookie jar, which is the
  // browser's: the one sign-in the spec makes.
  await ensureInstance(page.request);
});

test.afterAll(async () => {
  await context.close();
});

test.describe("a plugin", () => {
  test("the catalog names the index it read and lists the plugin", async () => {
    await page.goto(appPath("/plugins"));

    await expect(panel("Installerade tillägg")).toContainText(NO_PLUGINS);

    const catalog = panel("Katalog");
    await expect(catalog).toContainText(CATALOG_SOURCE);
    const entry = catalog
      .getByRole("listitem")
      .filter({ hasText: PLUGIN.package });
    await expect(entry).toContainText(PLUGIN.name);
    await expect(entry).toContainText(
      "Visar antalet lägenheter, boende och medlemmar i föreningen.",
    );
  });

  test("the consent screen states the declaration, and the install restarts into the running plugin", async () => {
    await panel("Katalog")
      .getByRole("listitem")
      .filter({ hasText: PLUGIN.package })
      .getByRole("button", { name: "Installera", exact: true })
      .click();

    const consent = panel("Granska innan installation");
    await expect(consent).toContainText(
      `${PLUGIN.name} 1.0.0 är på väg att installeras.`,
    );

    // The one permission, as the sentence it grants rather than its code.
    await expect(consent.getByRole("listitem")).toContainText([
      "Läsa namn, lägenheter, vem som är boende och vem som är medlem, och inflyttnings- och utflyttningsdatum",
      // The three categories of personal data it will handle.
      "Namn",
      "Lägenhet och adress",
      "Inflyttnings- och utflyttningsdatum, och om personen är medlem",
      // The action, with what it does to the records and how far it may go.
      "summary - addressBook:read - Läser - Inga personuppgifter - I den här instansen, Anslutna appar",
      // And the address connected apps sign in to, which it would take.
      "Det här tillägget kommer att betjäna den adress som anslutna appar loggar in mot.",
      "Bara ett installerat tillägg i taget kan göra det.",
      "Adressen slutar svara på en vanlig inloggning i webbläsaren och nås bara av anslutna appar.",
    ]);
    await expect(
      consent.getByRole("heading", { name: "Inloggning för anslutna appar" }),
    ).toBeVisible();

    // Nothing can be confirmed before the declaration is acknowledged.
    const confirm = consent.getByRole("button", {
      name: "Installera",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await consent
      .getByRole("checkbox", {
        name: "Jag har läst vad tillägget får göra och vilka personuppgifter det kommer att hantera.",
      })
      .check();

    const before = appStartedAt();
    await confirm.click();

    await expect(page.getByText(RESTART_NOTICE)).toBeVisible();
    await waitForRestart(before);

    /*
     * Read again once the new process serves. The screen's own poll stops at
     * the first answer that reports no restart pending, and the process on its
     * way out gives that answer until its install job has handed over to the
     * restart, so what the screen holds at this point depends on how quickly
     * the job ran.
     */
    await page.reload();
    await expect(installedPlugin()).toContainText("Körs");
    await expect(page.getByText(RESTART_NOTICE)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Körs inte", exact: true }),
    ).toHaveCount(0);
  });

  test("the plugin's view renders its Swedish title and reads its own route", async () => {
    await page.goto(appPath(`/plugin/${PLUGIN.id}`));

    // The title key resolved in the plugin's own namespace, merged into the
    // client's from the plugin's locale files on the data volume.
    await expect(
      page.getByRole("heading", { name: PLUGIN.name, level: 1 }),
    ).toBeVisible();

    // The figures render only once the plugin's own API route has answered,
    // and their labels are the plugin's strings too.
    const view = page.getByRole("main");
    for (const label of ["Lägenheter", "Boende", "Medlemmar"]) {
      await expect(view.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(view).toContainText("Gruppering: Adress");
    await expect(
      page.getByRole("heading", { name: "Occupancy", level: 2 }),
    ).toBeVisible();
  });

  test("the settings form has four fields, and a saved heading reaches the view without a restart", async () => {
    const heading = `Beläggning ${suffix}`;

    await page.goto(appPath("/plugins"));
    await installedPlugin()
      .getByRole("button", { name: "Inställningar", exact: true })
      .click();

    const form = installedPlugin().locator("form");
    await expect(form.getByRole("textbox", { name: /^Rubrik/ })).toBeVisible();
    await expect(
      form.getByRole("checkbox", { name: "Visa antalet medlemmar" }),
    ).toBeVisible();
    await expect(
      form.getByRole("spinbutton", { name: "Högsta antal rader" }),
    ).toBeVisible();
    await expect(form.getByRole("combobox")).toHaveCount(1);
    await expect(form.locator("label")).toHaveCount(4);

    const before = appStartedAt();
    await form.getByRole("textbox", { name: /^Rubrik/ }).fill(heading);
    await form.getByRole("button", { name: "Spara", exact: true }).click();
    await expect(form).toContainText("Sparat");

    await page.goto(appPath(`/plugin/${PLUGIN.id}`));
    await expect(
      page.getByRole("heading", { name: heading, level: 2 }),
    ).toBeVisible();

    expect(appStartedAt()).toEqual(before);
  });

  test("the command line removes the plugin and installs it again", async () => {
    const beforeRemoval = appStartedAt();
    const removed = cli(["plugin", "remove", PLUGIN.id]);
    expect(removed.status, removed.output).toBe(0);
    expect(removed.output).toContain(`Removed "${PLUGIN.id}".`);

    await waitForRestart(beforeRemoval);
    await page.goto(appPath("/plugins"));
    await expect(panel("Installerade tillägg")).toContainText(NO_PLUGINS);

    const beforeInstall = appStartedAt();
    const added = cli(["plugin", "add", PLUGIN.id]);
    expect(added.status, added.output).toBe(0);
    // The declaration is printed before anything is written, in the words the
    // consent screen uses, because running the command is the consent.
    expect(added.output).toContain(
      "personal data Name; Apartment and address; Move-in and move-out dates, and whether the person is a member",
    );
    expect(added.output).toContain("Installed.");

    await waitForRestart(beforeInstall);
    await page.goto(appPath("/plugins"));
    await expect(installedPlugin()).toContainText("Körs");
  });

  test("removing it on the screen restarts into an instance without it", async () => {
    const row = installedPlugin();
    await row.getByRole("button", { name: "Ta bort", exact: true }).click();

    const before = appStartedAt();
    await row.getByRole("button", { name: "Ja, ta bort", exact: true }).click();

    await expect(page.getByText(RESTART_NOTICE)).toBeVisible();
    await waitForRestart(before);

    await expect(panel("Installerade tillägg")).toContainText(NO_PLUGINS);
    await expect(page.getByText(RESTART_NOTICE)).toHaveCount(0);

    // Gone from the client as well: the view is no longer offered.
    await page.goto(appPath(`/plugin/${PLUGIN.id}`));
    await expect(page.getByRole("main")).toContainText(
      `Det finns ingen vy som heter ${PLUGIN.id} på den här instansen`,
    );
  });
});

test.describe("a theme", () => {
  test("the catalog lists the example theme by its Swedish name", async () => {
    await page.goto(appPath("/admin/themes"));

    const entry = themeCard("Katalog", "Exempeltema");
    await expect(entry).toContainText("1.0.0");
    await expect(entry).toContainText(
      "Ärver standardtemat, gör förtroendeaccenten grön och har med sig ett eget typsnitt.",
    );
  });

  test("installing it needs no restart", async () => {
    const before = appStartedAt();

    await themeCard("Katalog", "Exempeltema")
      .getByRole("button", { name: "Installera", exact: true })
      .click();

    await expect(page.getByText("example-theme installerades.")).toBeVisible();
    const installed = themeCard("Installerade", "Example");
    await expect(installed).toContainText("porttavlan");
    await expect(installed).toContainText("Spline Sans Mono (OFL-1.1)");

    expect(appStartedAt()).toEqual(before);
  });

  test("a preview is this browser's until the theme is activated", async () => {
    const installed = themeCard("Installerade", "Example");

    await installed
      .getByRole("button", { name: "Förhandsgranska", exact: true })
      .click();
    await expect(
      page.getByText("Du förhandsgranskar Example.", { exact: false }),
    ).toBeVisible();
    await expect.poll(themeDeclarations).toMatch(EXAMPLE_ACCENT);
    // The page renders it; the instance still renders the theme it had.
    expect(await activeThemeId()).toBe("porttavlan");

    await page
      .getByRole("button", { name: "Aktivera det här temat", exact: true })
      .click();
    await expect(installed).toContainText("Aktivt");
    await expect(page.getByText("Du förhandsgranskar Example.")).toHaveCount(0);
    expect(await activeThemeId()).toBe("example-theme");

    // Active on the instance rather than in this page: a fresh load renders it.
    await page.reload();
    await expect(themeCard("Installerade", "Example")).toContainText("Aktivt");
    await expect.poll(themeDeclarations).toMatch(EXAMPLE_ACCENT);
  });

  test("the built-in theme is activated again", async () => {
    await themeCard("Installerade", "Porttavlan")
      .getByRole("button", { name: "Aktivera", exact: true })
      .click();

    await expect(themeCard("Installerade", "Porttavlan")).toContainText(
      "Aktivt",
    );
    await expect(themeStylesheet()).toHaveCount(0);

    // Taken back, so a rerun against a kept stack finds it installable.
    await themeCard("Installerade", "Example")
      .getByRole("button", { name: "Ta bort", exact: true })
      .click();
    await expect(themeCard("Installerade", "Example")).toHaveCount(0);
  });

  test("a theme that renders the register illegible is refused", async () => {
    await themeCard("Katalog", "Oläsligt tema")
      .getByRole("button", { name: "Installera", exact: true })
      .click();

    const refusal = page.getByText("Temat avvisades:").locator("..");
    await expect(refusal).toContainText(
      /text-register mot surface-register [\d.]+:1 och måste nå 4\.5:1/,
    );
    await expect(refusal).toContainText(
      "Det här färgparet bär det lagstadgade registret",
    );
    await expect(themeCard("Installerade", "Illegible")).toHaveCount(0);
  });
});
