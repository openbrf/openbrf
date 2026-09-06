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
 * What the association has to be able to show as controller, through a browser.
 *
 * Not one of the numbered exit criteria. It is here because the records GDPR
 * asks a controller to keep are only worth anything if a board can actually keep
 * them, and every property below is one that no unit test can reach: a clock
 * running against a real database, a refusal a board reads as a sentence, a
 * heading that ends up on a page a visitor with no account can load.
 *
 * Four things are driven here.
 *
 * The 72 hours of art. 33(1) are counted from discovery and not from when
 * somebody sat down to write the breach up, so a breach discovered days ago is
 * over the bound the moment it is entered - and the decision on it will not save
 * without the reasons for the delay that paragraph requires.
 *
 * A recipient of personal data is classified before any agreement is asked for.
 * The association's own disk is a recipient the instance can already tell the
 * board is no processor at all; who runs the machine is one only the board
 * knows.
 *
 * The privacy notice is measured against what art. 13 requires, and the one
 * thing the product will write on it is the association's own contact details -
 * which a visitor with no account then reads on the published page. That last
 * step is the whole point: art. 13 is owed to the person, not to the board's
 * screen.
 *
 * And a person's own request is decided against the register rather than
 * against a form. Erasure is refused while they still live here, because the
 * exception in art. 17(3) is the association's statutory duty to keep the
 * record - and the board reads that as a sentence rather than as a validation
 * error.
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

/** From the shared fixture: 12/1001, and a member who still lives here. */
const MEMBER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/** How the association is reached as controller, for the notice to print. */
const CONTROLLER_EMAIL = "dataskydd@granngarden.test";

type Persona = "administrator" | "member";

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
 * Starts from a browser holding no session, for the reason spec 30 gives: this
 * file acts as two people on one page, and a second call would otherwise arrive
 * carrying the first one's cookie, leaving this function filling in a form the
 * route guard has already navigated away from.
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
  await page.getByRole("button", { name: "Logga in", exact: true }).click();

  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${email} answered ${String(response.status())}`,
  ).toBe(true);
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

/**
 * The instance every test here expects: the register fixture and an account for
 * the member whose own request one of them records.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 */
async function ensureDataProtectionFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<ReadonlyMap<string, string>> {
  const people = await ensureRegisterFixture(request);

  const personId = people.get(MEMBER.name);
  if (personId === undefined) {
    throw new Error(`${MEMBER.name} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId,
    email: MEMBER.email,
    password: MEMBER.password,
    clientAddress: clientAddressFor(clientAddress, "member"),
  });

  return people;
}

/** A title unique to this run, so a screen opening one finds one breach. */
function breachTitle(label: string): string {
  return `${label} ${String(Date.now())}`;
}

/** The row a panel renders for one named thing. */
function rowFor(page: Page, name: string) {
  return page.getByRole("listitem").filter({ hasText: name }).first();
}

/**
 * What the screen calls each kind of recipient.
 *
 * A mail server names itself and so does a bucket, but the association's own
 * disk and whoever runs the machine have no name the instance can read, and
 * the panel calls those rows by their kind instead. The spec has to know the
 * same rule to find them, so it states it once here rather than hard-coding a
 * label at each use.
 */
const PROCESSOR_KIND_LABEL: Record<api.ProcessorRow["processorKind"], string> =
  {
    SMTP: "E-postserver",
    SMS: "SMS-gateway",
    STORAGE: "Fillagring",
    HOSTING: "Drift",
    PLUGIN: "Tillägg",
    EXTERNAL: "Antecknad av styrelsen",
  };

/** The name the screen shows for one recipient. */
function nameOf(processor: api.ProcessorRow): string {
  return processor.identity ?? PROCESSOR_KIND_LABEL[processor.processorKind];
}

