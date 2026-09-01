import {
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

import * as api from "../src/api";
import {
  ensureEventSeries,
  eventSeriesTitled,
  offeredOccurrence,
  signUpFor,
  signupSeries,
} from "../src/events";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
  HOUSING_COOPERATIVE,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The association's event calendar (evenemangskalendern), end to end.
 *
 * Not one of the numbered exit criteria. It is here because the module has two
 * halves that are written in different languages against different audiences -
 * a React screen behind a session, and a server-rendered website with no script
 * on it - and everything this spec asserts lies in the seam between them. Each
 * half has its own unit and integration coverage. What neither of them can say
 * is that the same act reaches both.
 *
 * The board enters two things the association is doing and publishes them to
 * two different audiences: a cleaning day to the street and a board meeting to
 * the members. That is one form, one control, and one field deciding which of
 * the two it is - and the field's default is the members, so a slip cannot put
 * anything on the street.
 *
 * The street then gets exactly one of them. Not "the public one is there",
 * which a calendar showing everything would also satisfy, but the public one is
 * there and the members' one is not, on a page that runs no script, sets no
 * cookie and asks no other company for a single byte. The members' meeting is
 * asked for by its own address and answered with the website's not-found
 * document, byte for byte the same one an address that names nothing produces -
 * and the same address opens for somebody signed in, which is what makes the
 * refusal about the audience rather than about a broken identifier.
 *
 * A resident takes a place at a date and gives it up again, and the count beside
 * the control is the server's answer both times rather than the browser's
 * arithmetic. The last place then goes while somebody is looking at it: they
 * read a sentence, the count they are looking at catches up in the same breath,
 * and nothing was written for them.
 *
 * And the roll-call is where this module names residents. It is the board's, it
 * keeps the people who stood down as people who stood down, and a person with
 * protected personal data is a place on it and never a name.
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
 * Four of the people the shared register fixture seeds.
 *
 * Astrid and Nils live in one apartment on Storgatan 12 and Karl in another
 * house. Nothing about a sign-up is the apartment's - a place at the cleaning
 * day is one person's, which is the whole difference from a booking - so they
 * are three readers here and not two households.
 *
 * Ingrid carries protected personal data (skyddade personuppgifter), and she is
 * in this spec for one assertion: the roll-call is the one list in this module
 * that names residents, and it must not name her.
 */
const OWNER = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

const HOUSEMATE = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

const NEIGHBOUR = {
  name: "Karl Berg",
  email: "karl@eksemplet.test",
  password: PASSWORD,
} as const;

const PROTECTED = {
  name: "Ingrid Persson",
  email: "ingrid@eksemplet.test",
  password: PASSWORD,
} as const;

/*
 * Every person a test acts as gets a client address of their own, from the
 * shared fixtures' `clientAddressFor`.
 *
 * The authentication endpoints are rate-limited per client address, and the
 * fixture gives each test one - on the reading that a test is one member signing
 * in from their own home. These tests act as up to four people each, and sharing
 * one address would spend one person's budget on another's until the instance
 * refuses a sign-in a test is asserting on. It is not a way around the limit:
 * each person still gets one budget, and each of them really is somewhere else.
 */
type Persona =
  | "administrator"
  | "owner"
  | "housemate"
  | "neighbour"
  | "protected"
  | "visitor";

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
 * A signed-in request context of one person's own, for a test's arrangement.
 *
 * Separate from the browser's cookie jar, so the page can stay somebody else
 * throughout. Disposed by the caller.
 */
async function contextFor(
  clientAddress: string,
  who: { email: string; password: string },
  persona: Persona,
): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, persona),
    },
  });
  await api.signIn(context, stack.baseUrl, {
    email: who.email,
    password: who.password,
  });
  return context;
}

/**
 * A request context carrying nothing at all: no session, no language, no cookie.
 *
 * The website is what an anonymous visitor is answered with, and the two
 * requests whose answers are compared byte for byte have to differ in nothing
 * but the address. One context for both is what guarantees that - a second one
 * could be handed a different language, and the document is rendered in the
 * reader's own.
 */
