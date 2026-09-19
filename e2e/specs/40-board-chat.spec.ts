import type { APIRequestContext, Page, Response } from "@playwright/test";

import { createPerson } from "../src/api";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueEmail, uniqueSurname } from "../src/identity";
import { ensureAccountFor, ensureRegisterFixture } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The board's own chat, as far as a deployed instance can show it.
 *
 * What is here is the half that only exists once the image is serving one
 * origin and two browsers are looking at it at the same time.
 *
 * **A message written in one browser appears in the other without a reload.**
 * That is the whole claim delivery makes, and nothing but two live contexts can
 * test it: the unit tests hold the poll's mechanics and the integration suite
 * holds what the endpoints answer, and neither of them has a second screen open.
 * It is asserted by waiting for the text, with Playwright's own retry, which
 * passes as soon as the first poll after the write lands and does not care how
 * long that took. Never by waiting out the interval - a spec that slept four
 * seconds would be asserting the clock rather than the delivery, and would flake
 * the day the machine was busy.
 *
 * **Somebody who lives here is not offered the board's room, and is told why.**
 * They reach the screen - a group is theirs to make, so the navigation carries
 * the destination - and the board's own room is not among the ones they are
 * answered with. Asserted against the endpoint as well as against the screen,
 * because what keeps a resident out of the board's deliberation is the seat the
 * service asks the register for rather than anything the browser renders.
 *
 * **A personal identity number is refused, and the refusal does not carry it
 * back.** The response is read as well as the screen, because the thing the scan
 * caught is exactly the thing that must not travel back into a body, a log or a
 * screen somebody else is looking at.
 *
 * **The messages before the first page are one press away.** A room is read a
 * page at a time from its newest end, and a room that stopped at fifty with
 * nothing saying so would be a room with messages missing from it.
 *
 * Deliberately absent: the administrator holding the capability and finding no
 * room. Three earlier specs put the shared administrator on the board and
 * `grantBoardSeat` is idempotent against the database, so on this instance they
 * hold a seat and are in the room. That case is
 * `apps/api/src/chat/chat.int-spec.ts`, which builds its own people.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this file's own invention would fail that probe,
 * fall through to an invitation, and be refused for an account that already
 * exists.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * The password for the board member this spec creates for itself.
 *
 * Its own rather than the fixture's, because nobody else activates this person:
 * they are invented here, invited here and activated here, so there is no other
 * spec's literal to agree with.
 */
const COLLEAGUE_PASSWORD = "rabarber-stopplykta-2026";

/**
 * From the shared fixture: 12/1001, a member, and on the board.
 *
 * Seated by specs 27 and 37 already, and seated again here so this file does not
 * depend on having been run after them. `grantBoardSeat` is idempotent against
 * the database rather than against process state.
 */
const SEATED = {
  name: "Astrid Lindqvist",
  email: "astrid@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * From the shared fixture: 12/1001, recorded a resident, and on no board.
 *
 * Nobody elects him anywhere in the suite, which is what makes him the honest
 * case for an account the board's room is not for.
 */
const NO_SEAT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/** Fills in the sign-in form on screen and waits for the answer. */
async function submitSignIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
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
}

/** Signs in through the screen, from a browser holding no session. */
async function signInThroughTheScreen(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.context().clearCookies();
  await page.goto(appPath("/sign-in"));
  await submitSignIn(page, email, password);
  await expect(page).not.toHaveURL(/\/sign-in(\?|$)/);
}

/** Puts this browser on one person's own client address. */
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
 * A fixture person, with an account they can sign in with.
 *
 * Narrowed here rather than read through `?.` at the call sites: a run whose
 * register is missing somebody has to fail on the line that says so, rather than
 * several assertions later on a sign-in that was never going to work.
 */
async function ensureFixtureAccount(
  request: APIRequestContext,
  people: ReadonlyMap<string, string>,
  person: { name: string; email: string; password: string },
  clientAddress: string,
): Promise<string> {
  const personId = people.get(person.name);
  if (personId === undefined) {
    throw new Error(`${person.name} is not in the register fixture`);
  }
  await ensureAccountFor(request, {
    personId,
    email: person.email,
    password: person.password,
    clientAddress,
  });
  return personId;
}