test.describe("the board's own data protection records", () => {
  test("a breach inside its 72 hours is counted from discovery and decided", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    const title = breachTitle("Utskick till fel mottagare");
    await api.recordPersonalDataBreach(request, stack.baseUrl, {
      title,
      description: "Ett utskick gick till en adresslista som inte var vår.",
      // Twelve hours ago: inside the bound, and far enough from it that the
      // strip's rounded hours cannot land on the boundary.
      discoveredAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
      dataDescription: "Namn och adresser ur medlemsförteckningen.",
      effects: "Mottagaren kunde läsa namn och adresser.",
      measures: "Utskicket återkallades och mottagaren ombads radera det.",
    });

    await page.goto(appPath("/data-protection"));

    // The strip says what is waiting, in a sentence and with the time left on
    // the nearest bound - not a number over a label.
    await expect(
      page.getByText(
        /personuppgiftsincident väntar på beslut, \d+ timmar kvar/,
      ),
    ).toBeVisible();

    await page
      .getByRole("button", { name: `Fatta beslut om ${title}` })
      .click();

    await page
      .getByRole("combobox", { name: "Risk för de registrerade" })
      .selectOption("LIKELY");
    await page.getByLabel("IMY ska underrättas").check();
    await page
      .getByLabel("Skäl för beslutet om IMY")
      .fill("Incidenten medför en risk för de registrerade.");
    await page.getByLabel("De registrerade ska underrättas").check();
    await page.getByRole("button", { name: "Spara beslutet" }).click();

    // Decided, and the strip is quiet again. The second half matters as much as
    // the first: a board with nothing waiting has to be told so, because an
    // empty strip reads as a screen that has not finished loading.
    await expect(rowFor(page, title)).toContainText("Beslutad");
    await expect(
      page.getByText("Ingen personuppgiftsincident väntar på beslut."),
    ).toBeVisible();
  });

  test("a notification after 72 hours will not save without the reasons for the delay", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * Art. 33(1): where the notification is not made within 72 hours, it shall
     * be accompanied by the reasons for the delay. The record is what carries
     * them, so a decision that says IMY was notified late and offers no reason
     * is refused - and refused at the moment the board is looking at the form,
     * rather than accepted into a register that would then be missing the one
     * thing the paragraph asks for.
     */
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    const title = breachTitle("Bärbar dator borta ur styrelserummet");
    await api.recordPersonalDataBreach(request, stack.baseUrl, {
      title,
      description: "En dator med medlemsuppgifter saknas.",
      // Five days ago. The clock runs from discovery, so this is over the bound
      // the moment it is written up - which is the ordinary case, because a
      // board writes an incident up after it has dealt with it.
      discoveredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      dataDescription: "Medlemsförteckningens namn och adresser.",
      effects: "Uppgifterna kan ha kommit i orätta händer.",
      measures: "Datorn spärrades och polisanmälan gjordes.",
    });

    await page.goto(appPath("/data-protection"));

    await expect(
      page.getByText(
        /personuppgiftsincident(er)? har passerat 72-timmarsgränsen utan beslut/,
      ),
    ).toBeVisible();
    await expect(rowFor(page, title)).toContainText("Över tiden");

    await page
      .getByRole("button", { name: `Fatta beslut om ${title}` })
      .click();

    await page
      .getByRole("combobox", { name: "Risk för de registrerade" })
      .selectOption("HIGH");
    await page.getByLabel("IMY ska underrättas").check();
    await page
      .getByLabel("Skäl för beslutet om IMY")
      .fill("Hög risk för de registrerade.");
    await page
      .getByLabel("Underrättad till IMY")
      // What a datetime-local control holds: the reader's own wall clock, to
      // the minute. The screen turns it into an instant before it is sent.
      .fill(new Date().toISOString().slice(0, 16));
    await page.getByLabel("De registrerade ska underrättas").check();
    await page.getByRole("button", { name: "Spara beslutet" }).click();

    // Refused, and as a sentence naming what the paragraph asks for.
    await expect(
      page.getByText(
        "En underrättelse efter 72 timmar ska åtföljas av skälen för dröjsmålet.",
      ),
    ).toBeVisible();
    await expect(rowFor(page, title)).toContainText("Över tiden");

    await page
      .getByLabel("Skäl för dröjsmålet (art. 33.1)")
      .fill("Styrelsen kunde inte sammanträda förrän nu.");
    await page.getByRole("button", { name: "Spara beslutet" }).click();

    await expect(rowFor(page, title)).toContainText("Beslutad");
  });

  test("every recipient of personal data is classified before an agreement is asked for", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The list is derived from the deployment rather than typed in, so what this
     * test asserts is that the board can get through it - not how long it is.
     * How many rows there are is a property of the stack this runs against, so
     * the count comes from the instance and the walk classifies whatever it
     * finds.
     */
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    const processors = await api.listProcessors(request, stack.baseUrl);
    expect(processors.map((processor) => processor.processorKind)).toContain(
      "HOSTING",
    );

    await page.goto(appPath("/data-protection"));

    for (const processor of processors) {
      if (processor.state !== "notRecorded") {
        continue;
      }

      const name = nameOf(processor);
      await page.getByRole("button", { name: `Klassificera ${name}` }).click();

      /*
       * Storage on the instance's own disk is the one row the instance can
       * already answer, so the board confirms rather than researches. Everything
       * else - the mail server, and whoever runs the machine - is a recipient
       * this cooperative deals with on the association's instructions, which is
       * what a processor is.
       */
      const ownDisk = processor.processorKind === "STORAGE";
      await page
        .getByRole("combobox", { name: "Klassificering" })
        .selectOption(ownDisk ? "NOT_A_PROCESSOR" : "PROCESSOR");

      if (ownDisk) {
        await page
          .getByLabel("Varför inget avtal behövs")
          .fill("Filerna ligger på föreningens egen disk.");
      } else {
        await page.getByLabel("Motpart").fill(name);
        await page
          .getByRole("combobox", { name: "Avtalets status" })
          .selectOption("PENDING");
      }

      await page.getByRole("button", { name: "Spara", exact: true }).click();
      await expect(
        rowFor(page, name).getByText("Ej klassificerad"),
      ).toHaveCount(0);
    }

    // Nothing left unanswered, said as a sentence.
    await expect(
      page.getByText("Alla mottagare av personuppgifter är klassificerade."),
    ).toBeVisible();
  });

  test("the notice gains the association's contact details, and a visitor reads them", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The end of art. 13 that matters. A coverage panel saying the notice is
     * complete is the board's own comfort; what the article actually requires is
     * that the person can find out who the controller is and how to reach them,
     * without an account and without asking.
     */
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    await api.setDataProtectionContacts(request, stack.baseUrl, {
      controller: {
        contactEmail: CONTROLLER_EMAIL,
        postalAddress: "Granngården 1, 123 45 Solna",
      },
    });

    await page.goto(appPath("/data-protection"));

    // The panel is a check and not a second editor: it names what art. 13 asks
    // for and whether the page answers it.
    await expect(
      page.getByRole("heading", { name: "Integritetspolicyn" }),
    ).toBeVisible();
    await expect(
      page.getByText("Vilka som tar del av uppgifterna"),
    ).toBeVisible();

    const append = page.getByRole("button", {
      name: "Lägg till rubrikerna som saknas",
    });
    if ((await append.count()) > 0) {
      await append.click();
      await expect(append).toHaveCount(0);
    }

    // And now the half that no screen can assert: the published page, read by
    // somebody with no session at all.
    const visitor = await page.context().browser()?.newContext();
    if (visitor === undefined) {
      throw new Error("the browser did not give this test a second context");
    }
    try {
      const anonymous = await visitor.newPage();
      await anonymous.setExtraHTTPHeaders({
        "x-forwarded-for": clientAddressFor(clientAddress, "visitor"),
      });
      await anonymous.goto(`${stack.baseUrl}/integritetspolicy`);
      await expect(anonymous.getByText(CONTROLLER_EMAIL)).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test("an erasure is refused while the person still lives here, and the ground is recorded", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * Art. 17(3): erasure does not apply where the processing is necessary for
     * compliance with a legal obligation. For a housing cooperative that is the
     * member register, which BRL requires it to keep - so a member who still
     * lives here cannot be erased out of it, and the board has to be able to say
     * that in the record rather than merely decline.
     */
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    await page.goto(appPath("/register"));
    await page.getByLabel("Sök i registret").fill("Lindqvist");
    await page.getByRole("button", { name: `Öppna ${MEMBER.name}` }).click();
    await expect(
      page.getByRole("heading", { name: MEMBER.name }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Anteckna en begäran" }).click();
    await page
      .getByRole("combobox", { name: "Vad personen begär" })
      .selectOption("ERASURE");
    await page
      .getByLabel("Personens egen grund")
      .fill("Jag vill inte finnas kvar hos föreningen.");
    await page
      .getByRole("combobox", { name: "Grund enligt art. 17.1" })
      .selectOption("NO_LONGER_NECESSARY");
    await page.getByRole("button", { name: "Spara", exact: true }).click();

    // Recorded, waiting, and carrying the day art. 12(3) gives the board.
    await expect(page.getByText("Väntar på svar")).toBeVisible();
    await expect(page.getByText(/Ska besvaras senast/)).toBeVisible();

    await page.getByRole("button", { name: "Fatta beslut" }).click();
    await page
      .getByRole("combobox", { name: "Beslut", exact: true })
      .selectOption("GRANTED");
    await page
      .getByRole("combobox", { name: "Bedömning enligt art. 17.3" })
      .selectOption("NONE");
    await page
      .getByLabel("Styrelsens skäl")
      .fill("Styrelsen bifaller begäran.");
    await page.getByRole("button", { name: "Spara", exact: true }).click();

    // Refused by the register, and said as a sentence a board can act on.
    await expect(
      page.getByText(
        "Personen bor kvar. Uppgifterna behövs så länge boendet pågår.",
      ),
    ).toBeVisible();

    await page
      .getByRole("combobox", { name: "Beslut", exact: true })
      .selectOption("REFUSED");
    await page
      .getByRole("combobox", { name: "Bedömning enligt art. 17.3" })
      .selectOption("LEGAL_OBLIGATION_TO_KEEP");
    await page
      .getByLabel("Styrelsens skäl")
      .fill("Medlemsförteckningen får inte gallras.");
    await page.getByRole("button", { name: "Spara", exact: true }).click();

    await expect(page.getByText("Avslagen")).toBeVisible();
  });

  test("a resident takes what they gave the association with them", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * Art. 20, from the person's own side. It is on their profile rather than on
     * the board's screen, because it is theirs to exercise and needs nobody's
     * decision - and it is a file handed over rather than a transfer, because
     * art. 20(2) requires a direct one only where technically feasible and no
     * receiving standard exists between housing cooperative platforms.
     */
    await ensureDataProtectionFixture(request, clientAddress);
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, MEMBER.email, MEMBER.password);

    await page.goto(appPath("/settings"));

    const exported = page.waitForResponse(
      (response) =>
        response.url().includes("/api/data-portability/mine") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Hämta mina uppgifter" }).click();

    const response = await exported;
    expect(
      response.ok(),
      `the export answered ${String(response.status())}`,
    ).toBe(true);

    const body = (await response.json()) as Record<string, unknown>;
    const serialised = JSON.stringify(body);

    // What she gave the association is in it.
    expect(serialised).toContain("Astrid");
    // And what she did not is not: the statutory registers, the audit trail and
    // the personal identity number are outside art. 20 by definition, because
    // none of them was provided by her under a contract or a consent.
    expect(serialised).not.toContain("personalIdentityNumber");
    expect(serialised).not.toContain("auditEntries");
    expect(serialised).not.toContain("legalHolds");
  });
});