async function anonymousVisitor(
  clientAddress: string,
): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, "visitor"),
    },
  });
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * Starts from a browser holding no session. The tests here act as more than one
 * person on one page, and `browseAs` changes only the forwarded-for header, so a
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
  who: { email: string; password: string },
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await page.getByLabel("E-postadress").fill(who.email);
  await page.getByLabel("Lösenord", { exact: true }).fill(who.password);

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

  // A refusal is named here, with its status, rather than surfacing as a
  // missing control several assertions later.
  const response = await answered;
  expect(
    response.ok(),
    `signing in as ${who.email} answered ${String(response.status())}`,
  ).toBe(true);
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A Stockholm calendar date, `days` from today, as "YYYY-MM-DD".
 *
 * Today is read on the association's clock rather than on this machine's, for
 * the reason the API reads it the same way: just after midnight in Stockholm the
 * two disagree, and the day an event falls on is the building's. The arithmetic
 * on that date is then calendar arithmetic and carries no zone at all - the day
 * after the 25th of October is the 26th, however many hours that Sunday had.
 *
 * Offsets rather than dates, because a date written into a file stops being in
 * the future and the API refuses a sign-up to a date that has begun.
 */
function dayFromToday(days: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const field = (type: "year" | "month" | "day"): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const shifted = new Date(
    Date.UTC(field("year"), field("month") - 1, field("day")) +
      days * MILLISECONDS_PER_DAY,
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * The month a calendar date falls in, as the website's parameter states it.
 *
 * A slice of a calendar date and not a conversion of an instant. Which month a
 * date is in is a question about the association's own calendar, and the date
 * has already been answered on it - reading a month off a UTC instant instead
 * would file a date in the first hours of a month under the month before it for
 * part of the year.
 */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

/**
 * This run's own events, so a rerun against a kept stack reads its own rows.
 *
 * Three of them, one subject per test that signs anybody up, because a sign-up
 * has to be found by the date it was made against. Two tests sharing a series
 * would each be asserting on places the other might have taken.
 *
 * The dates are far enough out that none of them can have begun by the time the
 * suite reaches this file, and inside the six months the resident's calendar
 * reaches so no test has to page anything.
 */
const suffix = Date.now().toString(36);

/**
 * The one published to the street, and the one with a limit on it.
 *
 * Two places, which is the smallest number that lets the last one go while
 * somebody is looking at a control that was offered when it was drawn. One place
 * would make the refusal reachable only by a reader who never saw a control at
 * all, which is not the race a resident meets.
 */
const CLEANING = {
  title: `Städdag ${suffix}`,
  category: "Gemensamt arbete",
  location: "Innergården",
  description:
    "Vi räfsar löv, rensar rabatterna och tömmer grovsoprummet." +
    " Ta med arbetshandskar.",
  firstOn: dayFromToday(21),
  startsAt: "10:00",
  durationMinutes: "180",
  capacity: "2",
} as const;

/**
 * The one kept for the members, and the one nobody signs up to.
 *
 * A board meeting takes no sign-ups, which is the honest shape for it and also
 * the state the resident's calendar states rather than offering a control for.
 */
const MEETING = {
  title: `Styrelsemöte ${suffix}`,
  category: "Styrelsen",
  location: "Föreningslokalen",
  description: "Vi går igenom budgeten och underhållsplanen.",
  firstOn: dayFromToday(28),
  startsAt: "18:30",
  durationMinutes: "120",
} as const;

/**
 * The one the sign-up, the withdrawal and the roll-call happen on.
 *
 * Entered over HTTP by the fixture rather than through the board's form: the
 * form is what the first test is about, and every test after it would otherwise
 * pay for a second sign-in and assert on a form it is not about. Four places, so
 * nothing here is ever refused by a limit - the limit has a test of its own, on
 * the cleaning day, and a refusal has to be unambiguous about which rule
 * produced it.
 */
const SAUNA = {
  title: `Bastukväll ${suffix}`,
  category: "Gemenskap",
  location: "Bastun i källaren",
  description: "Bastun är varm från sju. Ta med handduk.",
  firstOn: dayFromToday(35),
  startsAtMinute: 19 * 60,
  durationMinutes: 120,
  capacity: 4,
} as const;

/** An address shaped like an event's and behind which there is nothing. */
const NO_SUCH_EVENT = "ett-evenemang-som-aldrig-lagts-in";

/**
 * The half of the screen somebody living here reads.
 *
 * Found by its own heading rather than by a class, and scoped because the
 * administrator holds both capabilities and therefore has both halves on one
 * page: a date of a series that takes sign-ups is an article in the attending
 * half and again inside the board's card, and an unscoped match would be
 * ambiguous between them.
 */
function attendPanel(page: Page): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "På gång", exact: true }),
  });
}

