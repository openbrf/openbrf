import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { clearMailbox, waitForMessage } from "../src/mailpit";
import {
  activationTokenFrom,
  ensureInstance,
  signInAsAdministrator,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Exit criterion 4.
 *
 * With the toggle on, a visitor asks for an account by typing an address and an
 * apartment number as free text, the board approves it, and the account
 * activates. With the toggle off the endpoint is closed.
 *
 * The free text matters and is not laziness in the form: the request is made
 * before anyone has signed in, so it must not let a stranger discover which
 * addresses and apartments the cooperative has. The board matches the claim
 * against the register when it approves, which is the point at which someone
 * who knows the building is looking.
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
    const chosen = apartments.find((candidate) => candidate.number === "1203");
    expect(chosen).toBeDefined();
    return { address: storgatan12!, apartment: chosen! };
  });

  // The page's own request context has no session: this is a stranger at the
  // front door, not the board.
  const submitted = await api.submitSignupRequest(page.request, stack.baseUrl, {
    firstName: APPLICANT.firstName,
    lastName: APPLICANT.lastName,
    email: APPLICANT.email,
    claimedAddress: `${apartment.address.street} ${apartment.address.number}`,
    claimedApartmentNumber: apartment.apartment.number,
  });
  expect(submitted.status).toBe(202);
  expect(submitted.id).toBeDefined();

  const pending = await api.listSignupRequests(request, stack.baseUrl);
  const waiting = pending.find((entry) => entry.email === APPLICANT.email);
  expect(waiting, "the request is in the board's queue").toBeDefined();
  expect(waiting!.claimedAddress).toBe(
    `${apartment.address.street} ${apartment.address.number}`,
  );
  expect(waiting!.claimedApartmentNumber).toBe(apartment.apartment.number);

  await api.approveSignupRequest(request, stack.baseUrl, waiting!.id, {
    apartmentId: apartment.apartment.id,
    role: "RESIDENT",
  });

  // Approval sends the ordinary invitation, so activation is the same path an
  // invited person walks.
  const { text } = await waitForMessage(APPLICANT.email);
  await api.acceptInvitation(request, stack.baseUrl, {
    token: activationTokenFrom(text),
    password: APPLICANT.password,
  });

  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(APPLICANT.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(APPLICANT.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
});

test("with the toggle off the endpoint is closed", async ({
  page,
  api: request,
}) => {
  await signInAsAdministrator(request);
  await api.setSelfSignup(request, stack.baseUrl, false);

  try {
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
