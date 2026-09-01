import { mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type {
  APIRequestContext,
  BrowserContext,
  Cookie,
  Locator,
  Page,
} from "@playwright/test";

import * as api from "../src/api";
import { expect, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath, repositoryRoot, stack } from "../src/stack";
import { MEMBER, RESIDENT } from "./people";
import { assertSafeToPublish, freezeScripts } from "./safety";
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
 *
 * The locale is set because one part of the instance answers in the visitor's
 * language rather than in its own: the association's public website reads
 * Accept-Language, having nobody signed in whose preference it could use. The
 * client is Swedish whatever the browser asks for, so without this the website
 * would be the one set of images in a different language from the rest.
 */
const BROWSER = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
  locale: "sv-SE",
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
 * The two residents the walk signs in as, beside the administrator.
 *
 * Each gets an account through the invitation flow, like anybody else on the
 * instance. Who they are, and why there are two of them, is in people.ts.
 */
const PERSONAS: Readonly<
  Record<
    "resident" | "member",
    { readonly name: string; readonly email: string; readonly password: string }
  >
> = {
  resident: RESIDENT,
  member: MEMBER,
};

/**
 * A client address per person the walk signs in as.
 *
 * Better Auth identifies a client by X-Forwarded-For, because a deployed
 * instance sits behind a reverse proxy that sets it, and it counts a sign-in
 * attempt against that client: a few in ten seconds, which is what stands
 * between a stolen address list and the accounts on it. One walk visits every
 * screen and signs in as three different people, so one address between them
 * would spend one person's attempts on another's, and the refusal arrives as an
 * ordinary failed sign-in. Separating them is not a way around the limit: these
 * are different members of the housing cooperative, each at home, which is what
 * the instance would really see.
 *
 * Keeping each of them inside that allowance is what the sessions below are
 * for: one sign-in per person, however many screens they appear on. The session
 * check every page load makes has a budget of its own, sized for a client
 * rather than for a password guess, so the walk does not pace itself against
 * it - see auth-options.ts.
 */
const CLIENT_ADDRESS: Readonly<Record<Actor, string>> = {
  nobody: "10.40.0.1",
  administrator: "10.40.0.2",
  resident: "10.40.0.3",
  member: "10.40.0.4",
};

// --- the register the walk photographs ---------------------------------------

/**
 * The tenant-owner the statutory registers are photographed with.
 *
 * The shared register fixture puts its four people on apartments through
 * sign-up approval, which records a residency and nothing statutory. A member
 * register entry is written by a move-in, and the apartment register states who
 * holds an apartment, so without one move-in both documents would be
 * photographed empty. Looked up before she is created, like every other fixture
 * here, so a capture against a stack that is already up finds her rather than
 * seeding a second one.
 */
async function ensureTenantOwner(request: APIRequestContext): Promise<string> {
  const existing = await api.findPersonIdByName(
    request,
    stack.baseUrl,
    MEMBER.name,
  );
  if (existing !== undefined) {
    return existing;
  }

  const personId = await api.createPerson(request, stack.baseUrl, {
    firstName: MEMBER.firstName,
    lastName: MEMBER.lastName,
    email: MEMBER.email,
    postalStreet: MEMBER.postalStreet,
    postalCode: MEMBER.postalCode,
    postalCity: MEMBER.postalCity,
  });

  const addresses = await api.listAddresses(request, stack.baseUrl);
  const address = addresses.find(
    (candidate) => candidate.number === MEMBER.addressNumber,
  );
  if (address === undefined) {
    throw new Error(
      `no address numbered ${MEMBER.addressNumber} in the register`,
    );
  }
  const apartments = await api.listApartments(
    request,
    stack.baseUrl,
    address.id,
  );
  const apartment = apartments.find(
    (candidate) => candidate.number === MEMBER.apartmentNumber,
  );
  if (apartment === undefined) {
    throw new Error(
      `no apartment ${MEMBER.apartmentNumber} on ${address.street} ${address.number}`,
    );
  }

  // A tenant-ownership with its transfer: one act writes the entry in the
  // member register and the first grant in the apartment register.
  await api.moveIn(request, stack.baseUrl, {
    personId,
    apartmentId: apartment.id,
    role: "MEMBER",
    movedInOn: MEMBER.heldFrom,
    transfer: {
      transferredOn: MEMBER.heldFrom,
      price: MEMBER.price,
      agreementReference: MEMBER.agreementReference,
    },
  });

  return personId;
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

/**
 * A settings card, found through its heading and then walked up to the section
 * that holds it: the card carries no accessible name of its own.
 */
function panelOf(where: Page | Locator, title: string): Locator {
  return where
    .getByRole("heading", { name: title, exact: true, level: 2 })
    .locator("xpath=ancestor::section[1]");
}

/**
 * Where a target is looked for: the page, or one card on it.
 *
 * A page and a locator are asked in the same words, which is what lets an entry
 * name a card and change nothing else about how it is written.
 */
function matching(where: Page | Locator, target: Target): Locator {
  if ("heading" in target) {
    return where.getByRole("heading", nameOf(target.heading));
  }
  if ("button" in target) {
    return where.getByRole("button", nameOf(target.button));
  }
  if ("combobox" in target) {
    // Named through its label like any other field, and a label that wraps a
    // select carries every option's text as well.
    return where.getByRole("combobox", { name: startsWith(target.combobox) });
  }
  if ("label" in target) {
    return where.getByLabel(startsWith(target.label));
  }
  if ("text" in target) {
    return where.getByText(target.text, {
      exact: typeof target.text === "string",
    });
  }
  return panelOf(where, target.panel);
}

/**
 * A target's locator. Ambiguity is an error unless the entry asked for the
 * first match, so an entry that has quietly started matching a second thing
 * fails rather than photographing whichever one came first.
 */
function locate(page: Page, target: Target): Locator {
  const found = matching(
    target.within === undefined ? page : panelOf(page, target.within),
    target,
  );
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
  if ("upload" in action) {
    // Handed to the control as bytes rather than as a path: the file is
    // declared in the manifest, so there is nothing on disk to point at.
    await locate(page, action.upload).setInputFiles({
      name: action.file.name,
      mimeType: action.file.mimeType,
      buffer: Buffer.from(action.file.text, "utf8"),
    });
    return;
  }
  await expect(locate(page, action.see)).toBeVisible();
}

// --- reaching a screen --------------------------------------------------------

async function signIn(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  await page.goto(appPath("/sign-in"));
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

/**
 * Takes the picture, and does not write it.
 *
 * The bytes are held rather than sent straight to a file so that the check
 * standing between them and the disk is a check the image cannot get past. A
 * screenshot written by the capture itself is a published image whose check
 * runs afterwards, and a failure then is a failure that leaves the file behind.
 */
async function photograph(page: Page, screen: Screen): Promise<Buffer> {
  const options = { animations: "disabled", caret: "hide" } as const;

  const what = screen.capture ?? "viewport";
  if (what === "viewport") {
    return page.screenshot(options);
  }
  if (what === "page") {
    return page.screenshot({ ...options, fullPage: true });
  }
  return locate(page, what).screenshot(options);
}

test("captures every declared screen in light and dark", async ({
  browser,
  api: request,
}) => {
  // One test walks every screen, because the walk is the point: an instance is
  // unclaimed once, and each entry starts where the one before it stopped. The
  // budget is for the whole walk in both themes, not for one screen.
  test.setTimeout(40 * 60_000);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  /**
   * The session cookies of everyone who has signed in, kept for the whole walk.
   *
   * One sign-in per person, not one per screen they appear on. The walk returns
   * to the administrator a dozen times, and signing in again each time would
   * spend that client's sign-in attempts on credentials the instance has
   * already accepted - a few in ten seconds is what guessing a password is
   * allowed, and a walk that signed in per screen would be refused inside the
   * first few. Handing the cookie back costs none of them.
   *
   * The cookies alone, and deliberately not the whole storage state: a restored
   * local storage would carry a theme preference from the screen before it, and
   * every screen here is photographed as a viewer whose computer chooses the
   * mode.
   */
  const sessions = new Map<Actor, Cookie[]>();

  /** The screen being reached, for the message a refusal below would carry. */
  let reaching = "the first screen";

  /**
   * Every refusal the instance answered on an auth endpoint.
   *
   * A refusal is invisible from the outside: the client cannot tell a 429 from
   * having no session, so the screen quietly becomes the sign-in form and the
   * entry then fails on a control that is not on it, several screens after the
   * cause. The walk therefore watches for the refusal itself rather than
   * pacing itself to stay clear of one: the session check is nearly every auth
   * request a walk makes and has a budget sized for a client rather than for a
   * password guess, and one sign-in per person is well inside the tight budget
   * that guards those.
   */
  const refusals: string[] = [];

  const assertNothingWasRefused = (): void => {
    if (refusals.length === 0) {
      return;
    }
    throw new Error(
      `The instance refused an auth request: ${refusals.join("; ")}. The ` +
        "client reads a refusal as having no session, so every screen from " +
        "there on is photographed signed out.",
    );
  };

  /**
   * A browser for one person.
   *
   * Built here rather than taken from the suite's `page` fixture, which makes
   * its context by hand and would drop everything in BROWSER. One per person as
   * well as one per set of options, and it arrives with that person's session
   * and nothing else - "nobody" has none stored, so a visitor is a visitor by
   * construction.
   */
  const openContextFor = async (actor: Actor): Promise<BrowserContext> => {
    const opened = await browser.newContext({
      ...BROWSER,
      baseURL: stack.baseUrl,
      extraHTTPHeaders: { "x-forwarded-for": CLIENT_ADDRESS[actor] },
      storageState: { cookies: sessions.get(actor) ?? [], origins: [] },
    });
    // Read from what the instance answered rather than from what the walk meant
    // to ask for: the session checks are the client's own, and nothing here
    // would otherwise see them at all.
    opened.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/api/auth/")) {
        return;
      }
      if (response.status() === 429) {
        refusals.push(`${actor} was refused ${pathname} reaching ${reaching}`);
      }
    });
    return opened;
  };

  let context = await openContextFor("nobody");
  let page = await context.newPage();

  let people: ReadonlyMap<string, string> | undefined;
  /**
   * The demo cooperative and the people in its register, made once.
   *
   * Deferred until a screen needs a session, because the wizard entries above
   * it run against an instance nobody has claimed, and claiming it is what they
   * photograph. It also completes setup, which the wizard walk stops short of.
   */
  const registerFixture = async (): Promise<ReadonlyMap<string, string>> => {
    if (people === undefined) {
      const seeded = new Map(await ensureRegisterFixture(request));
      seeded.set(MEMBER.name, await ensureTenantOwner(request));
      people = seeded;
    }
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

    // Only the first time each of them appears. Every screen naming an actor
    // navigates for itself, so a returning one needs nothing beyond the session
    // the context above was opened with.
    if (wanted !== "nobody" && !sessions.has(wanted)) {
      if (wanted === "administrator") {
        await signIn(page, ADMINISTRATOR);
      } else {
        const persona = PERSONAS[wanted];
        const personId = ids?.get(persona.name);
        expect(personId, `${persona.name} is in the register`).toBeDefined();
        await ensureAccountFor(request, {
          personId: personId!,
          email: persona.email,
          password: persona.password,
          clientAddress: CLIENT_ADDRESS[wanted],
        });
        await signIn(page, persona);
      }
      sessions.set(wanted, (await context.storageState()).cookies);
    }
    signedInAs = wanted;
  };

  try {
    for (const screen of SCREENS) {
      reaching = screen.name;
      await establish(screen.as);
      if (screen.goto !== undefined) {
        await page.goto(screen.goto);
      }
      for (const action of screen.prepare ?? []) {
        await perform(page, action);
      }
      // Before the photographs rather than after them: a screen reached without
      // a session is the sign-in form, and the safety checks below would find
      // nothing wrong with a picture of it.
      assertNothingWasRefused();

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

        // Held still for the whole of it, so the page that is checked is the
        // page that is photographed rather than the page as it was a moment
        // before. The second read costs a few milliseconds and is what would
        // notice a freeze that had stopped working.
        const thaw = await freezeScripts(page, context);
        let image: Buffer;
        try {
          await assertSafeToPublish(page, screen.name);
          image = await photograph(page, screen);
          await assertSafeToPublish(page, screen.name);
        } finally {
          await thaw();
        }

        // Written only now: a picture the check refused is a picture that never
        // reaches the disk, where `page.screenshot({ path })` would have left
        // one behind.
        const path = resolve(OUTPUT_DIR, `${screen.name}-${theme}.png`);
        await writeFile(path, image);
        console.log(`  ${relative(repositoryRoot, path)}`);
      }
    }

    // Again at the end, for a refusal that arrived while the last screen was
    // being photographed and so was never read above.
    assertNothingWasRefused();
  } finally {
    await context.close();
  }
});