/** The half events:manage exists for, found the same way. */
function boardPanel(page: Page): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", {
      level: 2,
      name: "Styrelsens kalender",
      exact: true,
    }),
  });
}

/** One date of one series, as the attending half draws it. */
function attendRow(page: Page, title: string): Locator {
  return attendPanel(page).getByRole("article").filter({ hasText: title });
}

/** One series, as the board's half draws it. */
function boardCard(page: Page, title: string): Locator {
  return boardPanel(page).getByRole("article").filter({ hasText: title });
}

/**
 * The form that enters a series, apart from the ones that edit the existing.
 *
 * Every card renders the same fields as this form does, so from the moment one
 * series is on the calendar "Vad det heter" names several controls. The form is
 * found by the heading it carries, which no card has.
 */
function addForm(page: Page): Locator {
  return page.locator("form").filter({
    has: page.getByRole("heading", { name: "Lägg in ett evenemang" }),
  });
}

/**
 * The instance every test here expects: the register fixture, an account for
 * everybody who signs in, and the sauna evening.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 *
 * The context comes back signed in as the administrator, because ensureInstance
 * - which ensureRegisterFixture calls - signs it in. Do not sign in again here:
 * a second sign-in goes out on a context that already holds the session cookie,
 * and the authentication layer applies its origin check to a cookie-bearing
 * state-changing request, which this context has no Origin to satisfy.
 */
async function ensureEventFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
  const people = await ensureRegisterFixture(request);

  for (const [person, persona] of [
    [OWNER, "owner"],
    [HOUSEMATE, "housemate"],
    [NEIGHBOUR, "neighbour"],
    [PROTECTED, "protected"],
  ] as const) {
    const personId = people.get(person.name);
    if (personId === undefined) {
      throw new Error(`${person.name} is not in the register fixture`);
    }
    await ensureAccountFor(request, {
      personId,
      email: person.email,
      password: person.password,
      // The probe, and on a fresh stack the activation, belong to that person's
      // budget rather than to whatever else this test is about to do.
      clientAddress: clientAddressFor(clientAddress, persona),
    });
  }

  await ensureEventSeries(
    request,
    signupSeries({
      title: SAUNA.title,
      category: SAUNA.category,
      location: SAUNA.location,
      description: SAUNA.description,
      firstOn: SAUNA.firstOn,
      startsAtMinute: SAUNA.startsAtMinute,
      durationMinutes: SAUNA.durationMinutes,
      capacity: SAUNA.capacity,
    }),
    "MEMBER",
  );
}

