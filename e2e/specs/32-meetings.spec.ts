import type { APIRequestContext, Page } from "@playwright/test";

import * as api from "../src/api";
import { type ClaimedApartment, claimApartment } from "../src/apartments";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import {
  ADDRESSES,
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The general meeting, through the browser.
 *
 * Not one of the numbered exit criteria. It is here because everything this
 * module decides is a statute about who a person is on a stated day, and none of
 * it can be checked without a browser, the API and a real member register in the
 * same room.
 *
 * ## Who has a vote, and why this spec writes its own members
 *
 * The voting register asks the member register (medlemsforteckning) about the
 * day the meeting is held, and nothing else. That register is written by a
 * move-in with a tenant-ownership rather than by a residency, so the shared
 * fixture's people - who are put on their apartments through sign-up approval -
 * hold no entry in it and have no vote at a meeting. This spec therefore moves
 * three members of its own in, which is the act that writes the register, and
 * reads the voting register against them.
 *
 * That distinction is the module's central fact rather than a detail of the
 * fixture: a residency says somebody lives here, and only the member register
 * says who may vote. Nils Lindqvist from the shared fixture lives in an
 * apartment and holds no tenant-ownership, and he is the person the platform
 * must refuse at the door.
 *
 * ## What these tests are about
 *
 * That the voting register is derived rather than stored, and derived from what
 * the board has actually recorded: one vote per membership (EFL 6 kap. 3 § with
 * BRL 9 kap. 14 § 1), a proxy holder's authority measured against the meeting
 * day, and a count that moves as people are checked in.
 *
 * That somebody who is not a member on the meeting day is refused with the rule
 * named, rather than being quietly absent from the register.
 *
 * That the association's own bylaws reach the refusal. The proxy limit is
 * recorded by an administrator in settings and read back by the meeting screen
 * refusing a second authority - which is what makes it the association's clause
 * rather than the platform's.
 *
 * That issuing the notice settles what the meeting deals with (EFL 6 kap. 22 §
 * with 25 §): the agenda stops being editable.
 *
 * That a decision is minuted only once the meeting has been recorded as held,
 * with the counts the chair declared and no tally computed here.
 *
 * ## One meeting per test
 *
 * Each test arranges its own, on its own day. The meetings list is ordered by
 * the day, every control that names a meeting carries it, and an attendance line
 * belongs to one meeting - so the tests cannot read each other's state, and a
 * count asserted here is a fact about this test's meeting rather than about
 * whatever another one left behind.
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

/**
 * From the shared fixture: a MEMBER-role residency at 12/1001, and an account.
 *
 * She is here for the motion she puts to a meeting, which is a right the
 * residency's role carries (EFL 6 kap. 15 §). She holds no member register entry
 * and therefore no vote, which is why she is not one of the members below.
 */
const SUBMITTER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * Her household at the same apartment, recorded RESIDENT.
 *
 * The person the platform has to refuse at check-in. He lives here and holds no
 * tenant-ownership, and EFL 6 kap. 2-3 §§ give the right to attend and the vote
 * to a member.
 */
const LODGER = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * The three people this spec writes into the member register.
 *
 * Surnames unique to the run, per `src/identity.ts`: a member register entry
 * cannot be taken back, so a fixed name describes a different person on the
 * second run against one database.
 */
const PRESENT_MEMBER = {
  firstName: "Ester",
  lastName: uniqueSurname("Vallin"),
} as const;

const ABSENT_MEMBER = {
  firstName: "Bertil",
  lastName: uniqueSurname("Norrback"),
} as const;

const SECOND_ABSENT_MEMBER = {
  firstName: "Dagny",
  lastName: uniqueSurname("Solberg"),
} as const;

/** The day the three were moved in on, comfortably before any meeting here. */
const HELD_FROM = "2026-01-15";

/** The day every proxy authorisation in this spec is signed. */
const SIGNED_ON = "2028-04-01";

const [STORGATAN_12] = ADDRESSES;

function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`;
}

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`. The authentication endpoints are
 * rate-limited per client address, and sharing one would make the suite throttle
 * itself and read as flaky.
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
 * Starts from a browser holding no session. These tests act as two people on one
 * page and `browseAs` changes only the forwarded-for header, so a second call
 * would arrive still carrying the first person's cookie - and /sign-in's route
 * guard sends a visitor who already has a session to the address book, leaving
 * this function filling in a form that is no longer there.
 *
 * The wait belongs here rather than to the callers: clicking only starts the
 * sign-in, so a caller that navigates on the next line cancels the request in
 * flight and the guard sends the browser back to the form.
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

/** The identifiers this spec's fixture hands back. */
interface MeetingPeople {
  readonly present: string;
  readonly absent: string;
  readonly secondAbsent: string;
  readonly lodger: string;
}

/**
 * Moves this spec's three members in, once however often this is asked for.
 *
 * Over HTTP rather than through the move-in screen: that flow is criterion 8's,
 * and what this spec is about is the voting register the move-in makes possible.
 * The look-up first is what lets any one test in this file be run on its own
 * against a stack that is already up.
 *
 * A tenant-ownership with its transfer, because that is the act that writes the
 * member register - a residency alone does not, and a person with only one has
 * no vote at a meeting.
 */
async function createMembers(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
): Promise<MeetingPeople> {
  const lodger = people.get(LODGER.name);
  if (lodger === undefined) {
    throw new Error(`${LODGER.name} is not in the register fixture`);
  }

  const move = async (person: {
    firstName: string;
    lastName: string;
  }): Promise<string> => {
    const existing = await api.findPersonIdByName(
      request,
      stack.baseUrl,
      fullName(person),
    );
    if (existing !== undefined) {
      return existing;
    }

    const apartment: ClaimedApartment = await claimApartment(
      request,
      STORGATAN_12.number,
    );
    const personId = await api.createPerson(request, stack.baseUrl, {
      firstName: person.firstName,
      lastName: person.lastName,
    });
    await api.moveIn(request, stack.baseUrl, {
      personId,
      apartmentId: apartment.id,
      role: "MEMBER",
      movedInOn: HELD_FROM,
      transfer: {
        transferredOn: HELD_FROM,
        agreementReference: `OVL-2026-${apartment.number}`,
      },
    });
    return personId;
  };

  return {
    present: await move(PRESENT_MEMBER),
    absent: await move(ABSENT_MEMBER),
    secondAbsent: await move(SECOND_ABSENT_MEMBER),
    lodger,
  };
}

/**
 * One value per worker process, and the suite runs in a single worker.
 *
 * Memoised on the promise rather than on the result, so two tests starting at
 * once share one move-in rather than racing to claim two apartments for one
 * person.
 */
let seeded: Promise<MeetingPeople> | undefined;

/**
 * The instance every test here expects: the register fixture, an account for the
 * two people who sign in, and this spec's three members.
 *
 * Called once at the top of each test and never twice within one, which matters
 * on both counts.
 *
 * It has to be called every time, because Playwright gives each test a request
 * context of its own holding no session and `ensureInstance` is what signs it in
 * as the administrator - so a fixture memoised whole would leave a later test's
 * own API calls answered 401.
 *
 * And it must not be called twice in one test: a second sign-in on a context
 * that already holds a session is refused for a missing origin, which is a
 * failure three files away from anything this spec is about. Which is why the
 * accounts are ensured here rather than by a helper each test calls beside this
 * one.
 *
 * Only the move-ins are memoised. They are the part that writes the member
 * register, and that register cannot be written twice for one person.
 */
async function ensureMeetingFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<MeetingPeople> {
  const people = await ensureRegisterFixture(request);

  for (const [person, persona] of [
    [SUBMITTER, "member"],
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

  seeded ??= createMembers(request, people);
  return seeded;
}

/**
 * A day of its own for each test.
 *
 * Distinct days rather than one shared: the meetings list is ordered by the day
 * and every control that names a meeting carries it, so two meetings on one day
 * would leave a test opening whichever of them the list happened to put first.
 * Every one of them is inside the year after {@link SIGNED_ON}, which is the
 * window EFL 6 kap. 4 § allows an authorisation.
 */
function meetingDay(offset: number): string {
  return `2028-05-${String(10 + offset).padStart(2, "0")}`;
}

/** The panel whose level-2 heading reads exactly this. */
function panel(page: Page, heading: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/**
 * Arranges a meeting through the screen and opens it.
 *
 * The board's own path rather than a seeded row: what these tests are about is
 * the screen, and a meeting written over HTTP would leave the arranging half
 * untested while every test depended on it.
 */
async function arrangeAndOpen(page: Page, heldOn: string): Promise<string> {
  await page.goto(appPath("/meetings"));

  const list = panel(page, "Föreningens stämmor");
  await expect(list).toBeVisible();
  await list.getByLabel("Dag då den hålls").fill(heldOn);

  /*
   * Wait for the write itself rather than for the confirmation. "Sparat" is a
   * state the panel leaves as soon as the list it changed arrives again, so
   * whether it is still on screen is a race with a read that answers in a few
   * hundred milliseconds - which is how a test like this failed in CI while
   * passing locally.
   */
  const arranged = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/meetings") &&
      response.request().method() === "POST",
  );
  await list.getByRole("button", { name: "Planera in stämman" }).click();

  const created = await arranged;
  expect(created.status()).toBe(201);

  // The screen opens the new meeting itself, so the panels below are what says
  // the read landed.
  await expect(
    page.getByRole("heading", { name: "Röstlängden" }),
  ).toBeVisible();

  // The identifier the server gave it, for the one assertion that has to name
  // this meeting among several rather than describe it.
  return ((await created.json()) as { id: string }).id;
}

/**
 * The row for the meeting held on this day.
 *
 * Found by the machine-readable date rather than by the words on the controls.
 * Those carry the day as a person reads it - "lordag 20 maj 2028" - which is
 * right for a screen reader and wrong for a spec: matching it would keep a
 * second copy of the client's date formatting here, and would break on a locale
 * change that is no business of this file.
 */
function meetingRow(page: Page, heldOn: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.locator(`time[datetime="${heldOn}"]`) });
}

/** Opens a meeting already on the list, by the day it is held. */
async function openMeetingOn(page: Page, heldOn: string): Promise<void> {
  await page.goto(appPath("/meetings"));
  await meetingRow(page, heldOn)
    .getByRole("button", { name: /^Öppna/u })
    .click();
  await expect(
    page.getByRole("heading", { name: "Röstlängden" }),
  ).toBeVisible();
}

/** Writes one agenda item and saves the running order. */
async function writeAgenda(page: Page, title: string): Promise<void> {
  const agenda = panel(page, "Dagordningen");
  /*
   * Exact, because every control on the row names the item it acts on - "Flytta
   * punkt 1 uppat", "Ta bort punkt 1" - and each of those has to, since one row
   * offers the same three buttons as every other. Only the field itself is
   * called just "Punkt 1".
   */
  await agenda.getByLabel("Punkt 1", { exact: true }).fill(title);

  const saved = page.waitForResponse(
    (response) =>
      /\/api\/meetings\/[^/]+\/agenda$/u.test(response.url()) &&
      response.request().method() === "PUT",
  );
  await agenda.getByRole("button", { name: "Spara dagordningen" }).click();
  expect((await saved).status()).toBe(200);
}

/**
 * Records one person as present, and answers with what the server said.
 *
 * The status is returned rather than asserted, because one test here is about a
 * check-in being refused and about what the refusal says.
 */
async function checkIn(
  page: Page,
  personId: string,
  capacity: string,
): Promise<number> {
  const checkInPanel = panel(page, "Avprickning");
  await checkInPanel.getByLabel("Vem som är närvarande").selectOption(personId);
  await checkInPanel.getByLabel("I vilken egenskap").selectOption(capacity);

  const recorded = page.waitForResponse(
    (response) =>
      /\/api\/meetings\/[^/]+\/attendances$/u.test(response.url()) &&
      response.request().method() === "POST",
  );
  await checkInPanel
    .getByRole("button", { name: "Anteckna som närvarande" })
    .click();
  return (await recorded).status();
}

/** Registers one authority, and answers with what the server said. */
async function registerProxy(
  page: Page,
  input: { memberPersonId: string; proxyHolderPersonId: string },
): Promise<number> {
  const proxies = panel(page, "Fullmakter");
  await proxies
    .getByLabel("Medlem som ger fullmakten")
    .selectOption(input.memberPersonId);
  await proxies.getByLabel("Ombud").selectOption(input.proxyHolderPersonId);
  /*
   * The day the member signed it, which is what EFL 6 kap. 4 § measures the year
   * from - and the server measures that year against the meeting day rather than
   * against today.
   */
  await proxies.getByLabel("Dag då medlemmen skrev under").fill(SIGNED_ON);

  const registered = page.waitForResponse(
    (response) =>
      /\/api\/meetings\/[^/]+\/proxy-authorisations$/u.test(response.url()) &&
      response.request().method() === "POST",
  );
  await proxies.getByRole("button", { name: "Registrera fullmakten" }).click();
  return (await registered).status();
}

/** Signs the browser in as the administrator, on their own client address. */
async function signInAsTheBoard(
  page: Page,
  clientAddress: string,
): Promise<void> {
  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(
    page,
    ADMINISTRATOR.email,
    ADMINISTRATOR.password,
  );
}

test.describe("the general meeting", () => {
  test("the board arranges a meeting, writes its agenda and reads the register", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    await arrangeAndOpen(page, meetingDay(1));
    await writeAgenda(page, "Val av styrelse");

    /*
     * The register is drawn from the member register as of the meeting day, so
     * the three people this spec moved in are on it - by name, which the
     * meetings API does not supply: it answers with identifiers, and the screen
     * reads the address book for the names.
     */
    const register = panel(page, "Röstlängden");
    await expect(register).toContainText(fullName(PRESENT_MEMBER));
    await expect(register).toContainText(fullName(ABSENT_MEMBER));
    await expect(register).toContainText(fullName(SECOND_ABSENT_MEMBER));

    // Nobody is in the room yet. This meeting is this test's own, so the count
    // is a fact about it rather than about whatever another test left behind.
    await expect(register.getByText("Rösten närvarande")).toHaveCount(0);

    expect(await checkIn(page, people.present, "MEMBER")).toBe(201);

    // One vote, and only one: a check-in is one membership arriving.
    await expect(register.getByText("Rösten närvarande")).toHaveCount(1);
    await expect(panel(page, "Avprickning")).toContainText(
      fullName(PRESENT_MEMBER),
    );
  });

  test("somebody who is not a member on the day is refused, and told which rule", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The statutory assertion of this file, with both halves in one test so the
     * contrast is real rather than assumed. Ester holds a tenant-ownership and
     * is in the member register; Nils lives in an apartment and holds none, so
     * EFL 6 kap. 2-3 §§ give him no vote and the platform must not record one.
     *
     * He is offered in the picker all the same, and deliberately: who may be
     * checked in is the server's answer about a stated day, and a screen that
     * decided for itself would be a second opinion on the statute formed from
     * residencies as they stand today.
     *
     * And the refusal names the rule rather than answering with the shared
     * sentence about permissions. It is a 403, and a board member at a door told
     * their account is not allowed would go looking for somebody to grant them
     * something.
     */
    const people = await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    await arrangeAndOpen(page, meetingDay(2));

    expect(await checkIn(page, people.present, "MEMBER")).toBe(201);
    const checkInPanel = panel(page, "Avprickning");
    await expect(checkInPanel).toContainText(fullName(PRESENT_MEMBER));

    expect(await checkIn(page, people.lodger, "MEMBER")).toBe(403);
    await expect(checkInPanel).toContainText(
      "Medlemsförteckningen visar inte den här personen som medlem",
    );

    /*
     * He is on no line of the list, and the rows are what is asserted rather
     * than the panel: he is still in the picker beside every other person the
     * address book holds, which is the point of the paragraph above. What must
     * not happen is a line recording him as present.
     */
    await expect(
      checkInPanel.getByRole("listitem").filter({ hasText: LODGER.name }),
    ).toHaveCount(0);
  });

  test("somebody who lives here is not offered the meeting screen at all", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * `meetings:manage` is the board's and is not derived from membership, which
     * makes it the opposite of motions:submit. What a member holds at a general
     * meeting is the right to attend, speak and vote, and none of that happens
     * on this platform - the meeting is in a room. So living here opens no door
     * to this screen, and neither does a tenant-ownership.
     *
     * Nils is the account it is asserted through, because he holds nothing but a
     * residency. The other half - that a membership opens it no more than a
     * residency does - is pinned where the capability model can be stated
     * exactly rather than inferred from whatever an instance has accumulated:
     * `apps/web/src/shell/nav-items.test.ts` asserts that motions:submit and
     * motions:handle both reach the motions destination and neither reaches this
     * one.
     *
     * Both halves of what a browser can say are asserted here: the navigation,
     * because a link to a screen that can only refuse teaches somebody a part of
     * the product is broken for them; and the screen itself reached by hand,
     * which is the assertion that would still hold if the navigation were
     * rebuilt tomorrow.
     */
    await ensureMeetingFixture(request, clientAddress);
    await browseAs(page, clientAddress, "lodger");
    await signInThroughTheScreen(page, LODGER.email, LODGER.password);

    // Somewhere he does belong, so the band is loaded and its links are the
    // ones this account is offered. `.first()` because the shell renders the
    // same links twice, once for the band and once for the bottom bar.
    await page.goto(appPath("/issues"));
    await expect(
      page.getByRole("link", { name: "Ärenden", exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Stämmor" })).toHaveCount(0);

    await page.goto(appPath("/meetings"));
    await expect(
      page.getByRole("heading", { name: "Föreningsstämmor" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Föreningens stämmor" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Planera in stämman" }),
    ).toHaveCount(0);
  });

  test("a proxy authorisation puts an absent member's vote in the room", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    await arrangeAndOpen(page, meetingDay(3));

    /*
     * Bertil authorises Ester, who is another member - the statute's own ground,
     * needing no bylaws clause (BRL 9 kap. 14 § 4).
     */
    expect(
      await registerProxy(page, {
        memberPersonId: people.absent,
        proxyHolderPersonId: people.present,
      }),
    ).toBe(201);

    const proxies = panel(page, "Fullmakter");
    await expect(proxies).toContainText("företräder");
    await expect(proxies).toContainText(fullName(ABSENT_MEMBER));

    /*
     * Registering the authority is not exercising it. Nobody is in the room, so
     * the register carries no vote present - which is the distinction the whole
     * module rests on: representation, never a transfer of the vote.
     */
    const register = panel(page, "Röstlängden");
    await expect(register.getByText("Rösten närvarande")).toHaveCount(0);

    // The proxy holder has to be checked in, in that capacity. Then Bertil's
    // vote is present and the register says whose hand exercises it.
    expect(await checkIn(page, people.present, "PROXY_HOLDER")).toBe(201);
    await expect(register.getByText("Rösten närvarande")).toHaveCount(1);
    await expect(register).toContainText("Utövas av");
  });

  test("the bylaws' proxy limit reaches the refusal", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The clause is the association's own, and the only way it can reach a
     * meeting is by having been recorded. This is the whole path: the instance
     * starts at the statutory one member per proxy holder, a second authority is
     * refused against it, an administrator records a wider clause in settings,
     * and the same act is then accepted.
     *
     * Restored over HTTP in the finally, so the shared instance is left as the
     * later specs and the screenshot capture expect it.
     */
    const people = await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    try {
      await api.setMeetingBylaws(
        request,
        stack.baseUrl,
        api.STATUTORY_MEETING_BYLAWS,
      );

      await arrangeAndOpen(page, meetingDay(4));

      const proxies = panel(page, "Fullmakter");
      // The panel states the rule in force before anybody meets it, which is
      // what a board registering an authority at a door needs.
      await expect(proxies).toContainText("1 medlem");

      expect(
        await registerProxy(page, {
          memberPersonId: people.absent,
          proxyHolderPersonId: people.present,
        }),
      ).toBe(201);

      // The second one, refused against the association's own clause.
      expect(
        await registerProxy(page, {
          memberPersonId: people.secondAbsent,
          proxyHolderPersonId: people.present,
        }),
      ).toBe(403);
      await expect(proxies).toContainText(
        "företräder redan så många medlemmar som stadgarna tillåter",
      );

      // The administrator records a wider clause.
      await page.goto(appPath("/settings"));
      const bylaws = panel(page, "Föreningsstämman enligt stadgarna");
      await expect(bylaws).toBeVisible();
      await bylaws.getByLabel(/^Medlemmar per ombud/u).fill("2");

      const stored = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/settings/meeting-bylaws") &&
          response.request().method() === "PUT",
      );
      await bylaws.getByRole("button", { name: "Spara" }).click();
      expect((await stored).status()).toBe(200);

      // And the same act is accepted, which is what makes the clause the
      // association's rather than the platform's.
      await openMeetingOn(page, meetingDay(4));
      const reopened = panel(page, "Fullmakter");
      await expect(reopened).toContainText("2 medlem");

      expect(
        await registerProxy(page, {
          memberPersonId: people.secondAbsent,
          proxyHolderPersonId: people.present,
        }),
      ).toBe(201);
      await expect(reopened).toContainText("Fullmakten är registrerad.");
    } finally {
      await api.setMeetingBylaws(
        request,
        stack.baseUrl,
        api.STATUTORY_MEETING_BYLAWS,
      );
    }
  });

  test("issuing the notice settles what the meeting deals with", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    await arrangeAndOpen(page, meetingDay(5));

    // A notice states the matters the meeting is to deal with, so a meeting with
    // an empty agenda has nothing to summon anybody for (EFL 6 kap. 22 §).
    const notice = panel(page, "Kallelsen");
    await expect(notice).toContainText("Skriv dagordningen först");

    await writeAgenda(page, "Ansvarsfrihet för styrelsen");

    await notice.getByLabel("Börjar").fill("18:00");
    await notice.getByLabel("Plats").fill("Föreningslokalen");

    const issued = page.waitForResponse(
      (response) =>
        /\/api\/meetings\/[^/]+\/notice$/u.test(response.url()) &&
        response.request().method() === "POST",
    );
    await notice.getByRole("button", { name: "Utfärda kallelsen" }).click();
    expect((await issued).status()).toBe(201);

    // The notice is a record afterwards, with its delivery ledger beside it.
    // There is no route that edits or withdraws one, because EFL 6 kap. 25 §'s
    // remedy for a notice that went wrong is an extra general meeting.
    await expect(notice).toContainText("Föreningslokalen");
    await expect(
      notice.getByRole("button", { name: "Utfärda kallelsen" }),
    ).toHaveCount(0);

    /*
     * And the agenda is fixed from that moment. The form is gone and the rule
     * holding is said in words, because a board reading "you cannot change this"
     * needs to know which of the two rules it is: one of them is answered by
     * arranging another meeting, and the other is not answered at all.
     */
    const agenda = panel(page, "Dagordningen");
    await expect(
      agenda.getByRole("button", { name: "Spara dagordningen" }),
    ).toHaveCount(0);
    await expect(agenda).toContainText(
      "Kallelsen till den här stämman är utfärdad",
    );
    await expect(agenda).toContainText("Ansvarsfrihet för styrelsen");
  });

  test("a motion is put to a meeting and its member is told which", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * EFL 6 kap. 15 § gives the member the right to have their item taken up at
     * a general meeting, so "which meeting, and when" is the answer that right
     * is actually about - and a member told only that the board received the
     * item has been told the smaller half.
     */
    await ensureMeetingFixture(request, clientAddress);

    // The member's item, put in through the browser as she would.
    const title = `Laddstolpar i garaget ${String(Date.now())}`;
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, SUBMITTER.email, SUBMITTER.password);
    await page.goto(appPath("/motions"));
    await page.getByLabel("Vad du föreslår, på en rad").fill(title);
    await page
      .getByLabel("Förslaget")
      .fill("Föreningen bör utreda vad laddstolpar skulle kosta.");
    await page.getByRole("button", { name: "Skicka motionen" }).click();
    await expect(
      page.getByRole("button", { name: `Återkalla motionen ${title}` }),
    ).toBeVisible();

    // The board arranges a meeting for it to be taken up at.
    const day = meetingDay(6);
    await signInAsTheBoard(page, clientAddress);
    const meetingId = await arrangeAndOpen(page, day);

    await page.goto(appPath("/motions"));
    /*
     * Scoped to the board's own panel rather than to the page. An account can
     * hold both halves of this screen - a board member who is also a member is
     * the ordinary case in a cooperative - and the same motion then has a row in
     * each, with the queue's above. Naming the panel is what a person does when
     * they read the screen.
     */
    const queue = panel(page, "Motioner från medlemmarna");
    const queued = queue
      .getByRole("listitem")
      .filter({ hasText: title })
      .first();
    await expect(queued).toBeVisible();

    const attached = page.waitForResponse(
      (response) =>
        /\/api\/motion-queue\/[^/]+\/meeting$/u.test(response.url()) &&
        response.request().method() === "PUT",
    );
    await queued
      .getByLabel("Tas upp på")
      .selectOption({ label: `Ordinarie föreningsstämma ${day}` });
    expect((await attached).status()).toBe(200);

    /*
     * Read back from the queue rather than from the answer to the write, and by
     * the control's value rather than by the row's text: the row carries the
     * select, so every meeting the board could still choose is in that text and
     * a search for one of them would pass before anything had been chosen.
     *
     * That it is still a control is the other half of what this asserts. The
     * notice for this meeting has not been issued, so the board may still move
     * the item - EFL 6 kap. 22 § with 25 § is what takes that away, and it has
     * not happened yet.
     */
    await expect(
      queue
        .getByRole("listitem")
        .filter({ hasText: title })
        .first()
        .getByLabel("Tas upp på"),
    ).toHaveValue(meetingId);

    // And the member is told, on her own list, which meeting takes it up. Her
    // own panel by name, for the reason the queue is named above.
    await browseAs(page, clientAddress, "member");
    await signInThroughTheScreen(page, SUBMITTER.email, SUBMITTER.password);
    await page.goto(appPath("/motions"));
    await expect(
      panel(page, "Dina motioner")
        .getByRole("listitem")
        .filter({ hasText: title })
        .first(),
    ).toContainText(`Tas upp på Ordinarie föreningsstämma den ${day}`);
  });

  test("a decision is minuted once the meeting has been recorded as held", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureMeetingFixture(request, clientAddress);
    await signInAsTheBoard(page, clientAddress);

    const day = meetingDay(7);
    await arrangeAndOpen(page, day);
    await writeAgenda(page, "Arvode till styrelsen");
    expect(await checkIn(page, people.present, "MEMBER")).toBe(201);

    // Nothing may be minuted before the meeting has been held: the server
    // refuses it, so the panel is a statement rather than a form.
    const decisions = panel(page, "Vad stämman beslutade");
    await expect(decisions).toContainText(
      "Ett beslut antecknas när stämman har hållits",
    );
    await expect(decisions.getByLabel("För")).toHaveCount(0);

    const held = page.waitForResponse(
      (response) =>
        /\/api\/meetings\/[^/]+\/conclusion$/u.test(response.url()) &&
        response.request().method() === "POST",
    );
    await meetingRow(page, day)
      .getByRole("button", { name: /som hållen$/u })
      .click();
    /*
     * 201, which is what Nest answers a POST with unless the route says
     * otherwise - and this one does not. Nothing is created: the act writes a
     * date on the meeting. The status is asserted as it is rather than as it
     * ought to be, because what this test is about is the screen.
     */
    expect((await held).status()).toBe(201);

    /*
     * The hinge of the whole screen, in both directions at once: the decisions
     * open and check-in closes, because from here the list of who was present is
     * the record of a meeting that has happened.
     */
    await expect(decisions.getByLabel("För")).toBeVisible();
    await expect(
      panel(page, "Avprickning").getByRole("button", {
        name: "Anteckna som närvarande",
      }),
    ).toHaveCount(0);

    // The counts the chair declared, transcribed and never tallied here.
    await decisions.getByLabel("För").fill("2");
    await decisions.getByLabel("Mot").fill("1");
    await decisions.getByLabel("Avstår").fill("0");

    const minuted = page.waitForResponse(
      (response) =>
        /\/api\/meetings\/[^/]+\/agenda\/[^/]+\/decision$/u.test(
          response.url(),
        ) && response.request().method() === "PUT",
    );
    await decisions
      .getByRole("button", {
        name: "Anteckna beslutet om Arvode till styrelsen",
      })
      .click();
    expect((await minuted).status()).toBe(200);

    // Read back from the meeting rather than from the write's own answer.
    await expect(decisions).toContainText("Bifallen");
    await expect(decisions).toContainText("För 2, mot 1, avstår 0");
  });
});
