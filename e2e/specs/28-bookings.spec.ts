import {
  request as playwrightRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

import * as api from "../src/api";
import {
  bookNthSlotOn,
  ensureResource,
  ownApartments,
  ownBookings,
  slotsOn,
  timeSlotResource,
} from "../src/bookings";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { grantPropertyManager } from "../src/issues";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Resource booking, end to end.
 *
 * Not one of the numbered exit criteria. It is here because five of the
 * module's promises are only true once a browser, the API, the association's
 * clock and a real database are in the same room.
 *
 * A resident takes a laundry hour through the calendar, and the calendar then
 * says the hour is theirs - not that somebody has it, which is all it ever says
 * about a neighbour's.
 *
 * A second household loses the race for the same hour and reads a sentence. The
 * refusal is the database's, arbitrated by the partial unique index, and it
 * arrives at a screen whose job is to turn a code into something a resident can
 * act on. Reaching it needs the first booking to land while the second reader's
 * page is open - which is also the only way it happens in life, because a slot
 * the calendar draws as taken is not a control anybody can press.
 *
 * The allowance is the apartment's and not the person's. Two people on one
 * apartment share it, and the second of them is refused although they hold
 * nothing themselves, which is the property that would quietly break if the
 * count were ever taken against the booker.
 *
 * The board cancels on somebody else's behalf, from the half of the screen its
 * own capability opens, and that half names the household - the one place in
 * this module where a booking is attached to a person.
 *
 * And the external property manager has no bookings entry in the navigation at
 * all. They handle the association's issues; they do not live in the building,
 * and a laundry hour is not theirs to take or to give away. The API refuses
 * them either way, but the navigation is where a person would look for the
 * door.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the invitation spec sets on the shared fixture's accounts.
 * Nothing in the suite can change a password, so a second one here would only
 * fail to sign in.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * Three of the four people the shared register fixture seeds.
 *
 * Astrid holds the tenant-ownership of Storgatan 12/1001 and Nils lives in that
 * same apartment holding none: one household, two people, one allowance, which
 * is what the quota test is about. Karl is a member of the other house, so the
 * hour he loses is lost to the calendar rather than to his own allowance.
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

/*
 * The external property manager. Written by this spec and never removed again -
 * nothing in the suite can delete a person - so the identity is this run's.
 * They hold no apartment, which is the point: they do not live here.
 *
 * Their own password, because the address is unique to the run and no other
 * spec activates it, so `ensureAccountFor` creates the account with exactly
 * this one the first time it is asked for.
 */
const MANAGER = {
  firstName: "Signe",
  lastName: uniqueSurname("Wikner"),
  email: uniqueEmail("signe"),
  password: "portkodslista-vindsforrad-2026",
} as const;

/**
 * This run's own resources, so a rerun against a kept stack reads its own rows.
 *
 * Three of them, one per test that books, because a booking has to be found by
 * the resource it was made against. A board reading four weeks of the calendar
 * sees every booking in them, and two tests sharing a resource would each be
 * asserting on a row the other might have written.
 *
 * The allowance is on the sauna and nowhere else, for the same reason: a
 * refusal has to be unambiguous. Nothing on the laundry room or the common room
 * can be refused except by the calendar, and nothing on the sauna except by the
 * allowance.
 */
const LAUNDRY = `Tvattstugan ${uniqueSurname("port")}`;
const SAUNA = `Bastun ${uniqueSurname("plan")}`;
const COMMON_ROOM = `Foreningslokalen ${uniqueSurname("gard")}`;

/**
 * The day each test books on, as an offset from the day the run happens.
 *
 * Offsets rather than dates: a date written into a file stops being in the
 * future, and the API refuses a slot that has begun. One day per test, so two
 * tests cannot compete for one hour, and every offset inside the seven days a
 * time-slotted calendar shows at once, so no test has to page the grid.
 *
 * Day 0 is deliberately unused. Today's earlier slots have passed, so which
 * hour "the first one" is would depend on what time of day the suite was run.
 */
const OWN_BOOKING_DAY = 1;
const RACE_DAY = 2;
const BOARD_CANCEL_DAY = 3;
const QUOTA_DAY = 4;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A Stockholm calendar date, `days` from today, as "YYYY-MM-DD".
 *
 * Today is read on the association's clock rather than on this machine's, for
 * the reason the client reads it the same way: just after midnight in Stockholm
 * the two disagree, and the day a slot belongs to is the building's. The
 * arithmetic on that date is then calendar arithmetic and carries no zone at
 * all - the day after the 25th of October is the 26th, however many hours that
 * Sunday had.
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
 * The slot controls of one day of the resident calendar, in the order offered.
 *
 * Found by the date the grid put in that day's own heading rather than by the
 * words around it. The heading is written for a reader - "torsdag 3 september" -
 * and formatting the same date here would put this process's own Intl data
 * against the browser's; the `datetime` attribute carries the value the API
 * sent, which is what the assertions are about.
 */
function slotsOfDay(page: Page, day: string): Locator {
  return page
    .locator("li")
    .filter({ has: page.locator(`h3 > time[datetime="${day}"]`) })
    .getByRole("button");
}

/**
 * Signs in through the screen, and returns once the sign-in has landed.
 *
 * The wait belongs here rather than to the callers: clicking only starts the
 * sign-in, so a caller that navigates on the next line cancels the request in
 * flight and the route guard sends the browser back to the form.
 */
async function signInThroughTheScreen(
  page: Page,
  who: { email: string; password: string },
): Promise<void> {
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

/**
 * Opens the booking screen with one resource chosen and its calendar drawn.
 *
 * The picker is set explicitly rather than left on whatever the catalogue
 * offers first, because a stack that has been reused carries the resources of
 * every run before this one.
 *
 * The wait is for a slot and not for the panel. The heading is rendered before
 * the calendar request comes back, so a caller that went on from there would be
 * reading an empty grid.
 */
async function openCalendarFor(
  page: Page,
  resourceName: string,
): Promise<void> {
  await page.goto(appPath("/bookings"));
  await page
    .getByLabel("Vad du vill boka")
    .selectOption({ label: resourceName });
  await expect(
    page.getByRole("button", { name: /^Boka / }).first(),
  ).toBeVisible();
}

/**
 * Puts this browser on one person's own client address.
 *
 * A page-level header takes precedence over the browser context's, so this
 * moves every request the page goes on to make into that person's bucket
 * without a second context to create and close.
 *
 * The authentication endpoints are rate-limited to twenty requests a minute per
 * client address, and the shared fixtures give each test one, on the reading
 * that a test is one member signing in from their own home. Every test here
 * acts as two or three people - a household, a neighbour, the board, an outside
 * contractor - who in life sign in from as many different places, and one
 * address between them spends one person's budget on another's until the
 * instance refuses a sign-in the test is asserting on.
 *
 * Call it before the first navigation: the sign-in screen's own route guard
 * asks the server for a session, and that request counts too.
 */
async function browseAs(
  page: Page,
  clientAddress: string,
  persona: string,
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
  persona: string,
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

/** The apartment a fixture person holds, or a failure naming them. */
async function apartmentOf(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const [apartment] = await ownApartments(request);
  if (apartment === undefined) {
    throw new Error(`${name} holds no apartment to book against`);
  }
  return apartment.id;
}

/**
 * The instance every test here expects: the register fixture, the three
 * resources, and an account for everybody who signs in.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: Playwright may run spec files in different
 * worker processes, and every test in this file calls it.
 */
async function ensureBookingFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<{ laundryId: string; saunaId: string; commonRoomId: string }> {
  /*
   * The context comes back signed in as the administrator: ensureInstance,
   * which ensureRegisterFixture calls, signs it in. Do not sign in again here.
   * A second sign-in goes out on a context that already holds the session
   * cookie, and the authentication layer applies its origin check to a
   * cookie-bearing state-changing request - which this context, carrying only a
   * forwarded-for header, has no Origin to satisfy.
   */
  const people = await ensureRegisterFixture(request);

  const laundry = await ensureResource(
    request,
    timeSlotResource({ name: LAUNDRY }),
  );
  const sauna = await ensureResource(
    request,
    timeSlotResource({ name: SAUNA, maxBookingsPerWeek: 1 }),
  );
  const commonRoom = await ensureResource(
    request,
    timeSlotResource({ name: COMMON_ROOM }),
  );

  for (const [person, persona] of [
    [OWNER, "owner"],
    [HOUSEMATE, "housemate"],
    [NEIGHBOUR, "neighbour"],
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

  /*
   * Looked up before being created. Nothing in the suite can delete a person,
   * and this helper runs once per test in the file, so creating unconditionally
   * would leave five identical property managers in the register per run.
   *
   * The shared lookup asks the address book under the `all` filter, which lists
   * a person with no residency as well as one with - which is what makes it
   * usable here: the property manager holds no apartment.
   */
  const managerFullName = `${MANAGER.firstName} ${MANAGER.lastName}`;
  const managerPersonId =
    (await api.findPersonIdByName(request, stack.baseUrl, managerFullName)) ??
    (await api.createPerson(request, stack.baseUrl, {
      firstName: MANAGER.firstName,
      lastName: MANAGER.lastName,
      email: MANAGER.email,
    }));
  await grantPropertyManager(managerPersonId);
  await ensureAccountFor(request, {
    personId: managerPersonId,
    email: MANAGER.email,
    password: MANAGER.password,
    clientAddress: clientAddressFor(clientAddress, "manager"),
  });

  return {
    laundryId: laundry.id,
    saunaId: sauna.id,
    commonRoomId: commonRoom.id,
  };
}

test("a resident takes a laundry hour and the calendar says it is theirs", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBookingFixture(request, clientAddress);
  await browseAs(page, clientAddress, "owner");

  await signInThroughTheScreen(page, OWNER);
  await openCalendarFor(page, LAUNDRY);

  const day = dayFromToday(OWN_BOOKING_DAY);
  const slot = slotsOfDay(page, day).first();

  // Free before the click, so what the assertions below read is the click's
  // doing rather than a slot that arrived in that state.
  await expect(slot).toContainText("Ledig");
  await slot.click();

  await expect(page.getByText("Bokningen är gjord.")).toBeVisible();

  /*
   * The hour reads as the reader's own rather than merely as taken, and that
   * distinction is the whole of what the resident calendar says about a
   * booking: a neighbour's is taken and carries no identity, and the reader's
   * own is the one state that identifies anybody at all.
   *
   * Read as the name the control carries, which is what a person hears and what
   * the state decides: a free hour is offered as "Boka <period>" and a held one
   * is stated as "<period>: <state>".
   */
  await expect(slotsOfDay(page, day).first()).toHaveAccessibleName(/: Din$/);

  // And it is in what this account holds, on the household's apartment, with
  // something to cancel it by.
  const held = page.getByRole("listitem").filter({ hasText: LAUNDRY }).first();
  await expect(held).toBeVisible();
  await expect(held).toContainText("1001");
  await expect(
    held.getByRole("button", { name: `Avboka ${LAUNDRY}` }),
  ).toBeVisible();

  // The same hour on a calendar read again, so what is asserted is the
  // instance's answer and not a grid the click left behind.
  await openCalendarFor(page, LAUNDRY);
  await expect(slotsOfDay(page, day).first()).toContainText("Din");
});

test("a second household loses the hour and reads a sentence", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { laundryId } = await ensureBookingFixture(request, clientAddress);
  await browseAs(page, clientAddress, "neighbour");

  const day = dayFromToday(RACE_DAY);

  /*
   * Karl's page first, with the hour drawn as free, and the other household's
   * booking only afterwards. That order is the test: a slot the calendar draws
   * as taken is a disabled control, so this refusal is reachable only by the
   * hour going while the page is open - which is how a resident meets it.
   */
  await signInThroughTheScreen(page, NEIGHBOUR);
  await openCalendarFor(page, LAUNDRY);
  const slot = slotsOfDay(page, day).first();
  await expect(slot).toContainText("Ledig");

  const owner = await contextFor(clientAddress, OWNER, "owner");
  try {
    await bookNthSlotOn(owner, {
      resourceId: laundryId,
      apartmentId: await apartmentOf(owner, OWNER.name),
      day,
      index: 0,
    });
  } finally {
    await owner.dispose();
  }

  // Armed before the click, so the answer cannot arrive before the wait is
  // registered.
  const refused = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/bookings" &&
      response.request().method() === "POST",
  );
  await slot.click();

  /*
   * The wire carries a code and the screen carries a sentence, which is the
   * whole of what this assertion pair is about. `slot-taken` at 409 is the
   * database's answer - the partial unique index refused the second claim - and
   * a resident cannot act on those words, so the screen maps them to the one
   * sentence that says what happened and what has changed.
   */
  const response = await refused;
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { reason?: string }).reason).toBe(
    "slot-taken",
  );

  await expect(
    page.getByText("Någon hann före på den tiden. Kalendern har lästs om."),
  ).toBeVisible();

  /*
   * The hour is the other household's now, read from a fresh page so the state
   * asserted on is the instance's and not the grid the click was made against.
   * Karl's calendar says the hour is taken and never by whom: there is nothing
   * on this screen for a booker to be rendered into.
   */
  await openCalendarFor(page, LAUNDRY);
  await expect(slotsOfDay(page, day).first()).toContainText("Bokad");
  await expect(page.getByText(OWNER.name)).toHaveCount(0);

  // And he holds nothing. The refusal was a refusal, not a booking landing
  // somewhere he was not looking.
  await expect(page.getByText("Du har inga bokningar.")).toBeVisible();
});

