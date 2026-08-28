import { mkdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { BrowserContext, Locator, Page } from "@playwright/test";

import { expect, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { repositoryRoot, stack } from "../src/stack";
import {
  SCREENS,
  type Action,
  type Actor,
  type Screen,
  type Target,
} from "./screens";

/**
 * Writes the screenshots a pull request description needs.
 *
 * CONTRIBUTING.md requires light and dark images for UI work. This produces
 * them from the production stack rather than a dev server, so what is attached
 * to a pull request is the screen an association gets.
 *
 * The screens are declared in screens.ts. Everything here is mechanism: how an
 * entry is reached, how a theme is chosen, when a page has settled, and what
 * must never be in the picture.
 */

/** Written next to the repository, and git-ignored. */
const OUTPUT_DIR = resolve(repositoryRoot, "screenshots");

/**
 * The browser, held still.
 *
 * The width is above the client's `xl` breakpoint (1280px), so the person and
 * apartment views are photographed beside the board rather than replacing it,
 * which is how they appear on a desk. The density makes the text readable when
 * a reviewer opens the picture at full size. `reducedMotion` is a real viewer
 * setting and it stops transitions before they start, which is half of why a
 * rerun differs only where the interface differs.
 */
const BROWSER = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
} as const;

/**
 * Both themes, from the viewer's operating system.
 *
 * The client defaults to following the system and subscribes to the media
 * query while it does, so switching the emulated preference re-themes the page
 * that is already open. That matters here: a wizard step is React state, and
 * anything that reloaded to change theme would lose the step. It is also the
 * honest route - this is a viewer whose computer is set to dark, not a
 * stylesheet being overridden from outside.
 */
const THEMES = ["light", "dark"] as const;

/**
 * The resident whose session the resident-facing board is captured from.
 *
 * Made through the invitation flow, like any other account. The password is a
 * fixture value on a throwaway instance that is destroyed when the run ends.
 */
const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: "granngarden-kastanj-2026",
} as const;

/**
 * A client address per person the walk signs in as.
 *
 * Better Auth rate-limits its endpoints to twenty requests a minute per client
 * and identifies the client by X-Forwarded-For, because a deployed instance
 * sits behind a reverse proxy that sets it. One walk visits every screen and
 * signs in as two different people, which is more than one client's allowance,
 * and the refusal arrives as an ordinary failed sign-in. Separating them is not
 * a way around the limit: these are different members of the housing
 * cooperative, each at home, which is what the instance would really see.
 */
const CLIENT_ADDRESS: Readonly<Record<Actor, string>> = {
  nobody: "10.40.0.1",
  administrator: "10.40.0.2",
  resident: "10.40.0.3",
};

// --- what may appear in a published image ------------------------------------

/**
 * A personal identity number, in either of the forms the register accepts.
 *
 * These images are attached to pull requests on a public repository about a
 * statutory personal-data register, so this is checked rather than trusted:
 * every screen is scanned before it is written, and a match fails the run.
 */
const IDENTITY_NUMBER = /\b\d{6}(?:\d{2})?[-+]\d{4}\b/g;

/**
 * Whether a match could be a personal identity number at all.
 *
 * A Swedish organisation number has the same shape and appears all over these
 * screens - the cooperative's own, and the example in the hint under the field
 * asking for it. The two are told apart by the date: a personal identity
 * number begins with one, and an organisation number is issued with its month
 * digits raised past twelve precisely so that it cannot. A coordination number
 * is a personal identity number with sixty added to the day, so the day is
 * allowed to run past the end of a month.
 */
function couldBeADate(candidate: string): boolean {
  const [date = ""] = candidate.split(/[-+]/);
  const month = Number(date.slice(-4, -2));
  const day = Number(date.slice(-2));
  return month >= 1 && month <= 12 && day >= 1 && day <= 91;
}

const EMAIL_ADDRESS = /\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

/**
 * Reserved by RFC 2606 and resolvable by nobody, which is why the fixtures use
 * it. An address on any other domain is a real one until proved otherwise.
 */
