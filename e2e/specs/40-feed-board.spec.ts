import type { APIRequestContext, Page, Response } from "@playwright/test";

import {
  audienceButton,
  audienceId,
  browseAs,
  ensureBoardMember,
  openFeed,
  signInThroughTheScreen,
  writePostThroughTheScreen,
} from "../src/feed";
import { grantBoardSeat } from "../src/board";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { offeredDestinations } from "../src/navigation";
import { ensureAccountFor, ensureRegisterFixture } from "../src/provision";

/**
 * The board's audience in the feed (Styrelsen), which is what the board chat
 * became, as far as a deployed instance can show it.
 *
 * What is here is the half that only exists once the image is serving one
 * origin and two browsers are looking at it at the same time.
 *
 * **A post written in one browser appears in the other without a reload.**
 * That is the whole claim delivery makes, and nothing but two live contexts can
 * test it: the unit tests hold the poll's mechanics and the integration suite
 * holds what the endpoints answer, and neither of them has a second screen open.
 * It is asserted by waiting for the text, with Playwright's own retry, which
 * passes as soon as the first poll after the write lands and does not care how
 * long that took. Never by waiting out the interval - a spec that slept four
 * seconds would be asserting the clock rather than the delivery.
 *
 * **Somebody who lives here is not in Styrelsen, and is refused it by
 * identifier exactly as something that does not exist.** They reach the feed -
 * Alla is theirs - and the board's audience is not among the ones they are
 * answered with. Asserted against the endpoint as well as against the screen,
 * because what keeps a resident out of the board's deliberation is the seat the
 * service asks the register for rather than anything the browser renders.
 *
 * **A personal identity number is refused, and the refusal does not carry it
 * back.** The response is read as well as the screen, because the thing the scan
 * caught is exactly the thing that must not travel back into a body, a log or a
 * screen somebody else is looking at.
 *
 * **The posts before the first page are one press away.** The feed is read a
 * page at a time from its newest end, and a feed that stopped at fifty with
 * nothing saying so would be a feed with posts missing from it.
 *
 * Deliberately absent: the administrator holding the capability and finding no
 * audience. Three earlier specs put the shared administrator on the board, so on
 * this instance they hold a seat. That case is
 * `apps/api/src/feed/feed.int-spec.ts`, which builds its own people.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this file's own invention would fail that probe.
 */
const PASSWORD = "granngarden-kastanj-2026";

/** The password for the board members this spec creates for itself. */
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
 * case for an account the board's audience is not for.
 */
const NO_SEAT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * A fixture person, with an account they can sign in with.
 *
 * Narrowed here rather than read through `?.` at the call sites: a run whose
 * register is missing somebody has to fail on the line that says so.
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
 * The response to a post write, and never to anything else the screen posts.
 *
 * Several routes under `/api/feed/` take a POST while the feed is open: the post
 * write at `/api/feed/posts`, the read marker at `/api/feed/audiences/:id/read`
 * and the read record at `/api/feed/posts/:id/read`, which the screen posts as
 * soon as it has shown something - so they are in flight together whenever
 * somebody opens the feed and writes.
 *
 * So this matches one route and one body rather than the prefix. A predicate
 * that matched `/api/feed/` and a POST resolves on whichever lands first, and
 * which one that is depends on the machine. Do not widen it back.
 */
function postWriteResponse(page: Page, body: string): Promise<Response> {
  return page.waitForResponse((response) => {
    if (response.request().method() !== "POST") {
      return false;
    }
    if (new URL(response.url()).pathname !== "/api/feed/posts") {
      return false;
    }
    return (response.request().postData() ?? "").includes(body);
  });
}

/** Opens the feed with Styrelsen chosen, and waits until it is. */
async function openStyrelsen(page: Page): Promise<void> {
  await openFeed(page);
  await audienceButton(page, "Styrelsen").click();
  await expect(
    page.getByRole("heading", { name: "Styrelsen", exact: true }),
  ).toBeVisible();
}