test("the board enters two events and publishes them to two audiences", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);
  await browseAs(page, clientAddress, "administrator");

  await signInThroughTheScreen(page, ADMINISTRATOR);
  await page.goto(appPath("/events"));

  const form = addForm(page);
  await expect(form).toBeVisible();

  // The cleaning day. The places field appears only once sign-up is offered, so
  // the checkbox comes before it - and that ordering is the form saying that a
  // limit on nothing is not a setting.
  await form.getByLabel("Vad det heter").fill(CLEANING.title);
  await form.getByLabel("Kategori").fill(CLEANING.category);
  await form.getByLabel("Var det är").fill(CLEANING.location);
  await form.getByLabel("Vad det handlar om").fill(CLEANING.description);
  await form.getByLabel("Första datumet").fill(CLEANING.firstOn);
  await form.getByLabel("Börjar").fill(CLEANING.startsAt);
  await form.getByLabel("Minuter").fill(CLEANING.durationMinutes);
  await form
    .getByLabel("Det går att anmäla sig till det här evenemanget")
    .check();
  await form.getByLabel("Platser per tillfälle").fill(CLEANING.capacity);
  await form.getByRole("button", { name: "Lägg in evenemanget" }).click();

  const cleaning = boardCard(page, CLEANING.title);
  await expect(cleaning).toBeVisible();

  /*
   * A draft, and only a draft. Entering a series is not announcing it: the
   * publication is what the audit log records and what the personal identity
   * number scan guards, and a form that published on save would be a second way
   * for either to be missed.
   */
  await expect(cleaning).toContainText("Utkast");

  /*
   * One date, on the calendar day the form named. The date is read as the
   * machine-readable value the row carries rather than as the words beside it:
   * the words are formatted for a reader in the browser's own language, and the
   * value is the local date the server worked out. An event at ten in the
   * morning is on the 21st in Stockholm whatever that instant is in UTC.
   */
  await expect(cleaning).toContainText("1 tillfälle");
  await expect(
    cleaning.locator(`time[datetime="${CLEANING.firstOn}"]`),
  ).toHaveCount(1);

  // Published to the street, which is the field's other value and never its
  // default.
  await cleaning.getByLabel("Vem det är för").selectOption({ label: "Alla" });
  await cleaning
    .getByRole("button", { name: `Publicera ${CLEANING.title}` })
    .click();
  await expect(
    boardPanel(page).getByText("Evenemanget är publicerat."),
  ).toBeVisible();
  // The audience the stored series carries, which reads this way only once the
  // publication has been written and the list read back with it. A notice says
  // an act was taken; this says what it did.
  await expect(cleaning).toContainText("Publicerat för alla");

  // The board meeting. No sign-up at all, so the form offers no places field
  // and the resident's calendar will state the date rather than offer a control.
  await form.getByLabel("Vad det heter").fill(MEETING.title);
  await form.getByLabel("Kategori").fill(MEETING.category);
  await form.getByLabel("Var det är").fill(MEETING.location);
  await form.getByLabel("Vad det handlar om").fill(MEETING.description);
  await form.getByLabel("Första datumet").fill(MEETING.firstOn);
  await form.getByLabel("Börjar").fill(MEETING.startsAt);
  await form.getByLabel("Minuter").fill(MEETING.durationMinutes);
  await expect(form.getByLabel("Platser per tillfälle")).toHaveCount(0);
  await form.getByRole("button", { name: "Lägg in evenemanget" }).click();

  const meeting = boardCard(page, MEETING.title);
  await expect(meeting).toBeVisible();

  /*
   * Published without touching the audience field, which is the case that
   * matters: the default is the members, so a board that says nothing about who
   * an event is for has not put it on the street. The two chips together are
   * what this test is for - one field decided which of them each series got.
   */
  await meeting
    .getByRole("button", { name: `Publicera ${MEETING.title}` })
    .click();
  await expect(meeting).toContainText("Publicerat för medlemmarna");
});

