import {
  clearAssociationFacts,
  listAddresses,
  listApartments,
  saveAssociationFacts,
} from "../src/api";
import { expect, stack, test } from "../src/fixtures";
import { ensureInstance, HOUSING_COOPERATIVE } from "../src/provision";

/**
 * The broker information page, as a broker meets it.
 *
 * Not one of the numbered exit criteria. It is here because what this page
 * promises cannot be seen from any screen: a housing cooperative answers a
 * broker out of what its board has recorded and out of nothing else, the
 * questions the board has not answered are not on the page at all, and reading
 * it costs the reader no cookie and runs none of anybody's code. The last of
 * those is a property of the deployed instance and only the deployed instance
 * can be held to it.
 *
 * The facts are recorded over HTTP rather than through the board's own form.
 * The form has its own coverage in the component tests, the criterion here is
 * the page a broker reads, and a browser sign-in the spec does not otherwise
 * need would spend four of this test's twenty requests a minute on setting up
 * somebody else's subject.
 */

test.describe.configure({ mode: "serial" });

/** Set in the order they are read on the page. */
const FACTS = {
  propertyDesignation: "Talgoxen 4",
  buildYear: 1948,
  landLeasehold: false,
  feeIncludes: "Värme, vatten och bredband ingår i avgiften.",
  transferFeePolicy: "2,5 % av prisbasbeloppet, betalas av köparen.",
  legalPersonOwners: false,
  renovations: "Stambyte 2019\nFasadrenovering 2023",
} as const;

test("the page exists before the board has recorded a single fact", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await clearAssociationFacts(request, stack.baseUrl);

  await page.goto("/maklarinfo");

  await expect(
    page.getByRole("heading", { name: "Mäklarinformation" }),
  ).toBeVisible();
  // The association's own legal-person facts: what a broker is sent the
  // address for, and what makes this worth answering with before the board has
  // filled anything in.
  await expect(page.getByText(HOUSING_COOPERATIVE.name).first()).toBeVisible();
  await expect(
    page.getByText(HOUSING_COOPERATIVE.organizationNumber, { exact: true }),
  ).toBeVisible();

  // No label, no dash, no "not recorded". The person reading this page cannot
  // fill the gap in, so naming it would be raising a question at them.
  for (const label of [
    "Fastighetsbeteckning",
    "Byggår",
    "Marken",
    "Överlåtelseavgift",
    "Juridisk person som medlem",
  ]) {
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  }
});

test("what the board records is what the page says", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await saveAssociationFacts(request, stack.baseUrl, FACTS);

  await page.goto("/maklarinfo");

  await expect(
    page.getByText(FACTS.propertyDesignation, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1948", { exact: true })).toBeVisible();
  await expect(
    page.getByText(FACTS.feeIncludes, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(FACTS.transferFeePolicy, { exact: true }),
  ).toBeVisible();

  // A yes or a no is published as the sentence it means, so it stands on its
  // own wherever a broker copies it to.
  await expect(
    page.getByText("Föreningen äger marken", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Godkänns inte", { exact: true })).toBeVisible();

  // The line breaks the board typed are the only structure the text has.
  await expect(page.getByText("Stambyte 2019", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Fasadrenovering 2023", { exact: true }),
  ).toBeVisible();

  /*
   * How many apartments the association has: a count, and the whole of what
   * this page takes from the register's side of the line. Counted from the
   * register rather than written down here, so the assertion stays about the
   * page rather than about which fixture ran first.
   */
  let apartments = 0;
  for (const address of await listAddresses(request, stack.baseUrl)) {
    apartments += (await listApartments(request, stack.baseUrl, address.id))
      .length;
  }
  expect(apartments).toBeGreaterThan(0);

  await expect(
    page.getByText("Antal lägenheter", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(String(apartments), { exact: true }),
  ).toBeVisible();
  // Not one apartment number, on a page generated beside a register full of
  // them.
  await expect(page.getByText("1001", { exact: true })).toHaveCount(0);

  // Still nothing about the questions that were left alone.
  await expect(
    page.getByText("Pantsättningsavgift", { exact: true }),
  ).toHaveCount(0);
});

test("a fact the board takes back comes off the page", async ({
  page,
  api: request,
}) => {
  await ensureInstance(request);
  await saveAssociationFacts(request, stack.baseUrl, {
    parking: "Tolv platser i garaget, kö hos styrelsen.",
  });

  await page.goto("/maklarinfo");
  await expect(page.getByText("Parkering", { exact: true })).toBeVisible();

  await saveAssociationFacts(request, stack.baseUrl, { parking: "" });

  await page.goto("/maklarinfo");
  await expect(page.getByText("Parkering", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Tolv platser i garaget, kö hos styrelsen.", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("reading it tells nobody anything and runs nothing", async ({
  page,
  context,
  api: request,
}) => {
  await ensureInstance(request);

  const requested: string[] = [];
  page.on("request", (outgoing) => {
    requested.push(outgoing.url());
  });

  await page.goto("/maklarinfo");
  await expect(
    page.getByRole("heading", { name: "Mäklarinformation" }),
  ).toBeVisible();

  // Origins rather than prefixes: the part before an "@" in a URL is userinfo,
  // not a host, so a string comparison is the wrong instrument here.
  const instance = new URL(stack.baseUrl).origin;
  for (const url of requested) {
    expect(new URL(url).origin, url).toBe(instance);
  }

  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await context.cookies()).toEqual([]);

  const response = await request.get(`${stack.baseUrl}/maklarinfo`, {
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toContain("text/html");
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  // A generated page is a page: it sets no cookie either.
  expect(headers["set-cookie"]).toBeUndefined();
  expect((await response.text()).includes("<script")).toBe(false);
});

test("the address cannot be taken by a page written at it", async ({
  api: request,
}) => {
  await ensureInstance(request);

  // Both spellings are the router's. A page written at either would never be
  // reached, so the board is told the address is taken rather than quietly
  // getting a page nobody can open.
  for (const slug of ["maklarinfo", "broker"]) {
    const refused = await request.post(`${stack.baseUrl}/api/site/pages`, {
      data: {
        slug,
        title: "Egen sida",
        content: { blocks: [] },
        visibility: "PUBLIC",
      },
      failOnStatusCode: false,
    });

    expect(refused.status(), slug).toBe(400);
    expect(((await refused.json()) as { reason: string }).reason, slug).toBe(
      "invalid-slug",
    );
  }
});