const RESERVED_EMAIL_SUFFIX = ".test";

async function assertSafeToPublish(page: Page, name: string): Promise<void> {
  // What a filled-in form shows is in the field's value, not in the document's
  // text, and the setup wizard is photographed with its forms filled in.
  const typed = await page
    .locator("input, textarea")
    .evaluateAll((fields) =>
      fields
        .map((field) => (field as HTMLInputElement | HTMLTextAreaElement).value)
        .filter((value) => value !== ""),
    );
  const text = [await page.locator("body").innerText(), ...typed].join("\n");

  const identityNumbers = [...text.matchAll(IDENTITY_NUMBER)]
    .map((match) => match[0])
    .filter(couldBeADate);
  expect(
    identityNumbers,
    `${name} shows something shaped like a personal identity number. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);

  const addresses = [...text.matchAll(EMAIL_ADDRESS)]
    .map((match) => match[0])
    .filter((candidate) => !candidate.endsWith(RESERVED_EMAIL_SUFFIX));
  expect(
    addresses,
    `${name} shows an email address outside the reserved ${RESERVED_EMAIL_SUFFIX} domain. Screenshots are published; seed data that cannot appear in one.`,
  ).toEqual([]);
}

// --- resolving a declared target ---------------------------------------------

/** A string is an exact name; a regular expression is used as written. */
function nameOf(value: string | RegExp): {
  name: string | RegExp;
  exact: boolean;
} {
  return { name: value, exact: typeof value === "string" };
}

/**
 * A form field is named by the whole of its `<label>`, and a label wraps its
 * hint as well as its word - "Organisationsnummer" is followed on screen by the
 * sentence explaining what to type. A field's name is therefore matched from
 * the beginning rather than end to end. Anchored, so "Namn" still does not
 * reach "Förnamn".
 */
function startsWith(value: string | RegExp): RegExp {
  return typeof value === "string"
    ? new RegExp(`^${value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    : value;
}

function matching(page: Page, target: Target): Locator {
  if ("heading" in target) {
    return page.getByRole("heading", nameOf(target.heading));
  }
  if ("button" in target) {
    return page.getByRole("button", nameOf(target.button));
  }
  if ("combobox" in target) {
    // Named through its label like any other field, and a label that wraps a
    // select carries every option's text as well.
    return page.getByRole("combobox", { name: startsWith(target.combobox) });
  }
  if ("label" in target) {
    return page.getByLabel(startsWith(target.label));
  }
  if ("text" in target) {
    return page.getByText(target.text, {
      exact: typeof target.text === "string",
    });
  }
  // A settings card carries no accessible name of its own, so it is found
  // through its heading and then walked up to the section that holds it.
  return page
    .getByRole("heading", { name: target.panel, exact: true, level: 2 })
    .locator("xpath=ancestor::section[1]");
}

/**
 * A target's locator. Ambiguity is an error unless the entry asked for the
 * first match, so an entry that has quietly started matching a second thing
 * fails rather than photographing whichever one came first.
 */
function locate(page: Page, target: Target): Locator {
  const found = matching(page, target);
  return target.first === true ? found.first() : found;
}

async function perform(page: Page, action: Action): Promise<void> {
  if ("click" in action) {
    await locate(page, action.click).click();
    return;
  }
  if ("fill" in action) {
    await locate(page, action.fill).fill(action.value);
    return;
  }
  if ("select" in action) {
    await locate(page, action.select).selectOption({ label: action.option });
    return;
  }
  await expect(locate(page, action.see)).toBeVisible();
}

// --- reaching a screen --------------------------------------------------------

async function signIn(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(account.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
}

/**
 * Waits until the picture would be the same a second from now.
 *
 * The declared target proves the right screen is up; the rest is what stops a
 * rerun differing from the one before it by a frame of an animation, a font
 * swap or a late request. `animations: "disabled"` at the capture finishes the
 * job by rewinding CSS animations to their end state.
 */
async function settle(page: Page, screen: Screen): Promise<void> {
  await expect(locate(page, screen.waitFor)).toBeVisible();

  // Bounded, and not fatal: a screen that never goes quiet is still worth
  // photographing, and the assertion above has already proved it is the right
  // one.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // Nothing to do: the wait is a settling aid, not a check.
  });

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(done);
      });
    });
  });
}

