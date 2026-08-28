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

/** Enrolled below and removed again before the test ends, pass or fail. */
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

/**
 * Takes both second factors off the shared administrator account.
 *
 * They are enrolled on the account rather than in the browser, so they outlive
 * the test that made them. An authenticator app left switched on makes every
 * later spec's password sign-in ask for a one-time code, and a passkey left
 * behind is a second credential under the same name the next time this runs
 * against a stack that was not recreated.
 *
 * It therefore runs from a `finally`, which means it may start from a failed
 * page and a session that was signed out three steps ago, and it has to put the
 * account back anyway. What it cannot do is reported with a soft assertion: the
 * test still fails, but it fails with whatever broke first rather than with the
 * tidy-up that followed.
 *
 * `passkeyEnrolled` and `authenticatorOn` say what this run actually left on
 * the account, which is what tells a cleanup with nothing to remove from one
 * that has stopped finding what it removes.
 */
async function removeSecondFactors(
  page: Page,
  totp: TotpParameters | undefined,
  passkeyEnrolled: boolean,
  authenticatorOn: boolean,
): Promise<void> {
  try {
    await page.goto("/settings");

    // Signed out, or signed in: the route is closed without a session, so one
    // of the two is what rendered.
    const security = page.getByRole("heading", {
      name: "Inloggning och säkerhet",
    });
    const signInButton = page.getByRole("button", {
      name: "Logga in",
      exact: true,
    });
    await expect(security.or(signInButton)).toBeVisible();

    if (await signInButton.isVisible()) {
      await signInWithPassword(page);

      // The one-time code is asked for only if the enrolment above got as far
      // as switching the authenticator app on.
      const code = page.getByLabel("Engångskod");
      const signedIn = page.getByRole("heading", { name: "Adressbok" });
      await expect(code.or(signedIn)).toBeVisible();
      if (totp !== undefined && (await code.isVisible())) {
        await waitForFreshStep(totp);
        await code.fill(totpCode(totp));
        await page
          .getByRole("button", { name: "Slutför inloggningen" })
          .click();
        // Waited for, not fired and forgotten: navigating away while the
        // request is still in flight cancels it and lands back on /sign-in.
        await expect(signedIn).toBeVisible();
      }

      await page.goto("/settings");
    }
    await expect(security).toBeVisible();

    // The security screen fills in from a request, and isVisible() does not
    // retry: read before that answer arrives it reports no authenticator app
    // on an account that has one, the branch below is skipped, and the app is
    // left on for every spec that signs in as this account afterwards - which
    // is a failure five specs later rather than here. When this run switched
    // it on, wait for the control before deciding.
    const switchOff = page.getByRole("button", { name: "Slå av" });
    if (authenticatorOn) {
      await expect(switchOff).toBeVisible();
    }
    if (await switchOff.isVisible()) {
      await page.getByLabel("Ditt lösenord").fill(ADMINISTRATOR.password);
      await switchOff.click();
      await expect(page.getByText("Autentiseringsappen är av.")).toBeVisible();
    }

    // Only the credential this spec enrols, found by the name it gave it. A run
    // after a failed one can find more than one under that name. Other keys on
    // the account are none of this cleanup's business, so it is what it removed
    // that is checked here and not that the list ended up empty.
    const removeKey = page.getByRole("button", {
      name: `Ta bort nyckeln ${PASSKEY_NAME}`,
    });

    // The list starts empty and fills in from a request, so a page that has not
    // answered yet looks exactly like an account with no keys. count() does not
    // retry, so a cleanup that read that first render would remove nothing and
    // still pass every assertion below. When this run enrolled a key, wait for
    // it before counting.
    if (passkeyEnrolled) {
      await expect(removeKey.first()).toBeVisible();
    }

    let removed = 0;
    for (
      let remaining = await removeKey.count();
      remaining > 0;
      remaining -= 1
    ) {
      await removeKey.first().click();
      await expect(removeKey).toHaveCount(remaining - 1);
      removed += 1;
    }
    await expect(removeKey).toHaveCount(0);

    // A cleanup that quietly removes nothing is what leaves a second credential
    // on the shared account, so a run that enrolled one has to account for it.
    if (passkeyEnrolled) {
      expect(
        removed,
        "the key this run enrolled came off the account",
      ).toBeGreaterThan(0);
    }
  } catch (failure) {
    expect
      .soft(failure, "the second factors came off the administrator account")
      .toBeUndefined();
  }
}