test("the allowance is the apartment's, shared by everybody living in it", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { saunaId } = await ensureBookingFixture(request, clientAddress);
  await browseAs(page, clientAddress, "housemate");

  const day = dayFromToday(QUOTA_DAY);

  /*
   * Astrid spends the household's one booking for the week. Nils then tries the
   * other slot of the same day, so the two are inside one week whatever weekday
   * the run lands on: the allowance is counted over the week the booking is
   * for, and the next day could be the next week.
   */
  const owner = await contextFor(clientAddress, OWNER, "owner");
  try {
    await bookNthSlotOn(owner, {
      resourceId: saunaId,
      apartmentId: await apartmentOf(owner, OWNER.name),
      day,
      index: 0,
    });
  } finally {
    await owner.dispose();
  }

  await signInThroughTheScreen(page, HOUSEMATE);
  await openCalendarFor(page, SAUNA);

  // Nils holds nothing himself, which is what makes the refusal below about the
  // household rather than about him. He is not a member either: the allowance
  // follows the apartment and not the tenant-ownership.
  await expect(page.getByText("Du har inga bokningar.")).toBeVisible();

  const second = slotsOfDay(page, day).nth(1);
  await expect(second).toContainText("Ledig");
  await second.click();

  /*
   * The sentence for a weekly allowance and not the one for a limit on how much
   * of the future a household may hold at once. Both are `quota-reached` on the
   * wire and the API says which limit it was, because a week that has been
   * spent is waited out while the other is answered by cancelling something.
   */
  await expect(
    page.getByText(
      "Lägenheten har använt sina bokningar för den veckan." +
        " Gränsen räknas på veckan bokningen gäller, så en senare vecka är öppen.",
    ),
  ).toBeVisible();

  // Nothing was written: the household still holds the one booking it made, and
  // Nils still holds none of his own.
  const housemate = await contextFor(clientAddress, HOUSEMATE, "housemate");
  try {
    expect(await ownBookings(housemate)).toHaveLength(0);
    const slots = await slotsOn(housemate, {
      resourceId: saunaId,
      from: day,
      to: day,
    });
    expect(slots.map((slot) => slot.state)).toEqual(["TAKEN", "FREE"]);
  } finally {
    await housemate.dispose();
  }
});

