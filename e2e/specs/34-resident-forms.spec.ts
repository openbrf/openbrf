import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { clientAddressFor, expect, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The two resident-initiated forms, through the browser.
 *
 * Not one of the numbered exit criteria. They are here because each module's
 * central property is a statement about who a person is, and it only exists once
 * a browser, the API and a real register are in the same room.
 *
 * The shared register fixture holds two people in the same apartment: Astrid
 * Lindqvist as MEMBER and Nils Lindqvist as RESIDENT. They live at the same
 * address, they sign in the same way, and the platform has to answer them
 * differently for one of these forms and identically for the other.
 *
 * BRL 7 kap. 10 § forsta stycket lets a bostadsrattshavare let "sin lagenhet" in
 * andra hand for sjalvstandigt brukande only with the board's consent, so
 * subletting is Astrid's and not Nils's. Nothing in BRL or EFL gives anybody a
 * right to a key, so ordering one is the household's and Nils holds it exactly
 * as she does. Those two facts are the first three tests below, and the contrast
 * between them is the point: neither decision follows from the other.
 *
 * The rest is what the board does with what arrives - it reads each queue and
 * records its answer - and the one thing the board records that is not its own
 * decision: BRL 7 kap. 11 § lets the rent tribunal permit a letting the board
 * refused, and the platform cannot know that unless somebody writes it down. So
 * it is written down beside the refusal and changes nothing else.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this spec's own invention would fail that probe,
 * fall through to an invitation, and be refused for an account that already
 * exists.
 */
const PASSWORD = "granngarden-kastanj-2026";

/** From the shared fixture: 12/1001, and a member. Subletting is hers. */
const MEMBER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * Her household at the same apartment, recorded RESIDENT rather than MEMBER.
 *
 * The whole point of the pair. He lives here and holds no tenant-ownership, so
 * BRL 7 kap. 10 § gives him no application to make - and the platform must not
 * offer him one, because offering it and then refusing the write would be the
 * worse of the two failures. He needs a key to the front door all the same, and
 * gets one.
 */
const LODGER = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`.
 *
 * The authentication endpoints are rate-limited per client address, and the
 * fixture gives each test one - on the reading that a test is one member signing
 * in from their own home. These tests act as up to three people each, and
 * sharing one address would make the suite throttle itself and read as flaky. It
 * is not a way around the limit: each person still gets one budget, and what
 * this stops is one person's traffic spending another's.
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
 * screen.
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
async function ensureFormsFixture(
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

/**
 * A sentence unique to this run, so a screen opening a shared queue finds one
 * row.
 *
 * The queues here are the whole instance's and every spec shares it, so nothing
 * below asserts on a total: what each test does is find its own row by the words
 * it wrote and assert against that.
 */
function unique(label: string): string {
  return `${label} ${String(Date.now())}`;
}

/** The panel with this heading, so a label is looked for inside it and not on the page. */
function panel(page: Page, heading: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: heading }) });
}

/**
 * One row, inside the named panel.
 *
 * Both screens here render a member's own list and the board's queue on the same
 * page, and a board member who also lives in the house sees both - which is the
 * ordinary case in a cooperative. The same words then appear in two rows, so a
 * lookup across the page would find whichever is higher up and assert against a
 * panel the test is not about. Naming the panel is what makes each assertion say
 * which half of the screen it means.
 */
function rowIn(page: Page, heading: string, text: string): Locator {
  return panel(page, heading)
    .getByRole("listitem")
    .filter({ hasText: text })
    .first();
}

/** The panel headings the assertions below name. */
const OWN_SUBLETS = "Dina ansökningar";
const SUBLET_QUEUE = "Ansökningar om andrahandsupplåtelse";
const OWN_KEY_ORDERS = "Dina beställningar";
const KEY_ORDER_QUEUE = "Nyckelbeställningar";

test.describe("subletting applications", () => {
  test("a member asks for consent and can take the request back", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureFormsFixture(request, clientAddress);
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);

    await page.goto(appPath("/sublets"));

    const reason = unique("Provbo pa annan ort");
    const form = panel(page, "Begär styrelsens samtycke");
    await form.getByLabel("Från").fill("2028-02-01");
    await form.getByLabel("Till").fill("2028-08-31");
    await form.getByLabel("Varför du vill hyra ut").fill(reason);
    await form.getByRole("button", { name: "Skicka ansökan" }).click();

    /*
     * The application as the server read it back, not the form having been
     * submitted: the row exists only once the member's own list has come back
     * with it in.
     */
    const row = rowIn(page, OWN_SUBLETS, reason);
    await expect(row).toBeVisible();
    // With the board rather than answered, and carrying the period asked for.
    await expect(row).toContainText("Hos styrelsen");
    await expect(row).toContainText("2028-02-01 - 2028-08-31");

    const withdraw = row.getByRole("button", { name: /^Återkalla ansökan/ });
    await expect(withdraw).toBeVisible();
    await withdraw.click();

    // Withdrawn, and still on the list: the record that she asked is hers, and
    // nothing here deletes a row.
    const withdrawn = rowIn(page, OWN_SUBLETS, reason);
    await expect(withdrawn).toContainText("Återkallad");
    await expect(
      withdrawn.getByRole("button", { name: /^Återkalla ansökan/ }),
    ).toHaveCount(0);
  });

  test("a resident who is not a member is offered no application at all", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The statutory assertion of this file, at the place a person would actually
     * look. Nils lives in the same apartment as Astrid and is recorded RESIDENT,
     * so BRL 7 kap. 10 § gives him nothing here: the consent is about the
     * tenant-ownership, and he holds none.
     *
     * Both halves are asserted. The navigation does not offer the destination,
     * because a link to a screen that can only refuse somebody teaches them a
     * part of the product is broken for them rather than not theirs. And the
     * screen itself, reached directly, offers no form - which is the assertion
     * that would still hold if the navigation were rebuilt tomorrow.
     */
    await ensureFormsFixture(request, clientAddress);
    await browseAs(page, clientAddress, "lodger");
    await signInThroughTheScreen(page, LODGER.email, LODGER.password);

    /*
     * Somewhere he does belong, so the band is loaded and its links are the ones
     * this account is offered. .first() because the shell renders the same links
     * twice, once for the band and once for the bottom bar on a narrow screen.
     */
    await page.goto(appPath("/issues"));
    await expect(
      page.getByRole("link", { name: "Ärenden", exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Andrahand" })).toHaveCount(0);
    // And the key order destination is offered in the same band, which is the
    // contrast this pair of modules exists to make: the same account, two
    // different answers, for two different reasons.
    await expect(
      page.getByRole("link", { name: "Nycklar" }).first(),
    ).toBeVisible();

    // And the screen itself, asked for by hand.
    await page.goto(appPath("/sublets"));
    await expect(
      page.getByRole("heading", { name: "Hyra ut i andra hand" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skicka ansökan" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Varför du vill hyra ut")).toHaveCount(0);
  });

  test("the board refuses, and the rent tribunal's permission is recorded beside it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureFormsFixture(request, clientAddress);

    // The member's request, put in through the browser as she would.
    const reason = unique("Arbete pa annan ort");
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);
    await page.goto(appPath("/sublets"));
    const form = panel(page, "Begär styrelsens samtycke");
    await form.getByLabel("Från").fill("2029-01-01");
    await form.getByLabel("Till").fill("2029-06-30");
    await form.getByLabel("Varför du vill hyra ut").fill(reason);
    await form.getByRole("button", { name: "Skicka ansökan" }).click();
    await expect(rowIn(page, OWN_SUBLETS, reason)).toContainText(
      "Hos styrelsen",
    );

    // The board reads the queue it arrived in.
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );
    await page.goto(appPath("/sublets"));

    const queued = rowIn(page, SUBLET_QUEUE, reason);
    await expect(queued).toBeVisible();
    // Who asked, named to the board and to nobody else.
    await expect(queued).toContainText(MEMBER.name);

    // The ground for the refusal, which BRL 7 kap. 11 § is what makes worth
    // writing: the rent tribunal permits where the association has no befogad
    // anledning to refuse.
    await queued
      .getByLabel("Vad ni vill anteckna med svaret")
      .fill("Foreningen har redan tva upplatelser i uppgangen.");
    await queued.getByRole("button", { name: /^Vägra samtycke/ }).click();

    const refused = rowIn(page, SUBLET_QUEUE, reason);
    await expect(refused).toContainText("Nekad");

    /*
     * And now the fact the platform cannot know. The member went to the
     * hyresnamnden and it permitted the letting; somebody records that, and the
     * row goes on saying the association refused - because it did, and the
     * tribunal permitted. Stated rather than enforced, which is the decision
     * this test exists to pin.
     */
    await refused
      .getByRole("button", { name: /^Anteckna hyresnämndens beslut/ })
      .click();
    const tribunal = rowIn(page, SUBLET_QUEUE, reason);
    await tribunal.getByLabel("Tillstånd från och med").fill("2028-11-15");
    await tribunal.getByLabel("Till och med").fill("2029-06-30");
    await tribunal.getByRole("button", { name: "Spara" }).click();

    const recorded = rowIn(page, SUBLET_QUEUE, reason);
    await expect(recorded).toContainText("2028-11-15");
    // Still refused. A row that had flipped to "Samtycke givet" would be the
    // platform putting words in the board's mouth.
    await expect(recorded).toContainText("Nekad");
    await expect(recorded).not.toContainText("Samtycke givet");

    // And the member reads both facts on her own list.
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);
    await page.goto(appPath("/sublets"));
    const own = rowIn(page, OWN_SUBLETS, reason);
    await expect(own).toContainText("Nekad");
    await expect(own).toContainText("Hyresnämnden lämnade tillstånd");
  });
});

test.describe("key orders", () => {
  test("a resident who is not a member orders a key, and the board hands it over", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The deliberate opposite of the subletting test above, with the same
     * person. Nothing gives anybody a right to a key, so ordering one follows
     * living here rather than holding the tenant-ownership - and Nils, who is
     * offered no subletting application at all, orders a tag exactly as a member
     * would.
     */
    await ensureFormsFixture(request, clientAddress);
    await browseAs(page, clientAddress, "lodger");
    await signInThroughTheScreen(page, LODGER.email, LODGER.password);

    await page.goto(appPath("/key-orders"));

    const note = unique("Till cykelrummet");
    const form = panel(page, "Beställ en nyckel eller en tagg");
    await form.getByLabel("Vad du behöver").selectOption("TAG");
    await form.getByLabel("Hur många").fill("2");
    await form
      .getByLabel("Vilken dörr, eller vad den ska användas till")
      .fill(note);
    await form.getByRole("button", { name: "Skicka beställningen" }).click();

    // The order as the server read it back, with what was ordered on it.
    const row = rowIn(page, OWN_KEY_ORDERS, note);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Hos styrelsen");
    await expect(row).toContainText("2 x Tagg");

    // The board reads the queue it arrived in and records the handover.
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );
    await page.goto(appPath("/key-orders"));

    const queued = rowIn(page, KEY_ORDER_QUEUE, note);
    await expect(queued).toBeVisible();
    await expect(queued).toContainText(LODGER.name);

    /*
     * A decline control the motion queue has no equivalent of, which is the
     * other half of this module's decision: refusing to take up a member's item
     * is not the board's to decide under EFL 6 kap. 15 §, and refusing a
     * household a fourth tag plainly is.
     */
    await expect(
      queued.getByRole("button", { name: /^Neka beställningen/ }),
    ).toBeVisible();

    await queued
      .getByLabel("Vad ni vill anteckna med svaret")
      .fill("Hamtade i styrelserummet.");
    await queued.getByRole("button", { name: /^Anteckna utlämning/ }).click();

    const handed = rowIn(page, KEY_ORDER_QUEUE, note);
    await expect(handed).toContainText("Utlämnad");
    await expect(
      handed.getByRole("button", { name: /^Anteckna utlämning/ }),
    ).toHaveCount(0);

    // And the household reads the board's words on its own list.
    await browseAs(page, clientAddress, "lodger");
    await signInThroughTheScreen(page, LODGER.email, LODGER.password);
    await page.goto(appPath("/key-orders"));
    const own = rowIn(page, OWN_KEY_ORDERS, note);
    await expect(own).toContainText("Utlämnad");
    await expect(own).toContainText("Hamtade i styrelserummet.");
  });
});
