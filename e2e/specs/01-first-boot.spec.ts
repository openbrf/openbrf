import * as api from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { clearMailbox } from "../src/mailpit";
import {
  ADDRESSES,
  ADMINISTRATOR,
  HOUSING_COOPERATIVE,
} from "../src/provision";

/**
 * Exit criterion 1.
 *
 * First boot serves the setup wizard, and completing it creates the housing
 * cooperative, its two addresses, their apartments, the email settings and the
 * first administrator account.
 *
 * This spec has to run first, and against an instance nobody has claimed: an
 * instance is unclaimed exactly once, and every later spec claims it. The
 * suite's global setup recreates the stack's volumes for that reason, and the
 * file name orders it ahead of the rest.
 */

test.describe.configure({ mode: "serial" });

test("first boot walks the wizard and claims the instance", async ({
  page,
  api: request,
}) => {
  // Seven screens, two addresses and forty-two apartments in one test, because
  // the criterion is the whole walk rather than any one screen of it.
  test.setTimeout(180_000);
  await clearMailbox();

  const before = await api.setupState(request, stack.baseUrl);
  expect(
    before.setupRequired,
    "the instance is already claimed - the suite needs a stack with fresh volumes",
  ).toBe(true);

  // An unclaimed instance sends every visitor to the wizard, whatever they
  // asked for.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Kom i gång med Open BRF" }),
  ).toBeVisible();

  // --- the administrator account -------------------------------------------
  await page
    .getByLabel("Förnamn", { exact: true })
    .fill(ADMINISTRATOR.firstName);
  await page
    .getByLabel("Efternamn", { exact: true })
    .fill(ADMINISTRATOR.lastName);
  await page
    .getByLabel("E-postadress", { exact: true })
    .fill(ADMINISTRATOR.email);
  // The label wraps the hint text as well, so the accessible name is longer
  // than the word on the screen.
  await page.getByLabel(/^Lösenord/).fill(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Skapa kontot" }).click();

  // --- the housing cooperative ---------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Föreningen", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Namn", { exact: true }).fill(HOUSING_COOPERATIVE.name);
  await page
    .getByLabel("Organisationsnummer")
    .fill(HOUSING_COOPERATIVE.organizationNumber);
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // --- the addresses --------------------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Adresser", exact: true }),
  ).toBeVisible();
  for (const address of ADDRESSES) {
    await page.getByLabel("Gata", { exact: true }).fill(address.street);
    await page.getByLabel("Nummer", { exact: true }).fill(address.number);
    await page
      .getByLabel("Postnummer", { exact: true })
      .fill(address.postalCode);
    await page.getByLabel("Ort", { exact: true }).fill(address.city);
    await page.getByRole("button", { name: "Lägg till adress" }).click();
    await expect(
      page.getByRole("button", {
        name: `Ta bort ${address.street} ${address.number}`,
      }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // --- the apartments -------------------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Lägenheter", exact: true }),
  ).toBeVisible();
  for (const address of ADDRESSES) {
    // By role rather than by label: the label wraps the select, so its text
    // content carries every option's text as well.
    await page
      .getByRole("combobox", { name: "Adress" })
      .selectOption({ label: `${address.street} ${address.number}` });
    await page.getByLabel("Lägsta våning").fill("0");
    await page.getByLabel("Antal våningar").fill(String(address.floors));
    await page
      .getByLabel("Lägenheter per våning")
      .fill(String(address.perFloor));
    await page.getByRole("button", { name: "Generera" }).click();
    await page.getByRole("button", { name: "Spara lägenheterna" }).click();
    await expect(
      page.getByText(`Lade till ${String(address.floors * address.perFloor)}`),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // --- email ----------------------------------------------------------------
  // Pointed at the suite's SMTP server, which is what makes the invitation and
  // sign-in link criteria observable at all.
  await expect(
    page.getByRole("heading", { name: "E-post", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Server", { exact: true }).fill(stack.smtpHost);
  await page.getByLabel("Port", { exact: true }).fill(String(stack.smtpPort));
  await page.getByLabel("Avsändaradress").fill("noreply@eksemplet.test");
  await page.getByRole("button", { name: "Spara", exact: true }).click();
  await expect(page.getByText("E-post är inställt.")).toBeVisible();
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // --- appearance -----------------------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Utseende", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Primärfärg").fill("#7D5F23");
  await page.getByRole("button", { name: "Spara", exact: true }).click();
  await page.getByRole("button", { name: "Fortsätt" }).click();

  // --- finish ---------------------------------------------------------------
  await expect(
    page.getByRole("heading", { name: "Föreningen är konfigurerad" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Slutför" }).click();

  // The wizard hands over to the application, signed in as the administrator
  // it just created.
  await expect(page).toHaveURL(new RegExp(`^${stack.baseUrl}/$`));
  await expect(page.getByRole("heading", { name: "Adressbok" })).toBeVisible();

  // Signed in as the administrator the wizard just created. The top band shows
  // a generic label rather than the cooperative's own name today, so the name
  // is checked against the instance below instead of read off the screen.
  await expect(
    page.getByText(`${ADMINISTRATOR.firstName} ${ADMINISTRATOR.lastName}`),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Inställningar" })).toBeVisible();
});

test("the wizard closes once the instance is claimed", async ({
  page,
  api: request,
}) => {
  const state = await api.setupState(request, stack.baseUrl);
  expect(state.setupRequired).toBe(false);

  // A first-boot wizard that stayed open would be a way to create an account on
  // an instance holding a statutory register.
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: "Konfigurationen är redan klar" }),
  ).toBeVisible();
});

test("the wizard created the register it said it did", async ({
  api: request,
}) => {
  await api.signIn(request, stack.baseUrl, {
    email: ADMINISTRATOR.email,
    password: ADMINISTRATOR.password,
  });

  const settings = await api.settings(request, stack.baseUrl);
  expect(settings.housingCooperative.name).toBe(HOUSING_COOPERATIVE.name);
  expect(settings.housingCooperative.organizationNumber).toBe(
    HOUSING_COOPERATIVE.organizationNumber,
  );
  expect(settings.housingCooperative.setupCompletedAt).not.toBeNull();
  // Email is what makes invitations and sign-in links possible at all, so the
  // wizard is not finished until it is set.
  expect(settings.smtp.configured).toBe(true);
  expect(settings.smtp.host).toBe(stack.smtpHost);

  const addresses = await api.listAddresses(request, stack.baseUrl);
  expect(addresses).toHaveLength(ADDRESSES.length);

  for (const address of ADDRESSES) {
    const created = addresses.find(
      (candidate) =>
        candidate.street === address.street &&
        candidate.number === address.number,
    );
    expect(created, `${address.street} ${address.number}`).toBeDefined();

    const apartments = await api.listApartments(
      request,
      stack.baseUrl,
      created!.id,
    );
    expect(apartments).toHaveLength(address.floors * address.perFloor);
    // Lantmateriet numbering: 1000 + floor * 100 + index.
    expect(apartments.map((apartment) => apartment.number)).toContain("1001");
    expect(apartments.map((apartment) => apartment.number)).toContain("1101");
  }
});