test("the board cancels a resident's booking from its own half", async ({
  page,
  api: request,
  clientAddress,
}) => {
  const { commonRoomId } = await ensureBookingFixture(request, clientAddress);

  const day = dayFromToday(BOARD_CANCEL_DAY);

  const owner = await contextFor(clientAddress, OWNER, "owner");
  try {
    await bookNthSlotOn(owner, {
      resourceId: commonRoomId,
      apartmentId: await apartmentOf(owner, OWNER.name),
      day,
      index: 0,
    });

    /*
     * The administrator, who holds every capability and no residency. They are
     * the board here for the reason the screenshot walk uses them for the same
     * screen: nothing in phase 1 elects anybody, and what this test is about is
     * bookings:manage rather than which grant conferred it. Holding no
     * apartment they could not have made this booking, so the cancellation is
     * unambiguously on somebody else's behalf.
     */
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(page, ADMINISTRATOR);
    await page.goto(appPath("/bookings"));

    const row = page
      .getByRole("listitem")
      .filter({ hasText: COMMON_ROOM })
      .first();
    await expect(row).toBeVisible();

    /*
     * The half the capability exists for says which household holds the hour.
     * That is the one place in this module where a booking is attached to a
     * person, and the resident calendar above it on the same screen is drawn
     * from the same instance without it.
     */
    await expect(row).toContainText(OWNER.name);
    await expect(row).toContainText("1001");

    /*
     * The control, and it is what says the booking is live: a cancelled one
     * carries none. Deliberately not the word on the sign, which every row
     * contains anyway - "Bokad av" names the booker whatever state the booking
     * is in, so reading "Bokad" out of a row would say nothing.
     */
    const cancelOnBehalf = row.getByRole("button", {
      name: `Avboka ${COMMON_ROOM} åt den boende`,
    });
    await expect(cancelOnBehalf).toBeVisible();
    await cancelOnBehalf.click();

    await expect(
      page.getByText(
        "Bokningen är avbokad. Den boende kan se vem som avbokade.",
      ),
    ).toBeVisible();

    /*
     * The row stays and says it is cancelled rather than disappearing. A board
     * reading a month is often reading it because somebody says a booking was
     * cancelled, and a list that hid cancellations could not answer that. What
     * goes is the control, because there is nothing left to cancel.
     */
    const cancelled = page
      .getByRole("listitem")
      .filter({ hasText: COMMON_ROOM })
      .first();
    await expect(cancelled).toContainText("Avbokad");
    await expect(
      cancelled.getByRole("button", { name: /åt den boende$/ }),
    ).toHaveCount(0);

    /*
     * And the hour is on the calendar again, which is what a cancellation is
     * for. Read as the resident, because that is who it has gone back to, and
     * scoped to the resource this test owns: the same household holds hours on
     * the other two, put there by the tests above.
     */
    const slots = await slotsOn(owner, {
      resourceId: commonRoomId,
      from: day,
      to: day,
    });
    expect(slots.map((slot) => slot.state)).toEqual(["FREE", "FREE"]);
    const stillHeld = (await ownBookings(owner)).filter(
      (booking) => booking.resourceId === commonRoomId,
    );
    expect(stillHeld).toHaveLength(0);
  } finally {
    await owner.dispose();
  }
});

