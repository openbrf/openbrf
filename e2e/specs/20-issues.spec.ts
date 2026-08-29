import type { APIRequestContext, Page } from "@playwright/test";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Issue reporting, triage, and the promise made about the property manager.
 *
 * Not one of the numbered exit criteria. It is here because three of the
 * module's properties only exist once a browser, the API and a real database
 * are in the same room.
 *
 * A resident reports through the screen, with a photograph, and the report
 * comes back with the state it is actually in.
 *
 * The type a resident is offered is the server's decision. The board's internal
 * category exists on this instance throughout, and it is never in the picker.
 *
 * And decision 11: an external property manager reaches the queue and their own
 * settings, and the address book is not in their navigation at all. That is the
 * promise the platform makes a housing cooperative about an outside party with
 * an account, and it is checked here because the navigation is where a person
 * would actually find the door.
 */

test.describe.configure({ mode: "serial" });

/**
 * The resident who reports. From the shared fixture: 12/1001, a member.
 *
 * The password is the one the shared fixture accounts are activated with, and
 * it has to stay the literal spec 03 uses - it is the spec that activates this
 * account, and spec 06 and the screenshot capture spell out the same one for
 * the other shared people. ensureAccountFor establishes its idempotency by
 * signing in before it invites, so a password of this spec's own invention
 * would fail that probe, fall through to an invitation, and be refused for an
 * account that already exists. Do not invent another one.
 */
const REPORTER = {
  fullName: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: "granngarden-kastanj-2026",
} as const;

/*
 * The external property manager. Written by this spec and never removed again -
 * nothing in the suite can delete a person - so the identity is this run's.
 * They hold no apartment, which is the point: they do not live here.
 *
 * This one is the spec's own, not the shared fixture's, so it carries its own
 * password: the address is unique to the run, no other spec activates it, and
 * ensureAccountFor therefore creates the account with exactly this password the
 * first time it is asked for.
 */
const MANAGER = {
  firstName: "Frida",
  lastName: uniqueSurname("Forsberg"),
  email: uniqueEmail("frida"),
  password: "gardsgrus-nyckelknippa-2026",
} as const;

/** This run's own types, so a rerun against a kept stack reads its own rows. */
const MEMBER_TYPE = uniqueSurname("Vattenlacka");
const BOARD_TYPE = uniqueSurname("Internbesiktning");

const DESCRIPTION = `Det droppar fran taket i badrummet, ${uniqueSurname("rapport")}.`;

/**
 * A PNG: the signature, an IHDR chunk, and nothing else.
 *
 * The upload path identifies a file from its header, so a real encoder would
 * add pixel data that no assertion here looks at.
 */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
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
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Logga in" }).click();
  expect((await answered).ok()).toBe(true);
  await expect(page).not.toHaveURL(/sign-in/);
}

type BoardPage = {
  readonly rows: readonly {
    readonly personId: string;
    readonly name: string;
  }[];
};

/**
 * A person in the register, by name, or nothing.
 *
 * The `all` filter lists a person with no residency as well as one with, which
 * is what makes it usable here: the property manager holds no apartment.
 */
async function findPerson(
  request: APIRequestContext,
  name: string,
): Promise<string | undefined> {
  const response = await request.get(
    `${stack.baseUrl}/api/address-book?search=${encodeURIComponent(name)}&filter=all&page=1`,
  );
  if (!response.ok()) {
    throw new Error(
      `GET /api/address-book answered ${String(response.status())}`,
    );
  }
  const page = (await response.json()) as BoardPage;
  return page.rows.find((row) => row.name === name)?.personId;
}

/**
 * The instance every test here expects: the register fixture, two issue types,
 * an account for the reporter and one for the property manager.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 */