/**
 * A person on the board, created by this spec rather than borrowed.
 *
 * There is nobody to borrow. `ensureRegisterFixture` writes residencies and not
 * the member register, and the seeded administrator is not among the four people
 * it provisions - so asking it for them correctly answers nothing. A spec that
 * needs a particular person in the register moves that person in itself.
 *
 * Borrowing the administrator would have been wrong for a second and
 * independent reason: specs 24, 27 and 35 put them on the board, so a test built
 * on them would be asserting against a seat another spec granted and would pass
 * or fail on the order the suite happened to run in.
 *
 * A person needs no apartment, no residency and no membership to hold a seat,
 * which is what lets a cooperative seat an external board member at all - spec
 * 03 creates and activates one on exactly that footing. So this is a person, an
 * account and a seat, and nothing else.
 *
 * Nothing in this suite can delete a person again - the member register is
 * append-only by design - so the name and the address are unique to this run.
 */
async function ensureBoardMemberOfOurOwn(
  request: APIRequestContext,
  clientAddress: string,
  /**
   * Distinguishes this person from the others this spec makes.
   *
   * `uniqueEmail` is unique per run rather than per call, so two calls sharing a
   * label would ask for one address twice: the second `createPerson` would write
   * a second person carrying it - the address book has no unique index on the
   * address - and `ensureAccountFor` would then sign in as the first and leave
   * the second without an account.
   */
  label: string,
): Promise<{ email: string; password: string }> {
  const email = uniqueEmail(`chatt-${label}`);
  const personId = await createPerson(request, stack.baseUrl, {
    firstName: "Bo",
    lastName: uniqueSurname(`Ek-${label}`),
    email,
  });
  await ensureAccountFor(request, {
    personId,
    email,
    password: COLLEAGUE_PASSWORD,
    clientAddress,
  });
  await grantBoardSeat(personId);

  return { email, password: COLLEAGUE_PASSWORD };
}

/**
 * The response to a message write, and never to anything else the screen posts.
 *
 * Two routes sit under `/api/chat/` and both take a POST: the message write at
 * `/api/chat/:chatId`, and the read marker at `/api/chat/:chatId/read`. The
 * marker is there because a chat notifies nobody by mail and says what is
 * unread instead, so the screen posts one as soon as it has read a page - which
 * means the two are in flight together whenever somebody opens a room and types.
 *
 * So this matches one route and one body rather than the prefix. A predicate
 * that matched `/api/chat/` and a POST resolves on whichever of the two lands
 * first, and which one that is depends on the machine: it took the write every
 * time locally and the marker on the runner, where the test then read 200 off
 * the marker and reported the guardrail broken. Do not widen it back.
 *
 * @param body The exact text the write carries, which tells this write from any
 *   other the screen may have in flight.
 */
function messageWriteResponse(page: Page, body: string): Promise<Response> {
  return page.waitForResponse((response) => {
    if (response.request().method() !== "POST") {
      return false;
    }
    // Exactly one segment after the room: the marker carries a second, "read".
    if (!/^\/api\/chat\/[^/]+$/.test(new URL(response.url()).pathname)) {
      return false;
    }
    return (response.request().postData() ?? "").includes(body);
  });
}

/** The identifier of the room this account is in, read over HTTP. */
async function boardChatId(page: Page): Promise<string> {
  const response = await page.request.get(`${stack.baseUrl}/api/chat`);
  expect(response.ok()).toBe(true);
  const { rooms } = (await response.json()) as {
    rooms: { id: string; kind: string }[];
  };
  const board = rooms.find((room) => room.kind === "BOARD");
  if (board === undefined) {
    throw new Error("this account is in no board chat");
  }
  return board.id;
}

