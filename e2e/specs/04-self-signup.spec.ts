import type { Locator, Page } from "@playwright/test";

import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, expectNoMessage, waitForMessage } from "../src/mailpit";
import {
  activationTokenFrom,
  ADMINISTRATOR,
  ensureInstance,
  signInAsAdministrator,
} from "../src/provision";

/**
 * Exit criterion 4.
 *
 * With the toggle on, a visitor asks for an account by typing an address and an
 * apartment number as free text, the board approves it against a real apartment,
 * and the account activates. A second applicant is turned away with a reason,
 * and nothing at all is created for them. With the toggle off the form is closed
 * and the endpoint refuses.
 *
 * The free text matters and is not laziness in the form: the request is made
 * before anyone has signed in, so it must not let a stranger discover which
 * addresses and apartments the cooperative has. The board matches the claim
 * against the register when it approves, which is the point at which someone who
 * knows the building is looking - and that pairing is what these tests drive
 * through the screen rather than over HTTP.
 */

test.describe.configure({ mode: "serial" });

// Written by this spec and never removed again, so the identity is this run's:
// see src/identity.ts.
const APPLICANT = {
  firstName: "Elsa",
  lastName: uniqueSurname("Norberg"),
  email: uniqueEmail("elsa"),
  password: "hoststorm-lyktglas-2026",
} as const;

/** Refused before anything is written, and named per run for the same reason. */
const TURNED_AWAY = {
  firstName: "Gustav",
  lastName: uniqueSurname("Ahlin"),
  email: uniqueEmail("gustav"),
} as const;

/** The apartment this spec claims; the other specs claim their own. */
const CLAIMED_APARTMENT = "1203";

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * The wait belongs to the helper rather than to its callers. Clicking only
 * starts the sign-in, so a caller that navigates on the next line cancels the
 * request in flight: no session is ever established, the route guard sends the
 * browser back to /sign-in, and the failure surfaces several assertions later
 * as a screen that appears to have lost its contents. Callers that happen to
 * assert something afterwards are safe by accident, which is not a property to
 * leave a helper with.
 *
 * It waits for two things and names neither screen: that the server accepted
 * the sign-in, and that the browser has left the sign-in form afterwards. Where
 * a particular account then lands is the caller's own claim to make, and each
 * test here still makes it. The answer is asserted rather than merely awaited,
 * because a helper whose name says "signs in" must not return quietly when the
 * answer was a refusal.
 */
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord", { exact: true }).fill(password);

  // Armed before the click: a wait registered afterwards can miss a response
  // that has already arrived.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/sign-in/email") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);

  // The session exists; this is the screen having acted on it. Without it a
  // caller navigating inside the application would still be racing the
  // sign-in it has just performed.
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/** Fills the public form the way somebody who lives there would. */
async function requestAnAccount(
  page: Page,
  person: { firstName: string; lastName: string; email: string },
  claim: { address: string; apartmentNumber: string },
): Promise<void> {
  await page.getByLabel("Förnamn").fill(person.firstName);
  await page.getByLabel("Efternamn").fill(person.lastName);
  await page.getByLabel("E-postadress").fill(person.email);
  // Exact, because "E-postadress" ends in the same word.
  await page.getByLabel("Adress", { exact: true }).fill(claim.address);
  await page.getByLabel("Lägenhetsnummer").fill(claim.apartmentNumber);
  await page.getByRole("button", { name: "Skicka ansökan" }).click();
  await expect(
    page.getByRole("heading", { name: "Ansökan är mottagen" }),
  ).toBeVisible();
}

/** One waiting request in the board's queue, found by the applicant's address. */
function queueRow(page: Page, email: string): Locator {
  return page.getByRole("listitem").filter({ hasText: email });
}

