import type { Page } from "@playwright/test";

import { expect, test } from "../src/fixtures";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import {
  parseOtpauthUri,
  secondsLeftInStep,
  totpCode,
  type TotpParameters,
} from "../src/totp";

/**
 * Exit criterion 2, tagged @webauthn.
 *
 * The administrator signs in with a password, enrols a passkey and an
 * authenticator app, signs out, and signs back in - once with the second
 * factor, and once with the passkey alone.
 *
 * The passkey half runs on Chromium only. A virtual authenticator is a Chrome
 * DevTools Protocol feature, so there is no engine-independent way to answer a
 * WebAuthn prompt without a physical key in someone's hand.
 */

test.describe.configure({ mode: "serial" });

/** Enrolled below and removed again at the end of the same test. */
const PASSKEY_NAME = "Testenhet";

/**
 * Attaches a virtual authenticator to the page.
 *
 * Resident keys and user verification are both on, so the credential is
 * discoverable: signing in with it asks for no email address, which is the
 * property that makes a passkey phishing-resistant and is exactly what this
 * spec is here to prove.
 */
async function attachVirtualAuthenticator(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function signInWithPassword(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/**
 * Waits for a fresh time step when the current one is nearly over.
 *
 * A code generated in the last second of a step is verified in the next one and
 * rejected, which looks like a broken assertion rather than the race it is.
 */
async function waitForFreshStep(parameters: TotpParameters): Promise<void> {
  const left = secondsLeftInStep(parameters);
  if (left < 3) {
    await new Promise((done) => setTimeout(done, (left + 1) * 1000));
  }
}

test("@webauthn a passkey and an authenticator app are enrolled, and both sign in", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await attachVirtualAuthenticator(page);

  // --- password -------------------------------------------------------------
  await signInWithPassword(page);
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  // --- enrol a passkey ------------------------------------------------------
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Inloggning och säkerhet" }),
  ).toBeVisible();

  await page.getByLabel("Namn på enheten").fill(PASSKEY_NAME);
  await page.getByRole("button", { name: "Lägg till nyckel" }).click();
  await expect(page.getByText("Nyckeln är tillagd.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Ta bort nyckeln ${PASSKEY_NAME}` }),
  ).toBeVisible();

  // --- enrol an authenticator app -------------------------------------------
  // The screen shows the otpauth:// link as text rather than a QR code, which
  // is what makes this readable without a camera.
  await page.getByLabel("Ditt lösenord").fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Slå på autentiseringsapp" }).click();

  const uriElement = page.locator("code").filter({ hasText: "otpauth://" });
  await expect(uriElement).toBeVisible();
  const uri = (await uriElement.innerText()).trim();
  const totp = parseOtpauthUri(uri);

  await waitForFreshStep(totp);
  await page.getByLabel("Kod från appen").fill(totpCode(totp));
  await page.getByRole("button", { name: "Bekräfta koden" }).click();
  await expect(page.getByText("Autentiseringsappen är på.")).toBeVisible();

  await signOut(page);

  // --- password now demands the second factor -------------------------------
  await signInWithPassword(page);
  await expect(
    page.getByText(
      "Ange koden från din autentiseringsapp för att slutföra inloggningen.",
    ),
  ).toBeVisible();

  await waitForFreshStep(totp);
  await page.getByLabel("Engångskod").fill(totpCode(totp));
  await page.getByRole("button", { name: "Slutför inloggningen" }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  await signOut(page);

  // --- the passkey signs in on its own --------------------------------------
  // No email address is typed, and no one-time code is asked for: a passkey is
  // phishing-resistant, so it is not gated behind the authenticator app.
  await page.getByRole("button", { name: "Logga in med en nyckel" }).click();
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // --- put the account back the way the other specs expect it ---------------
  // The criterion is proved above. Leaving the authenticator app enrolled would
  // mean every later spec signing in as this administrator had to carry a
  // one-time code, which would say nothing about what those specs are for.
  await page.goto("/settings");
  await page.getByLabel("Ditt lösenord").fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Slå av" }).click();
  await expect(page.getByText("Autentiseringsappen är av.")).toBeVisible();

  // The key goes with it. It is a credential on the shared administrator
  // account, and a run against a stack that was not recreated would otherwise
  // add a second one under the same name and leave both behind.
  await page
    .getByRole("button", { name: `Ta bort nyckeln ${PASSKEY_NAME}` })
    .click();
  await expect(page.getByText("Inga nycklar än.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Ta bort nyckeln ${PASSKEY_NAME}` }),
  ).toHaveCount(0);
});

test("a wrong password is refused without saying which half was wrong", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);

  await page.goto("/sign-in");
  await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
  await page
    .getByLabel("Lösenord", { exact: true })
    .fill("inte-losenordet-alls");
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  await expect(page.getByRole("status")).toContainText(
    "De uppgifterna fungerade inte.",
  );
  await expect(page).toHaveURL(/\/sign-in$/);
});
