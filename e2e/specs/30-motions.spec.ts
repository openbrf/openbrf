import type { APIRequestContext, Page } from "@playwright/test";

import * as api from "../src/api";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Motions to the general meeting, through the browser.
 *
 * Not one of the numbered exit criteria. It is here because the module's central
 * property is a statute about who a person is, and it only exists once a browser,
 * the API and a real register are in the same room.
 *
 * EFL 6 kap. 15 § - applied to a housing cooperative by BRL 9 kap. 14 §, which
 * excepts six of that chapter's rules and not this one - gives the right to have
 * an item taken up at a general meeting to "en medlem". The shared register
 * fixture holds two people in the same apartment: Astrid Lindqvist as MEMBER and
 * Nils Lindqvist as RESIDENT. They live at the same address, they sign in the same
 * way, and the platform has to answer them differently. That is what the first two
 * tests below are.
 *
 * The rest is what the board does with what arrives: it reads the queue, records a
 * motion as received, and is offered no way to reject one - because refusing to
 * take up a member's item is not the board's to decide under that paragraph.
 *
 * The bylaws' deadline is recorded by an administrator and read back by the member
 * on the form, which is what makes it the association's clause rather than the
 * platform's.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this spec's own invention would fail that probe, fall
 * through to an invitation, and be refused for an account that already exists.
 */
const PASSWORD = "granngarden-kastanj-2026";

/** From the shared fixture: 12/1001, and a member. The right is hers. */
const MEMBER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * Her household at the same apartment, recorded RESIDENT rather than MEMBER.
 *
 * The whole point of the pair. He lives here and holds no tenant-ownership, so
 * EFL 6 kap. 15 § gives him no right to put an item to the meeting - and the
 * platform must not offer him one, because offering it and then refusing the
 * write would be the worse of the two failures.
 */
const LODGER = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/*
 * Every person a test acts as gets a client address of their own, from the shared
 * fixtures' `clientAddressFor`.
 *
 * The authentication endpoints are rate-limited per client address, and the
 * fixture gives each test one - on the reading that a test is one member signing
 * in from their own home. These tests act as up to three people each, and sharing
 * one address would make the suite throttle itself and read as flaky. It is not a
 * way around the limit: each person still gets one budget, and what this stops is
 * one person's traffic spending another's.
 */
type Persona = "administrator" | "member" | "lodger";

/** Puts this browser on one person's own client address. */
async function browseAs(
  page: Page,
  clientAddress: string,
  persona: Persona,
): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": clientAddressFor(clientAddress, persona),
  });
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * Starts from a browser holding no session. The tests here act as up to three
 * people on one page, and `browseAs` changes only the forwarded-for header, so a
 * second call would arrive still carrying the first person's cookie - and
 * /sign-in's route guard sends a visitor who already has a session to the
 * address book, leaving this function filling in a form that is no longer on the
 * screen. The screenshot walk closes its whole browser context between personas
 * for the same reason; clearing the cookies is the same act on a page the tests
 * share.
 *
 * The wait belongs here rather than to the callers: clicking only starts the
 * sign-in, so a caller that navigates on the next line cancels the request in
 * flight and the route guard sends the browser back to the form.
 */
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

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
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

/**
 * The instance every test here expects: the register fixture, and an account for
 * the member and for her household.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 */
async function ensureMotionFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
  const people = await ensureRegisterFixture(request);

  for (const [person, persona] of [
    [MEMBER, "member"],
    [LODGER, "lodger"],
  ] as const) {
    const personId = people.get(person.name);
    if (personId === undefined) {
      throw new Error(`${person.name} is not in the register fixture`);
    }
    await ensureAccountFor(request, {
      personId,
      email: person.email,
      password: person.password,
      clientAddress: clientAddressFor(clientAddress, persona),
    });
  }
}

/** A title unique to this run, so a screen opening one finds one motion. */
function motionTitle(label: string): string {
  return `${label} ${String(Date.now())}`;
}