test("a resident takes a place at a date and gives it up again", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);
  await browseAs(page, clientAddress, "owner");

  await signInThroughTheScreen(page, OWNER);
  await page.goto(appPath("/events"));

  const row = attendRow(page, SAUNA.title);
  await expect(row).toBeVisible();

  // Free before the click, so what the assertions below read is the click's
  // doing rather than a date that arrived in that state.
  await expect(row).toContainText("0 av 4 platser tagna.");
  await expect(
    row.getByRole("button", { name: /^Anmäl dig till / }),
  ).toHaveCount(1);

  await row.getByRole("button", { name: /^Anmäl dig till / }).click();

  await expect(
    attendPanel(page).getByText(
      "Du har en plats. Avanmäl dig här om du inte kan komma.",
    ),
  ).toBeVisible();

  /*
   * The count and the control, out of one answer. Both halves of this row are
   * read from the payload the sign-up came back with, which is the panel's whole
   * reason for not being optimistic: a screen that counted its own click could
   * not promise the two agree after losing a race.
   */
  await expect(row).toContainText("Du kommer");
  await expect(row).toContainText("1 av 4 platser tagna.");
  await expect(
    row.getByRole("button", { name: /^Avanmäl dig från / }),
  ).toHaveCount(1);

  // The same date on a calendar read again, so what is asserted is the
  // instance's answer and not a row the click left behind.
  await page.goto(appPath("/events"));
  await expect(attendRow(page, SAUNA.title)).toContainText(
    "1 av 4 platser tagna.",
  );

  await attendRow(page, SAUNA.title)
    .getByRole("button", { name: /^Avanmäl dig från / })
    .click();

  await expect(
    attendPanel(page).getByText("Du är avanmäld och platsen är ledig igen."),
  ).toBeVisible();

  /*
   * The place is free again and the reader is no longer coming. A withdrawal is
   * a dated close rather than a deleted row, so what has to be true here is
   * about the count and not about the row having gone: the row it wrote stays,
   * and the roll-call below reads it.
   */
  const settled = attendRow(page, SAUNA.title);
  await expect(settled).toContainText("0 av 4 platser tagna.");
  await expect(
    settled.getByRole("button", { name: /^Anmäl dig till / }),
  ).toHaveCount(1);
  await expect(settled.getByText("Du kommer")).toHaveCount(0);
});