test("a visitor asks for an account, the board approves, the account activates", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await api.setSelfSignup(request, stack.baseUrl, true);
  await clearMailbox();

  const apartment = await test.step("pick an apartment to claim", async () => {
    const addresses = await api.listAddresses(request, stack.baseUrl);
    const storgatan12 = addresses.find(
      (address) => address.street === "Storgatan" && address.number === "12",
    );
    expect(storgatan12).toBeDefined();
    const apartments = await api.listApartments(
      request,
      stack.baseUrl,
      storgatan12!.id,
    );
    const chosen = apartments.find(
      (candidate) => candidate.number === CLAIMED_APARTMENT,
    );
    expect(chosen).toBeDefined();
    return { address: storgatan12!, apartment: chosen! };
  });

  const claimedAddress = `${apartment.address.street} ${apartment.address.number}`;

  await test.step("the way in is offered from the sign-in screen", async () => {
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Ansök om konto" }).click();
    await expect(
      page.getByRole("heading", { name: "Ansök om konto" }),
    ).toBeVisible();
  });

  await test.step("the visitor asks, and is told nothing exists yet", async () => {
    // Typed by hand, because that is all the form offers: no picker, and so
    // nothing on this screen tells a stranger which addresses exist.
    await requestAnAccount(page, APPLICANT, {
      address: claimedAddress,
      apartmentNumber: CLAIMED_APARTMENT,
    });
    await expect(
      page.getByText(/varken konto eller post i registret/i),
    ).toBeVisible();
  });

  await test.step("the board matches the claim and approves it", async () => {
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();

    await page.goto("/settings");
    const row = queueRow(page, APPLICANT.email);
    await expect(row).toHaveCount(1);
    // What the applicant wrote, verbatim, beside the register's own entries.
    await expect(row).toContainText(claimedAddress);

    await row
      .getByLabel("Adress i registret")
      .selectOption({ label: claimedAddress });
    await row
      .getByLabel("Lägenhet i registret")
      .selectOption({ label: CLAIMED_APARTMENT });
    await row.getByRole("button", { name: "Godkänn" }).click();

    await expect(
      page.getByText(`En inbjudan är på väg till ${APPLICANT.email}`),
    ).toBeVisible();
    // Decided, so it leaves the queue rather than waiting to be decided twice.
    await expect(queueRow(page, APPLICANT.email)).toHaveCount(0);
  });

  await test.step("the invitation activates the account", async () => {
    const { text } = await waitForMessage(APPLICANT.email);
    // SEAM - swap this API step for the /activate browser screen once that PR
    // lands (invitation.service.ts:218-222).
    await api.acceptInvitation(request, stack.baseUrl, {
      token: activationTokenFrom(text),
      password: APPLICANT.password,
    });

    await signOut(page);
    await signInThroughTheScreen(page, APPLICANT.email, APPLICANT.password);
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();
  });
});

test("a request the board turns away creates nothing", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);
  await api.setSelfSignup(request, stack.baseUrl, true);
  await clearMailbox();

  await page.goto("/request-account");
  await requestAnAccount(page, TURNED_AWAY, {
    address: "Storgatan 12",
    // Nobody's apartment, which is the whole reason a human decides these
    // rather than a rule.
    apartmentNumber: "1804",
  });

  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
  await page.goto("/settings");

  const row = queueRow(page, TURNED_AWAY.email);
  await expect(row).toHaveCount(1);
  await row
    .getByLabel("Skäl (frivilligt)")
    .fill("Ingen boende med det namnet på adressen");
  await row.getByRole("button", { name: "Avslå" }).click();

  await expect(page.getByText("Ingenting skapades.")).toBeVisible();
  await expect(queueRow(page, TURNED_AWAY.email)).toHaveCount(0);

  const pending = await api.listSignupRequests(request, stack.baseUrl);
  expect(pending.some((entry) => entry.email === TURNED_AWAY.email)).toBe(
    false,
  );
  // A rejection is not an invitation: nothing was created, so nothing is sent.
  await expectNoMessage(TURNED_AWAY.email);
});

test("with the toggle off the form is closed and the endpoint refuses", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);
  await api.setSelfSignup(request, stack.baseUrl, false);

  try {
    await page.goto("/request-account");
    await expect(
      page.getByText(/tar inte emot ansökningar om konto just nu/i),
    ).toBeVisible();
    // Closed means closed: the notice replaces the form rather than standing
    // above one whose every submission would be refused.
    await expect(page.getByLabel("Förnamn")).toHaveCount(0);

    // The screen is a courtesy; this is the rule. A caller who skips it is
    // refused before anything in the request is read.
    const refused = await api.submitSignupRequest(page.request, stack.baseUrl, {
      firstName: TURNED_AWAY.firstName,
      lastName: TURNED_AWAY.lastName,
      email: TURNED_AWAY.email,
      claimedAddress: "Storgatan 12",
      claimedApartmentNumber: "1204",
    });

    expect(refused.status).toBe(403);
    expect(refused.reason).toBe("self-signup-disabled");
  } finally {
    // Left on, because the register fixture the later specs share is built
    // through this same path.
    await api.setSelfSignup(request, stack.baseUrl, true);
  }
});