test.describe("motions to the general meeting", () => {
  test("a member puts an item to the meeting and can take it back", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureMotionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);

    await page.goto(appPath("/motions"));

    const title = motionTitle("Laddstolpar i garaget");
    await page.getByLabel("Vad du föreslår, på en rad").fill(title);
    await page
      .getByLabel("Förslaget")
      .fill("Föreningen bör utreda vad laddstolpar skulle kosta.");
    await page.getByRole("button", { name: "Skicka motionen" }).click();

    // The motion as the server read it back, not the form having been submitted:
    // the withdraw control exists only once the member's own list has come back
    // with the row in it.
    const withdraw = page.getByRole("button", {
      name: `Återkalla motionen ${title}`,
    });
    await expect(withdraw).toBeVisible();

    // And it is with the board rather than decided.
    const row = page.getByRole("listitem").filter({ hasText: title }).first();
    await expect(row).toContainText("Hos styrelsen");

    await withdraw.click();

    // Withdrawn, and still on the list: the record that she put something to the
    // meeting is hers, and nothing here deletes a row.
    await expect(
      page.getByRole("listitem").filter({ hasText: title }).first(),
    ).toContainText("Återkallad");
    await expect(withdraw).toHaveCount(0);
  });

  test("a resident who is not a member is offered no motion at all", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The statutory assertion of this file, at the place a person would actually
     * look. Nils lives in the same apartment as Astrid and is recorded RESIDENT,
     * so EFL 6 kap. 15 § gives him nothing here.
     *
     * Both halves are asserted. The navigation does not offer the destination,
     * because a link to a screen that can only refuse somebody teaches them a
     * part of the product is broken for them rather than not theirs. And the
     * screen itself, reached directly, offers no form - which is the assertion
     * that would still hold if the navigation were rebuilt tomorrow.
     */
    await ensureMotionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "lodger");
    await signInThroughTheScreen(page, LODGER.email, LODGER.password);

    /*
     * Somewhere he does belong, so the band is loaded and its links are the ones
     * this account is offered. The issues destination by the label the band
     * actually carries - the module's own navLabel - and .first() because the
     * shell renders the same links twice, once for the band and once for the
     * bottom bar on a narrow screen.
     */
    await page.goto(appPath("/issues"));
    await expect(
      page.getByRole("link", { name: "Ärenden", exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Motioner" })).toHaveCount(0);

    // And the screen itself, asked for by hand.
    await page.goto(appPath("/motions"));
    await expect(
      page.getByRole("heading", { name: "Motioner till stämman" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skicka motionen" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Vad du föreslår, på en rad")).toHaveCount(0);
  });

  test("the board records a motion as received and cannot reject one", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureMotionFixture(request, clientAddress);

    // The member's item, put in through the browser as she would.
    const title = motionTitle("Cykelställ på gaveln");
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);
    await page.goto(appPath("/motions"));
    await page.getByLabel("Vad du föreslår, på en rad").fill(title);
    await page.getByLabel("Förslaget").fill("Fler platser behövs vid porten.");
    await page.getByRole("button", { name: "Skicka motionen" }).click();
    await expect(
      page.getByRole("button", { name: `Återkalla motionen ${title}` }),
    ).toBeVisible();

    // The board reads the queue it arrived in.
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );
    await page.goto(appPath("/motions"));

    const acknowledge = page.getByRole("button", {
      name: `Anteckna motionen ${title} som mottagen`,
    });
    await expect(acknowledge).toBeVisible();

    // Who put it in, named to the board and to nobody else.
    const queued = page
      .getByRole("listitem")
      .filter({ hasText: title })
      .first();
    await expect(queued).toContainText(MEMBER.name);

    /*
     * And no way to reject it. Refusing to take up a member's item is not the
     * board's to decide under EFL 6 kap. 15 §; whether the meeting adopts the
     * proposal is minuted at the meeting. There is no endpoint for it, and a
     * control that only ever failed would be a worse way of saying so.
     */
    for (const label of [/^Avslå/, /^Avvisa/, /^Neka/]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }

    await acknowledge.click();

    await expect(
      page.getByRole("listitem").filter({ hasText: title }).first(),
    ).toContainText("Mottagen");
    await expect(acknowledge).toHaveCount(0);
  });

  test("the deadline the bylaws set reaches the member's form", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The clause is the association's own and the platform holds no default, so
     * the only way it can reach a member is by having been recorded. This is the
     * whole path: an administrator writes it in settings, and the member reads it
     * on the form she writes a motion in.
     *
     * Restored over HTTP in the finally, so the shared instance is left as the
     * later specs and the screenshot capture expect it.
     */
    await ensureMotionFixture(request, clientAddress);

    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    try {
      await page.goto(appPath("/settings"));

      const panel = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Sista dag för motioner" }),
      });
      await expect(panel).toBeVisible();
      await panel.getByLabel("Månad").fill("1");
      await panel.getByLabel("Dag").fill("31");
      await panel.getByRole("button", { name: "Spara" }).click();
      await expect(panel.getByText("Sparat")).toBeVisible();

      // The member's side of the same clause.
      await browseAs(page, clientAddress, "member");
      await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);
      await page.goto(appPath("/motions"));

      // The resolved date rather than the month and day, which is the part that
      // has to be computed rather than echoed back.
      await expect(page.getByText(/senast \d{4}-01-31/)).toBeVisible();
      // And that a later motion is still received, because the deadline decides
      // which meeting an item reaches and not whether it is taken.
      await expect(page.getByText(/tas ändå emot/)).toBeVisible();
    } finally {
      await api.setMotionDeadline(request, stack.baseUrl, null);
    }
  });
});