test("@webauthn a passkey and an authenticator app are enrolled, and both sign in", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await attachVirtualAuthenticator(page);

  // Declared out here so the cleanup can complete a sign-in that the
  // authenticator app now stands in the way of, whatever went wrong below, and
  // so it knows whether there is a key on the account to take off again.
  let totp: TotpParameters | undefined;
  let passkeyEnrolled = false;
  let authenticatorOn = false;

  try {
    // --- password -----------------------------------------------------------
    await signInWithPassword(page);
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();

    // --- enrol a passkey ----------------------------------------------------
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Inloggning och säkerhet" }),
    ).toBeVisible();

    await page.getByLabel("Namn på enheten").fill(PASSKEY_NAME);
    await page.getByRole("button", { name: "Lägg till nyckel" }).click();
    await expect(page.getByText("Nyckeln är tillagd.")).toBeVisible();
    // Recorded before anything else is asserted: the credential is on the
    // account from here on, so the cleanup has to take it off even if the next
    // line is what fails.
    passkeyEnrolled = true;
    await expect(
      page.getByRole("button", { name: `Ta bort nyckeln ${PASSKEY_NAME}` }),
    ).toBeVisible();

    // --- enrol an authenticator app -----------------------------------------
    // The screen shows the otpauth:// link as text rather than a QR code, which
    // is what makes this readable without a camera.
    await page.getByLabel("Ditt lösenord").fill(ADMINISTRATOR.password);
    await page
      .getByRole("button", { name: "Slå på autentiseringsapp" })
      .click();

    const uriElement = page.locator("code").filter({ hasText: "otpauth://" });
    await expect(uriElement).toBeVisible();
    const uri = (await uriElement.innerText()).trim();
    totp = parseOtpauthUri(uri);

    await waitForFreshStep(totp);
    await page.getByLabel("Kod från appen").fill(totpCode(totp));
    await page.getByRole("button", { name: "Bekräfta koden" }).click();
    await expect(page.getByText("Autentiseringsappen är på.")).toBeVisible();
    // Recorded here rather than where the URI was read: from this line on the
    // account demands a code, and the cleanup has to be certain of that rather
    // than infer it from having got far enough to parse the enrolment.
    authenticatorOn = true;

    await signOut(page);

    // --- password now demands the second factor -----------------------------
    await signInWithPassword(page);
    await expect(
      page.getByText(
        "Ange koden från din autentiseringsapp för att slutföra inloggningen.",
      ),
    ).toBeVisible();

    await waitForFreshStep(totp);
    await page.getByLabel("Engångskod").fill(totpCode(totp));
    await page.getByRole("button", { name: "Slutför inloggningen" }).click();
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();

    await signOut(page);

    // --- the passkey signs in on its own ------------------------------------
    // No email address is typed, and no one-time code is asked for: a passkey is
    // phishing-resistant, so it is not gated behind the authenticator app.
    await page.getByRole("button", { name: "Logga in med en nyckel" }).click();
    await expect(
      page.getByRole("heading", { name: "Adressbok" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    // --- put the account back the way the other specs expect it -------------
    // The criterion is proved above, and what it left behind is a credential
    // and a switched-on authenticator app on the account the specs after this
    // one sign in as. Both come off whether the assertions passed or not.
    await removeSecondFactors(page, totp, passkeyEnrolled, authenticatorOn);
  }
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