async function capture(
  page: Page,
  screen: Screen,
  theme: (typeof THEMES)[number],
): Promise<string> {
  const path = resolve(OUTPUT_DIR, `${screen.name}-${theme}.png`);
  const options = { path, animations: "disabled", caret: "hide" } as const;

  const what = screen.capture ?? "viewport";
  if (what === "viewport") {
    await page.screenshot(options);
  } else if (what === "page") {
    await page.screenshot({ ...options, fullPage: true });
  } else {
    await locate(page, what).screenshot(options);
  }
  return path;
}

test("captures every declared screen in light and dark", async ({
  browser,
  api: request,
}) => {
  // One test walks every screen, because the walk is the point: an instance is
  // unclaimed once, and each entry starts where the one before it stopped.
  test.setTimeout(20 * 60_000);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  /**
   * A browser for one person.
   *
   * Built here rather than taken from the suite's `page` fixture, which makes
   * its context by hand and would drop everything in BROWSER. One per person as
   * well as one per set of options: a new context arrives with no cookies, so
   * the session that came before it is gone by construction.
   */
  const openContextFor = async (actor: Actor): Promise<BrowserContext> =>
    browser.newContext({
      ...BROWSER,
      baseURL: stack.baseUrl,
      extraHTTPHeaders: { "x-forwarded-for": CLIENT_ADDRESS[actor] },
    });

  let context = await openContextFor("nobody");
  let page = await context.newPage();

  let people: ReadonlyMap<string, string> | undefined;
  /**
   * The demo cooperative and the four people in its register, made once.
   *
   * Deferred until a screen needs a session, because the wizard entries above
   * it run against an instance nobody has claimed, and claiming it is what they
   * photograph. It also completes setup, which the wizard walk stops short of.
   */
  const registerFixture = async (): Promise<ReadonlyMap<string, string>> => {
    people ??= await ensureRegisterFixture(request);
    return people;
  };

  let signedInAs: Actor = "nobody";

  const establish = async (wanted: Actor | undefined): Promise<void> => {
    if (wanted === undefined) {
      return;
    }
    // "nobody" is established even when it is already the tracked state: the
    // wizard signs in the administrator it creates without being asked, and the
    // sign-in screen turns away a visitor who already has a session.
    if (wanted === signedInAs && wanted !== "nobody") {
      return;
    }

    const ids = wanted === "nobody" ? undefined : await registerFixture();

    await context.close();
    context = await openContextFor(wanted);
    page = await context.newPage();

    if (wanted === "administrator") {
      await signIn(page, ADMINISTRATOR);
    } else if (wanted === "resident") {
      const personId = ids?.get(RESIDENT.name);
      expect(personId, `${RESIDENT.name} is in the register`).toBeDefined();
      await ensureAccountFor(request, {
        personId: personId!,
        email: RESIDENT.email,
        password: RESIDENT.password,
        clientAddress: CLIENT_ADDRESS.resident,
      });
      await signIn(page, RESIDENT);
    }
    signedInAs = wanted;
  };

  try {
    for (const screen of SCREENS) {
      await establish(screen.as);
      if (screen.goto !== undefined) {
        await page.goto(screen.goto);
      }
      for (const action of screen.prepare ?? []) {
        await perform(page, action);
      }

      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme });
        // Nothing has stored a preference, so the client is following the
        // system and the emulated setting above is what decides. An attribute
        // here would mean the mode was pinned and the two images would come out
        // identical.
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-theme",
          /.*/,
        );

        await settle(page, screen);
        await assertSafeToPublish(page, screen.name);
        const path = await capture(page, screen, theme);
        console.log(`  ${relative(repositoryRoot, path)}`);
      }
    }
  } finally {
    await context.close();
  }
});