test("the property manager is offered no bookings at all", async ({
  page,
  api: request,
  clientAddress,
}) => {
  await ensureBookingFixture(request, clientAddress);
  await browseAs(page, clientAddress, "manager");

  await signInThroughTheScreen(page, MANAGER);
  await page.goto(appPath("/issues"));

  // Their own screen, so the navigation being asserted on is one they reached.
  await expect(page.getByRole("heading", { name: "Ärendekön" })).toBeVisible();

  /*
   * The promise, at the place a person would actually look for the door. The
   * API refuses them both halves either way; a link straight to a screen that
   * can only refuse them is the platform offering an outside party something it
   * said was not theirs.
   */
  await expect(
    page.getByRole("link", { name: "Bokningar", exact: true }),
  ).toHaveCount(0);
  // Named against what they are offered, so an empty navigation could not
  // satisfy the assertion above.
  await expect(
    page.getByRole("link", { name: "Ärenden", exact: true }),
  ).not.toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Inställningar", exact: true }),
  ).not.toHaveCount(0);

  /*
   * And nothing on the screen itself, reached by its address: neither the
   * resident's calendar nor the board's month, and no resource named. The
   * screen's own title is there, so what the two counts below say is that the
   * panels are absent rather than that the page failed to render.
   *
   * `exact` on both, because a name is otherwise matched as a substring and the
   * title contains the booking panel's whole name: "Boka" inside "Bokningar"
   * would find the title and report a panel that is not there.
   */
  await page.goto(appPath("/bookings"));
  await expect(
    page.getByRole("heading", { name: "Bokningar", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Boka", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Hela kalendern", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(LAUNDRY)).toHaveCount(0);
});