test.describe("the board's chat", () => {
  test("somebody who lives here is not offered the room, and is told why", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    await ensureFixtureAccount(
      request,
      people,
      NO_SEAT,
      clientAddressFor(clientAddress, "no-seat"),
    );

    await browseAs(page, clientAddress, "no-seat");
    await signInThroughTheScreen(page, NO_SEAT.email, NO_SEAT.password);

    await page.goto(appPath("/chat"));

    /*
     * The navigation, asserted here rather than on the screen the sign-in lands
     * on: the address book builds its band from the three capabilities its own
     * register request already proved, deliberately, rather than from the
     * viewer's full list, so that band carries no chat entry for anybody and an
     * assertion there would pass whatever this change did. This screen's band
     * is the viewer's own.
     *
     * The destination is offered, because a group is his to make. What is not
     * his is the board's room, and the screen says so rather than leaving him
     * looking at an empty page.
     */
    await expect(
      page.getByRole("link", { name: "Chatt", exact: true }),
    ).not.toHaveCount(0);

    // And the screen itself: the assertion that would still hold if the
    // navigation were rebuilt tomorrow.
    await expect(
      page.getByText("Du är inte med i något rum än.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("Gruppens namn")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Styrelsechatten" }),
    ).toHaveCount(0);

    /*
     * The boundary is the server's and not the screen's. Hiding a control is
     * courtesy; what keeps a resident out of the board's own deliberation is
     * the seat the service asks the register for, asked here with his own
     * session from the browser holding it.
     */
    const answered = await page.request.get(`${stack.baseUrl}/api/chat`);
    expect(answered.ok()).toBe(true);
    const mine = (await answered.json()) as {
      rooms: { kind: string }[];
      mayCreateGroup: boolean;
    };
    expect(mine.rooms.some((room) => room.kind === "BOARD")).toBe(false);
    expect(mine.mayCreateGroup).toBe(true);
  });

  test("a message written in one browser reaches the other without a reload", async ({
    page,
    context,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    const seatedId = await ensureFixtureAccount(
      request,
      people,
      SEATED,
      clientAddressFor(clientAddress, "seated"),
    );
    await grantBoardSeat(seatedId);

    const colleagueAddress = clientAddressFor(clientAddress, "colleague");
    const colleague = await ensureBoardMemberOfOurOwn(
      request,
      colleagueAddress,
      "kollega",
    );

    // --- the seat that is going to be watching ---------------------------
    await browseAs(page, clientAddress, "seated");
    await signInThroughTheScreen(page, SEATED.email, SEATED.password);

    await page.goto(appPath("/chat"));
    await expect(
      page.getByRole("heading", { name: "Styrelsechatten" }),
    ).toBeVisible();

    /*
     * The destination is offered to this seat, which is the counterpart of the
     * resident's absence in the test above, and asserted on the same screen for
     * the same reason: this band is the viewer's own list, and the one the
     * sign-in lands on is not.
     *
     * Attached rather than visible, and never pressed. The band is one unwrapped
     * flex row that neither scrolls nor collapses above the small breakpoint, so
     * a board member's destinations do not all fit at this window width and the
     * ones past the fifth are off screen. Whether a link is on screen is a
     * question about the width of the window; whether it is there at all is the
     * question about the account, and that is the one this spec asks. Every
     * other spec in this suite reaches a destination by its address.
     */
    await expect(
      page.getByRole("link", { name: "Chatt", exact: true }).first(),
    ).toBeAttached();

    /*
     * A second browser context, which is a second person at a second machine:
     * its own cookie jar and its own client address, so the two do not share a
     * sign-in budget.
     */
    const second = await context.browser()?.newContext({
      baseURL: stack.baseUrl,
      locale: "sv-SE",
      extraHTTPHeaders: { "x-forwarded-for": colleagueAddress },
    });
    if (second === undefined) {
      throw new Error("the browser could not open a second context");
    }

    try {
      const other = await second.newPage();
      await signInThroughTheScreen(other, colleague.email, colleague.password);
      await other.goto(appPath("/chat"));
      await expect(
        other.getByRole("heading", { name: "Styrelsechatten" }),
      ).toBeVisible();

      const said = `Taket ar klart pa tisdag. ${String(Date.now())}`;
      await other.getByLabel("Ditt meddelande").fill(said);
      await other.getByRole("button", { name: "Skicka meddelandet" }).click();

      /*
       * The whole point of the file. The first screen was never reloaded and
       * never navigated: the line arrives because the poll brought it.
       *
       * Asserted by waiting for the text rather than by waiting out the
       * interval. Playwright retries until it is there, so this passes as soon
       * as the first poll after the write lands and does not care how long that
       * took - and a spec that slept the interval instead would be asserting
       * the clock and would flake the day the machine was busy.
       */
      await expect(page.getByText(said)).toBeVisible();

      // And the writer's own screen shows it too, having read it back rather
      // than having put it there: nothing in this client is optimistic.
      await expect(other.getByText(said)).toBeVisible();
      await expect(other.getByLabel("Ditt meddelande")).toHaveValue("");
    } finally {
      await second.close();
    }
  });

  test("a personal identity number is refused, and never travels back", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    const people = await ensureRegisterFixture(request);
    const seatedId = await ensureFixtureAccount(
      request,
      people,
      SEATED,
      clientAddressFor(clientAddress, "guardrail"),
    );
    await grantBoardSeat(seatedId);

    await browseAs(page, clientAddress, "guardrail");
    await signInThroughTheScreen(page, SEATED.email, SEATED.password);
    await page.goto(appPath("/chat"));
    await expect(
      page.getByRole("heading", { name: "Styrelsechatten" }),
    ).toBeVisible();

    /*
     * Shaped like a personal identity number, valid by its checksum, and
     * belonging to nobody. It has to pass the checksum or the guardrail would
     * have nothing to refuse.
     */
    const written = "Det ar 19811218-9876 som star i lagenhetsforteckningen.";

    // Narrow on purpose - see the helper for the second POST it has to exclude.
    const answered = messageWriteResponse(page, written);
    await page.getByLabel("Ditt meddelande").fill(written);
    await page.getByRole("button", { name: "Skicka meddelandet" }).click();
    const response = await answered;

    expect(response.status()).toBe(422);
    /*
     * The refusal names the position in the text and never the value. This is
     * the assertion that would catch a change putting the matched digits into a
     * response body, which is exactly where they must not be.
     */
    expect(await response.text()).not.toContain("19811218");

    await expect(
      page.getByText("innehåller ett personnummer", { exact: false }),
    ).toBeVisible();
    // The writer takes the number out themselves, so what they wrote stays.
    await expect(page.getByLabel("Ditt meddelande")).toHaveValue(written);
  });

  test("the messages before the first page are one press away", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureRegisterFixture(request);

    /*
     * A board member of this run's own, rather than the shared fixture person
     * the tests above sign in as.
     *
     * The fixture people persist, and the write budget is counted from the rows
     * themselves: sixty messages per person in ten minutes. Fifty-two of those
     * are spent below, so a second run against a stack that is still up - which
     * `OPENBRF_E2E_REUSE_STACK` exists for - would find the previous run's
     * fifty-two still inside the window and be refused partway through the loop.
     * A person minted for this run starts with the whole budget.
     */
    const pagingAddress = clientAddressFor(clientAddress, "paging");
    const author = await ensureBoardMemberOfOurOwn(
      request,
      pagingAddress,
      "sidbrytning",
    );

    await browseAs(page, clientAddress, "paging");
    await signInThroughTheScreen(page, author.email, author.password);
    const chatId = await boardChatId(page);

    /*
     * A room longer than one page, written over HTTP rather than through the
     * box: fifty-one presses would be a slow way to arrange a precondition, and
     * what is under test is the paging rather than the writing.
     *
     * Fifty-two of them, which is two messages past the fifty a page holds and
     * the least that puts the oldest behind a press. The author is this run's
     * own, so the whole sixty-per-ten-minutes budget is there to spend. The
     * oldest is written first and is what the press has to reveal.
     */
    const oldest = `Aldsta raden. ${String(Date.now())}`;
    const first = await page.request.post(
      `${stack.baseUrl}/api/chat/${chatId}`,
      { data: { body: oldest } },
    );
    expect(first.status()).toBe(201);

    for (let index = 0; index < 51; index += 1) {
      const written = await page.request.post(
        `${stack.baseUrl}/api/chat/${chatId}`,
        { data: { body: `Rad ${String(index)}.` } },
      );
      expect(
        written.status(),
        `writing message ${String(index)} answered ${String(written.status())}`,
      ).toBe(201);
    }

    await page.goto(appPath("/chat"));
    await expect(
      page.getByRole("heading", { name: "Styrelsechatten" }),
    ).toBeVisible();

    const earlier = page.getByRole("button", {
      name: "Visa tidigare meddelanden",
    });
    /*
     * Waited on before the absence below. This control appears only once the
     * client holds a page with an earlier cursor, so it is the signal that the
     * newest page has rendered. Asked first, the absence would pass on an empty
     * screen and prove nothing about paging.
     */
    await expect(earlier).toBeVisible();

    // The newest page, so the oldest line is behind it rather than missing.
    await expect(page.getByText(oldest)).toHaveCount(0);

    // Pressed until the room runs out, because fifty-two messages is two pages
    // and the oldest is on the second.
    for (let press = 0; press < 3; press += 1) {
      if (!(await earlier.isVisible())) {
        break;
      }
      await earlier.click();
      if (await page.getByText(oldest).isVisible()) {
        break;
      }
    }

    await expect(page.getByText(oldest)).toBeVisible();
  });
});