test("the last place goes while somebody is looking at it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);
  await browseAs(page, clientAddress, "neighbour");

  /*
   * One of the cleaning day's two places, taken before Karl's page is drawn, so
   * what he is offered is a control on a date that has a place left. The other
   * goes below, while he is looking at it - which is the only way this refusal
   * is reachable, because a date whose places are gone is drawn as a statement
   * and not as a control.
   */
  const owner = await contextFor(clientAddress, OWNER, "owner");
  const housemate = await contextFor(clientAddress, HOUSEMATE, "housemate");
  try {
    const first = await offeredOccurrence(owner, CLEANING.title);
    const taken = await signUpFor(owner, first.occurrenceId);
    expect(taken.placesTaken).toBe(1);

    await signInThroughTheScreen(page, NEIGHBOUR);
    await page.goto(appPath("/events"));

    const row = attendRow(page, CLEANING.title);
    await expect(row).toContainText("1 av 2 platser tagna.");
    const signUp = row.getByRole("button", { name: /^Anmäl dig till / });
    await expect(signUp).toHaveCount(1);

    const full = await signUpFor(housemate, first.occurrenceId);
    expect(full.placesLeft).toBe(0);

    // Armed before the click, so the answer cannot arrive before the wait is
    // registered.
    const refused = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/event-signups/${first.occurrenceId}` &&
        response.request().method() === "POST",
    );
    await signUp.click();

    /*
     * The wire carries a code and the screen carries a sentence, which is the
     * whole of what this assertion pair is about. `occurrence-full` at 409 is
     * the answer of a conditional claim taken under a lock on the date, and a
     * resident cannot act on those words - so the screen maps them to the one
     * sentence that says what happened and what has changed.
     */
    const response = await refused;
    expect(response.status()).toBe(409);
    expect(((await response.json()) as { reason?: string }).reason).toBe(
      "occurrence-full",
    );

    await expect(
      page.getByText(
        "Platserna på tillfället är tagna." +
          " Någon hann före, och kalendern har lästs om.",
      ),
    ).toBeVisible();

    /*
     * And the row he is looking at has caught up in the same breath, without him
     * asking for anything. The count says the places are gone, the control is a
     * statement rather than a button, and the two therefore cannot disagree -
     * which is what a panel that re-read only after a success could not promise
     * for exactly this refusal.
     */
    await expect(row).toContainText("2 av 2 platser tagna.");
    await expect(row).toContainText(
      "Platserna är tagna. En blir ledig om någon avanmäler sig.",
    );
    await expect(
      row.getByRole("button", { name: /^Anmäl dig till / }),
    ).toHaveCount(0);

    /*
     * Nothing was written. Read back from the instance rather than looked for on
     * the page: a screen that had simply never drawn a row would satisfy an
     * assertion made against the page, and what is claimed here is that the
     * refusal refused.
     */
    const neighbour = await contextFor(clientAddress, NEIGHBOUR, "neighbour");
    try {
      const his = await offeredOccurrence(neighbour, CLEANING.title);
      expect(his.own).toBeNull();
      expect(his.placesTaken).toBe(2);
    } finally {
      await neighbour.dispose();
    }
  } finally {
    await housemate.dispose();
    await owner.dispose();
  }
});

test("the roll-call names who is coming, and never a protected person", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);

  /*
   * Two people put their names down for the sauna evening. Astrid already has a
   * row on it from the test above, where she signed up and stood down again -
   * that row is part of what this test asserts, because a withdrawal is a dated
   * close and the board reading the list has to be able to tell "was not
   * expected" from "changed their mind".
   */
  const protectedPerson = await contextFor(
    clientAddress,
    PROTECTED,
    "protected",
  );
  const neighbour = await contextFor(clientAddress, NEIGHBOUR, "neighbour");
  try {
    const date = await offeredOccurrence(protectedPerson, SAUNA.title);
    await signUpFor(protectedPerson, date.occurrenceId);
    const both = await signUpFor(neighbour, date.occurrenceId);
    expect(both.placesTaken).toBe(2);
  } finally {
    await neighbour.dispose();
    await protectedPerson.dispose();
  }

  await browseAs(page, clientAddress, "administrator");
  await signInThroughTheScreen(page, ADMINISTRATOR);
  await page.goto(appPath("/events"));

  const card = boardCard(page, SAUNA.title);
  await expect(card).toBeVisible();

  /*
   * Read when it is opened rather than with the series it belongs to. One series
   * can hold a hundred dates, and drawing this list from every roll-call would
   * read a year of residents' names for a screen that asked about one date.
   */
  await card.getByRole("button", { name: /^Vilka kommer den / }).click();

  /*
   * The roll-call is drawn inside the date's own row, so the section listing the
   * dates encloses it and carries its heading too. Named by what each of the two
   * is rather than by which came first in the document: this is the section that
   * says who is coming and does not list the dates.
   */
  const rollCall = card
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Deltagarlista", exact: true }),
    })
    .filter({
      hasNot: page.getByRole("heading", { name: "Tillfällen", exact: true }),
    });
  await expect(rollCall).toBeVisible();
  await expect(rollCall).toContainText("2 av 4 platser tagna.");

  /*
   * A name, which is what this half of the screen exists for and what no other
   * reader of this module is shown: the resident's own calendar carries how many
   * places are gone and nothing about who has them.
   */
  await expect(rollCall).toContainText(NEIGHBOUR.name);

  /*
   * And a place with no name on it. A person with protected personal data is
   * counted here and never named: the statutory registers have a reason to print
   * that name and a list read in a stairwell doorway has none. The server does
   * not send it, so the absence is not this screen choosing to be careful - and
   * it is asserted against the whole page, because an accessible name is text
   * like any other and a control naming her would satisfy an assertion scoped to
   * the visible rows.
   */
  await expect(rollCall).toContainText(
    "Skyddade personuppgifter: se registret.",
  );
  /*
   * Named against a name that is on this page, with the same instrument, so an
   * absence below cannot be a locator that finds nothing anywhere. She is on the
   * list - the sentence above is her row - and she is not named on it.
   */
  await expect(page.getByText(NEIGHBOUR.name)).not.toHaveCount(0);
  await expect(page.getByText(PROTECTED.name)).toHaveCount(0);

  // The one who stood down is still on the list, saying that she did.
  const stoodDown = rollCall
    .getByRole("listitem")
    .filter({ hasText: OWNER.name });
  await expect(stoodDown).toContainText("Avanmäld");
  await expect(stoodDown.getByRole("button")).toHaveCount(0);

  /*
   * The board stands one named person down, from the list it is reading. The row
   * is picked by the name on it rather than by the control's own name: one
   * roll-call is one date, so every row offers the same act and says which date
   * it is about rather than which person.
   */
  const expected = rollCall
    .getByRole("listitem")
    .filter({ hasText: NEIGHBOUR.name });
  await expected.getByRole("button", { name: /^Avanmäl deltagaren / }).click();

  /*
   * The row stays and says he stood down, and the place is counted back. What
   * goes is the control, because there is nothing left to withdraw - and the
   * count above it comes from the same read as the rows, so the two cannot
   * disagree about how many are expected.
   */
  await expect(expected).toContainText("Avanmäld");
  await expect(expected.getByRole("button")).toHaveCount(0);
  await expect(rollCall).toContainText("1 av 4 platser tagna.");
});

test("the street reads the cleaning day, and the page does nothing else", async ({
  page,
  context,
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);
  const cleaning = await eventSeriesTitled(request, CLEANING.title);

  const requested: string[] = [];
  page.on("request", (outgoing) => {
    requested.push(outgoing.url());
  });

  /*
   * The month the cleaning day falls in, stated in the address. The association's
   * own website is at the root, and this is one of the specs allowed to navigate
   * it (the allowlist in 93-public-site.spec.ts).
   *
   * The month is named rather than assumed: /kalender answers with the month the
   * request arrives in, and a date three weeks out is in the next month for most
   * of any given month. A spec that read the current month would pass for a few
   * days at a time.
   */
  const month = `/kalender?manad=${monthOf(CLEANING.firstOn)}`;
  await page.goto(month);

  await expect(
    page.getByRole("heading", { name: "Kalender", level: 1 }),
  ).toBeVisible();

  const date = page
    .getByRole("listitem")
    .filter({ hasText: CLEANING.title })
    .first();
  await expect(date).toBeVisible();
  await expect(date).toContainText(CLEANING.location);
  await expect(
    date.locator(`time[datetime="${CLEANING.firstOn}"]`),
  ).toHaveCount(1);

  /*
   * How many places are gone, and that is the most the website may say about a
   * sign-up. Both of the cleaning day's places were taken above, so this is what
   * the count reads as - and the two people holding them are asserted absent
   * below against a page that really does have somebody to name.
   */
  await expect(date).toContainText("Fullbokat");
  /*
   * A control on the instrument before the absences: the same reader finds the
   * association's own name on this page. Without it the four assertions below
   * would be held by a document that was never searched at all.
   */
  await expect(page.getByText(HOUSING_COOPERATIVE.name).first()).toBeVisible();
  for (const person of [OWNER, HOUSEMATE, NEIGHBOUR, PROTECTED]) {
    await expect(page.getByText(person.name)).toHaveCount(0);
  }

  // The members' meeting is not on this page. Which month it is in is settled in
  // the test below, where the same address is read twice and answers differently.
  await expect(page.getByText(MEETING.title)).toHaveCount(0);

  /*
   * The way between months is two ordinary links. There is no script on the
   * website - the content policy names no script source, so a browser would
   * refuse one - and a calendar is exactly the kind of thing that invites a grid
   * somebody drags around.
   */
  await expect(
    page.getByRole("link", { name: "Föregående månad" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Nästa månad" })).toBeVisible();

  // Nothing ran, and nothing was stored.
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await context.cookies()).toEqual([]);

  /*
   * Every subresource the page pulled - the typefaces above all, which is the
   * one that would silently become a third-party request if the stylesheet named
   * a font host.
   *
   * The navigation itself is in this list, so counting the list proves nothing: a
   * page that fetched no font at all would satisfy that, and the claim would be
   * held by an assertion that cannot fail. So a font has to be among the
   * subresources before "from this instance" means anything.
   *
   * Origins, not prefixes. "http://localhost:3010@third-party.example/f.woff2"
   * starts with the instance's own address and is a request to somebody else
   * entirely - the part before the @ is userinfo, not a host.
   */
  const subresources = requested.filter(
    (url) => url !== `${stack.baseUrl}${month}`,
  );
  expect(
    subresources.some((url) => /\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(url)),
    subresources.join(", "),
  ).toBe(true);
  const instance = new URL(stack.baseUrl).origin;
  for (const url of requested) {
    expect(new URL(url).origin, url).toBe(instance);
  }

  /*
   * And the event's own address, which is the series and not the date: what a
   * reader arriving at a cleaning day in April wants is what to bring and when
   * the other ones are.
   */
  await page.goto(`/kalender/${cleaning.id}`);
  await expect(
    page.getByRole("heading", { name: CLEANING.title, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(CLEANING.description)).toBeVisible();
  // Where a sign-up is made, because the website takes no authenticated writes
  // at all: it sets no cookie and keeps no session.
  await expect(
    page.getByText("Anmälan görs när du har loggat in."),
  ).toBeVisible();
  for (const person of [OWNER, HOUSEMATE, NEIGHBOUR, PROTECTED]) {
    await expect(page.getByText(person.name)).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await context.cookies()).toEqual([]);
});

test("the members' meeting is answered to the street as nothing at all", async ({
  api: request,
  clientAddress,
}) => {
  await ensureEventFixture(request, clientAddress);
  const meeting = await eventSeriesTitled(request, MEETING.title);
  const month = `/kalender?manad=${monthOf(MEETING.firstOn)}`;

  const visitor = await anonymousVisitor(clientAddress);
  const member = await contextFor(clientAddress, OWNER, "owner");
  try {
    /*
     * The same address, read twice, answering differently. That pair is the
     * whole of the visibility rule: which dates a reader is shown rests on
     * whether the request carried a session and on nothing else - there is no
     * capability read on the public website and there cannot be.
     *
     * The signed-in reader is a resident rather than the administrator, so what
     * opens the members' half is having an account and not holding anything.
     */
    const closedMonth = await visitor.get(`${stack.baseUrl}${month}`, {
      failOnStatusCode: false,
    });
    expect(closedMonth.status()).toBe(200);
    const anonymously = await closedMonth.text();
    // The calendar, and not an error document that happened to answer 200: the
    // absence below has to be an absence from the page under test.
    expect(anonymously).toContain(HOUSING_COOPERATIVE.name);
    expect(anonymously.includes(MEETING.title)).toBe(false);

    const openMonth = await member.get(`${stack.baseUrl}${month}`, {
      failOnStatusCode: false,
    });
    expect(openMonth.status()).toBe(200);
    expect(await openMonth.text()).toContain(MEETING.title);

    /*
     * And the meeting's own address. Two requests differing in nothing but which
     * event they name, one behind which there is an event this visitor may not
     * read and one behind which there is nothing at all.
     */
    const closed = await visitor.get(
      `${stack.baseUrl}/kalender/${meeting.id}`,
      { failOnStatusCode: false },
    );
    const missing = await visitor.get(
      `${stack.baseUrl}/kalender/${NO_SUCH_EVENT}`,
      { failOnStatusCode: false },
    );

    expect(closed.status()).toBe(404);
    expect(missing.status()).toBe(404);
    // Byte for byte. This is the whole guarantee: somebody holding a list of
    // identifiers cannot tell an event that exists and is closed to them from
    // one that does not exist.
    expect(await closed.text()).toBe(await missing.text());
    expect((await closed.text()).includes(MEETING.title)).toBe(false);
    // Reading the association's calendar never starts a session.
    expect(closed.headers()["set-cookie"]).toBeUndefined();
    expect(missing.headers()["set-cookie"]).toBeUndefined();

    /*
     * The same address to somebody signed in. Without this the byte-identical
     * pair above would be satisfied by an instance that had lost the meeting
     * altogether, and the assertion would say nothing about the audience.
     */
    const opened = await member.get(`${stack.baseUrl}/kalender/${meeting.id}`, {
      failOnStatusCode: false,
    });
    expect(opened.status()).toBe(200);
    const body = await opened.text();
    expect(body).toContain(MEETING.title);
    expect(body).toContain(MEETING.location);
    expect(body).toContain(MEETING.description);
    // Reading a members' event reads the session; it never writes one.
    expect(opened.headers()["set-cookie"]).toBeUndefined();
  } finally {
    await member.dispose();
    await visitor.dispose();
  }
});