test.describe("the board's audience in the feed", () => {
  test("somebody who lives here is not in it, and is refused it like nothing at all", async ({
    page,
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
    await ensureFixtureAccount(
      request,
      people,
      NO_SEAT,
      clientAddressFor(clientAddress, "no-seat"),
    );

    // The board's audience, as a seat holder is answered with it.
    await browseAs(page, clientAddress, "seated");
    await signInThroughTheScreen(page, SEATED);
    const boardId = await audienceId(page, { kind: "BOARD" });

    await browseAs(page, clientAddress, "no-seat");
    await signInThroughTheScreen(page, NO_SEAT);
    const audiences = await openFeed(page);

    /*
     * The destination is offered, because Alla is his. What is not his is the
     * board's audience: not on the list the screen is sent, and not among the
     * audiences the screen shows.
     */
    await expect.poll(() => offeredDestinations(page)).toContain("Flöde");
    expect(audiences.some((audience) => audience.kind === "BOARD")).toBe(false);
    expect(audiences.some((audience) => audience.kind === "ALL")).toBe(true);
    await expect(audienceButton(page, "Alla")).toBeVisible();
    await expect(audienceButton(page, "Styrelsen")).toHaveCount(0);

    /*
     * The boundary is the server's and not the screen's, asked here with his own
     * session from the browser holding it. The board's audience by identifier
     * and an identifier that names nothing have to be one answer.
     */
    const refused = await page.request.get(
      `${stack.baseUrl}/api/feed/posts?audience=${encodeURIComponent(boardId)}`,
      { failOnStatusCode: false },
    );
    const absent = await page.request.get(
      `${stack.baseUrl}/api/feed/posts?audience=audience-nothing-at-all`,
      { failOnStatusCode: false },
    );
    expect(refused.status()).toBe(404);
    expect(absent.status()).toBe(refused.status());
    expect(await absent.json()).toEqual(await refused.json());
  });

  test("a post written in one browser reaches the other without a reload", async ({
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
    const colleague = await ensureBoardMember(request, {
      firstName: "Bo",
      local: "flode-kollega",
      clientAddress: colleagueAddress,
      password: COLLEAGUE_PASSWORD,
    });

    // --- the seat that is going to be watching ---------------------------
    await browseAs(page, clientAddress, "seated");
    await signInThroughTheScreen(page, SEATED);
    await openStyrelsen(page);
    await expect.poll(() => offeredDestinations(page)).toContain("Flöde");

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
      await signInThroughTheScreen(other, colleague);
      await openStyrelsen(other);

      const said = `Taket är klart på tisdag. ${String(Date.now())}`;
      await writePostThroughTheScreen(other, said);

      /*
       * The whole point of the file. The first screen was never reloaded and
       * never navigated: the post arrives because the poll brought it, and it
       * says where it was written.
       */
      await expect(page.getByText(said)).toBeVisible();
      await expect(
        page.getByRole("article").filter({ hasText: said }),
      ).toContainText(colleague.name);
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
    await signInThroughTheScreen(page, SEATED);
    await openStyrelsen(page);

    /*
     * Shaped like a personal identity number, valid by its checksum, and
     * belonging to nobody. It has to pass the checksum or the guardrail would
     * have nothing to refuse.
     */
    const written = "Det är 19811218-9876 som står i lägenhetsförteckningen.";

    await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
    const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
    await dialog.getByLabel("Text").fill(written);
    // Narrow on purpose - see the helper for the other POSTs it has to exclude.
    const answered = postWriteResponse(page, written);
    await dialog.getByRole("button", { name: "Skapa" }).click();
    const response = await answered;

    expect(response.status()).toBe(422);
    /*
     * The refusal names the position in the text and never the value. This is
     * the assertion that would catch a change putting the matched digits into a
     * response body, which is exactly where they must not be.
     */
    expect(await response.text()).not.toContain("19811218");

    await expect(
      dialog.getByText("innehåller ett personnummer", { exact: false }),
    ).toBeVisible();
    // The writer takes the number out themselves, so what they wrote stays.
    await expect(dialog.getByLabel("Text")).toHaveValue(written);
  });

  test("the posts before the first page are one press away", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureRegisterFixture(request);

    /*
     * A board member of this run's own, rather than the shared fixture person.
     *
     * The write budget is counted from the rows themselves: sixty posts per
     * person in ten minutes. Fifty-two of those are spent below, so a second run
     * against a stack that is still up would find the previous run's fifty-two
     * still inside the window. A person minted for this run starts with the
     * whole budget.
     */
    const author = await ensureBoardMember(request, {
      firstName: "Bo",
      local: "flode-sidbrytning",
      clientAddress: clientAddressFor(clientAddress, "paging"),
      password: COLLEAGUE_PASSWORD,
    });

    await browseAs(page, clientAddress, "paging");
    await signInThroughTheScreen(page, author);
    const boardId = await audienceId(page, { kind: "BOARD" });

    /*
     * A feed longer than one page, written over HTTP rather than through the
     * composer: fifty-one dialogs would be a slow way to arrange a precondition,
     * and what is under test is the paging rather than the writing. Fifty-two,
     * two past the fifty a page holds; the oldest is written first and is what
     * the press has to reveal.
     */
    const oldest = `Äldsta inlägget. ${String(Date.now())}`;
    const first = await page.request.post(`${stack.baseUrl}/api/feed/posts`, {
      data: { audienceId: boardId, body: oldest },
    });
    expect(first.status()).toBe(201);

    for (let index = 0; index < 51; index += 1) {
      const written = await page.request.post(
        `${stack.baseUrl}/api/feed/posts`,
        { data: { audienceId: boardId, body: `Inlägg ${String(index)}.` } },
      );
      expect(
        written.status(),
        `writing post ${String(index)} answered ${String(written.status())}`,
      ).toBe(201);
    }

    await openStyrelsen(page);

    const earlier = page.getByRole("button", { name: "Visa tidigare inlägg" });
    /*
     * Waited on before the absence below. This control appears only once the
     * client holds a page with an earlier cursor, so it is the signal that the
     * newest page has rendered. Asked first, the absence would pass on an empty
     * screen and prove nothing about paging.
     */
    await expect(earlier).toBeVisible();
    await expect(page.getByText(oldest)).toHaveCount(0);

    // One press. The oldest is the fifty-second newest, which puts it on the
    // second page whatever the audience held before this test wrote to it.
    await earlier.click();
    await expect(page.getByText(oldest)).toBeVisible();
  });
});