async function ensureIssueFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<{ reporterPersonId: string; managerPersonId: string }> {
  /*
   * The context comes back signed in as the administrator: ensureInstance,
   * which ensureRegisterFixture calls, signs it in. Do not sign in again here.
   * A second sign-in goes out on a context that already holds the session
   * cookie, and the authentication layer applies its origin check to a
   * cookie-bearing state-changing request - which this context, carrying only
   * a forwarded-for header, has no Origin to satisfy.
   */
  const people = await ensureRegisterFixture(request);

  const existing = await api.listIssueTypes(request, stack.baseUrl);
  for (const wanted of [
    { name: MEMBER_TYPE, audience: "MEMBER" as const, sortOrder: 1 },
    { name: BOARD_TYPE, audience: "BOARD" as const, sortOrder: 2 },
  ]) {
    if (!existing.some((type) => type.name === wanted.name)) {
      await api.createIssueType(request, stack.baseUrl, wanted);
    }
  }

  const reporterPersonId = people.get(REPORTER.fullName);
  if (reporterPersonId === undefined) {
    throw new Error(`${REPORTER.fullName} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId: reporterPersonId,
    email: REPORTER.email,
    password: REPORTER.password,
    clientAddress,
  });

  /*
   * Looked up before being created. Nothing in the suite can delete a person,
   * and this helper runs once per test in the file, so creating unconditionally
   * would leave four identical property managers in the register per run.
   */
  const managerFullName = `${MANAGER.firstName} ${MANAGER.lastName}`;
  const managerPersonId =
    (await findPerson(request, managerFullName)) ??
    (await api.createPerson(request, stack.baseUrl, {
      firstName: MANAGER.firstName,
      lastName: MANAGER.lastName,
      email: MANAGER.email,
    }));
  await grantPropertyManager(managerPersonId);
  await ensureAccountFor(request, {
    personId: managerPersonId,
    email: MANAGER.email,
    password: MANAGER.password,
    clientAddress,
  });

  return { reporterPersonId, managerPersonId };
}

test("a resident reports an issue with a photograph", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureIssueFixture(request, clientAddress);

  await signInThroughTheScreen(page, REPORTER.email, REPORTER.password);
  await page.goto(appPath("/issues"));

  await expect(
    page.getByRole("heading", { name: "Gör en felanmälan" }),
  ).toBeVisible();

  /*
   * The warning is on the form before anything is typed, and it names who reads
   * what is written. Issue free text is where health data and a neighbour's
   * details arrive without anybody meaning to put them there.
   */
  await expect(page.getByText(/extern förvaltare/i)).toBeVisible();

  // The board's internal category exists on this instance and is not offered.
  const picker = page.getByLabel("Vad gäller det");
  await expect(picker.getByRole("option", { name: MEMBER_TYPE })).toHaveCount(
    1,
  );
  await expect(picker.getByRole("option", { name: BOARD_TYPE })).toHaveCount(0);

  await picker.selectOption({ label: MEMBER_TYPE });
  await page.getByLabel("Var i huset").fill("Badrummet");
  await page.getByLabel("Vad har hänt").fill(DESCRIPTION);

  await page.getByLabel("Lägg till foto").setInputFiles({
    name: "tak.png",
    mimeType: "image/png",
    buffer: pngBytes(24, 24),
  });

  await page.getByRole("button", { name: "Skicka anmälan" }).click();

  await expect(
    page.getByText("Anmälan är skickad och ligger nu i kön."),
  ).toBeVisible();

  // It comes back in the reporter's own list, in the state it is actually in.
  const own = page.getByRole("listitem").filter({ hasText: DESCRIPTION });
  await expect(own.first()).toBeVisible();
  await expect(own.first().getByText("Ny")).toBeVisible();
  // The photograph is served from this instance's own origin, never from a
  // storage endpoint, so its address is what proves it was attached.
  await expect(own.first().locator('img[src^="/api/media/"]')).toHaveCount(1);
});

test("the board takes the report on and marks it done", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureIssueFixture(request, clientAddress);

  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await page.goto(appPath("/issues"));

  const row = page
    .getByRole("listitem")
    .filter({ hasText: DESCRIPTION })
    .first();
  await expect(row).toBeVisible();
  // The queue says who reported it, by name: this reporter is not protected.
  await expect(row.getByText(REPORTER.fullName)).toBeVisible();

  await row.getByRole("button", { name: "Ta hand om det" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: DESCRIPTION })
      .first()
      .getByText("Pågår"),
  ).toBeVisible();

  await page
    .getByRole("listitem")
    .filter({ hasText: DESCRIPTION })
    .first()
    .getByRole("button", { name: "Markera som klar" })
    .click();

  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: DESCRIPTION })
      .first()
      .getByText("Klar"),
  ).toBeVisible();
});

test("the property manager works the queue and is never shown the address book", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureIssueFixture(request, clientAddress);

  await signInThroughTheScreen(page, MANAGER.email, MANAGER.password);
  await page.goto(appPath("/issues"));

  await expect(page.getByRole("heading", { name: "Ärendekön" })).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: DESCRIPTION }).first(),
  ).toBeVisible();

  /*
   * Decision 11, at the place a person would actually find the door. The API
   * refuses them the register either way; a link straight to it would be the
   * platform showing an outside party something it promised was not there.
   */
  await expect(page.getByRole("link", { name: "Adressbok" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ärenden" })).not.toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Inställningar" }),
  ).not.toHaveCount(0);

  // They handle the association's issues; they do not live in the building, so
  // there is no report form for them either.
  await expect(
    page.getByRole("heading", { name: "Gör en felanmälan" }),
  ).toHaveCount(0);
});

test("the board decides whether the website carries a report form", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureIssueFixture(request, clientAddress);

  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await page.goto(appPath("/settings"));

  const toggle = page.getByLabel("Ta emot felanmälan från webbplatsen");
  await expect(toggle).toBeVisible();

  try {
    // On by default: an issue report produces a maintenance ticket, not an
    // account on an instance holding a statutory register.
    await expect(toggle).toBeChecked();
    await expect(page.getByText(/^På: formuläret finns/)).toBeVisible();

    await toggle.uncheck();
    await expect(page.getByText(/^Av: det finns inget formulär/)).toBeVisible();
  } finally {
    /*
     * Restored over HTTP rather than through the screen, so a failure above
     * still leaves the instance as the other specs expect to find it. No
     * sign-in here: ensureIssueFixture left this context signed in as the
     * administrator, and signing in again on a context that already holds the
     * cookie is refused for want of an Origin - inside a finally, that refusal
     * would replace whichever assertion actually failed.
     */
    await api.setPublicIssueReporting(request, stack.baseUrl, true);
  }
});
