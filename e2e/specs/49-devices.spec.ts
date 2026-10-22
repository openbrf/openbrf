import { expect, stack, test, clientAddressFor } from "../src/fixtures";
import {
  deviceTokenRevoked,
  removeDeviceToken,
  seedDeviceToken,
} from "../src/devices";
import { uniqueSurname } from "../src/identity";
import { ADMINISTRATOR, ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The board's devices screen (ADR 0031).
 *
 * A screen in the stairwell holds a device token the board issued from a
 * plugin's own screen, and the board has to be able to cut it from the core
 * whatever that plugin's screen says. This is the proof on a deployed
 * instance: the token is listed with the board's name for the device, and
 * revoking it from here revokes the row.
 */

test("the board sees a device holding a token and revokes it", async ({
  browser,
  clientAddress,
  api: request,
}) => {
  await ensureInstance(request);

  const label = uniqueSurname("Entré B");
  const seeded = await seedDeviceToken({
    pluginId: uniqueSurname("e2e-devices").toLowerCase(),
    label,
    issuedByEmail: ADMINISTRATOR.email,
  });

  const board = await browser.newContext({
    baseURL: stack.baseUrl,
    locale: "sv-SE",
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "board"),
    },
  });
  const page = await board.newPage();

  try {
    await page.goto(appPath("/sign-in"));
    await page.getByLabel("E-postadress").fill(ADMINISTRATOR.email);
    await page
      .getByLabel("Lösenord", { exact: true })
      .fill(ADMINISTRATOR.password);
    await page.getByRole("button", { name: "Logga in", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Översikt" }),
    ).toBeVisible();

    // Reached from the website's own screen, which is where it is offered.
    await page.goto(appPath("/admin/site"));
    await page.getByRole("link", { name: "Enheter", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Enheter" }),
    ).toBeVisible();

    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(
      page.getByText(seeded.pluginId, { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: `Återkalla token för ${label}` })
      .click();
    await page
      .getByRole("button", { name: "Återkalla token", exact: true })
      .click();

    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    expect(await deviceTokenRevoked(seeded.tokenId)).toBe(true);
  } finally {
    await board.close();
    await removeDeviceToken(seeded);
  }
});
