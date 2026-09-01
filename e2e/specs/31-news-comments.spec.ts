import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { clientAddressFor, expect, test } from "../src/fixtures";
import { createNews, listNews, publishNews } from "../src/news";
import {
  ADMINISTRATOR,
  ensureAccountFor,
  ensureRegisterFixture,
} from "../src/provision";
import { appPath } from "../src/stack";

/**
 * Comments on the association's news, through the browser.
 *
 * Not one of the numbered exit criteria. It is here because the module's central
 * property is what a hidden comment looks like, and that is one payload decided
 * per reader: the same comment arrives with its text for the board and for
 * whoever wrote it, and without it for everybody else. Nothing but a browser, the
 * API and three real sessions can show that the three readers are answered
 * differently and that the screen renders each answer as it is given.
 *
 * The person who writes is Nils Lindqvist, and that is the second reason this
 * file exists. The shared register fixture holds him and Astrid Lindqvist in the
 * same apartment, she with the tenant-ownership and he without - and spec 30
 * asserts that the platform offers him no motion at all, because EFL 6 kap. 15 §
 * gives that right to a member. Answering a notice about the building he lives in
 * is nothing of the kind: `news:comment` is granted by the residency, so the
 * person offered no motion form is offered the comment box. Membership adds
 * exactly one capability in this platform, and this is not it.
 *
 * The third reader is Karl Berg, on another stairwell, and the one the text is
 * withheld from. Who that reader can be is a fact about this shared instance
 * rather than a preference - see the fixture below.
 *
 * The rest is what the board can and cannot do. It can strike a comment through,
 * and afterwards the comment is still on the thread with its author still named;
 * there is no control that takes a strike-through back, because what somebody
 * wrote is a record of what was said. And a comment carrying a personal identity
 * number is refused before it reaches the thread, which is the one guardrail in
 * this codebase that protects a member from themselves.
 */

test.describe.configure({ mode: "serial" });

/**
 * The password the shared fixture accounts are activated with.
 *
 * It has to stay the literal spec 03 uses: that spec activates these accounts,
 * and `ensureAccountFor` establishes its idempotency by signing in before it
 * invites, so a password of this spec's own invention would fail that probe, fall
 * through to an invitation, and be refused for an account that already exists.
 */
const PASSWORD = "granngarden-kastanj-2026";

/**
 * From the shared fixture: 12/1001, and recorded RESIDENT rather than MEMBER.
 *
 * He holds no tenant-ownership, so he is the reader this file is about. The
 * notice is addressed to the house he lives in, and the capability to answer it
 * follows from living there.
 */
const AUTHOR = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: PASSWORD,
} as const;

/**
 * Another resident on the property: 14/1001, and the reader the text is withheld
 * from.
 *
 * Karl Berg rather than Astrid Lindqvist, who lives in the author's own
 * apartment and would otherwise be the obvious choice. Spec 27 puts her on the
 * board as chair to photograph the roster block, and a board seat carries
 * `site:manage` - so on this shared instance she is a moderator, and a moderator
 * reads a struck comment's text by design. She cannot stand for the neighbour it
 * is kept from.
 */
const NEIGHBOUR = {
  name: "Karl Berg",
  email: "karl@eksemplet.test",
  password: PASSWORD,
} as const;

/** Run-unique, so a rerun against a kept stack cannot collide with its own rows. */
const suffix = Date.now().toString(36);

const NOTICE = {
  slug: `portkoden-byts-${suffix}`,
  title: `Portkoden byts ${suffix}`,
  paragraph: `Vi byter portkod på lördag klockan tio, ${suffix}.`,
} as const;

/** The comment the strike-through is applied to, unique to this run. */
const COMMENT = `Tack för beskedet, blir det nya brickor också? ${suffix}`;

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

type Persona = "administrator" | "author" | "neighbour";

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
 * Starts from a browser holding no session. These tests act as up to three
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
 * The instance every test here expects: the register fixture, accounts for the
 * two residents, and one published notice with a thread.
 *
 * The notice is published without a mailing. A comment spec has no business
 * putting post in anybody's mailbox, and the mailing is spec 23's subject.
 *
 * Idempotent against the database rather than against process state, like the
 * shared provisioning it builds on: every test in this file calls it, and a
 * second create would be refused for a slug that is already taken.
 */
async function ensureCommentFixture(
  request: APIRequestContext,
  clientAddress: string,
): Promise<void> {
  const people = await ensureRegisterFixture(request);

  for (const [person, persona] of [
    [AUTHOR, "author"],
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
      clientAddress: clientAddressFor(clientAddress, persona),
    });
  }

  const existing = (await listNews(request)).find(
    (one) => one.slug === NOTICE.slug,
  );
  const item =
    existing ??
    (await createNews(request, {
      slug: NOTICE.slug,
      title: NOTICE.title,
      paragraphs: [NOTICE.paragraph],
    }));
  if (!item.published) {
    /*
     * Published for the members rather than for anyone, which is the ordinary
     * case and the interesting one: a member-only notice has a thread that opens
     * to anybody signed in, and none of it reaches the website either way.
     */
    await publishNews(request, item.id, {
      published: true,
      visibility: "MEMBER",
    });
  }
}

/**
 * Opens the notice this file is about, and returns the thread's rows.
 *
 * The notice is opened by name rather than relied on to be the newest, even
 * though it is: which item a fresh screen opens is a decision about the newest
 * published notice in the whole instance, and the specs before this one publish
 * notices of their own.
 *
 * The rows are scoped to the thread's own card. The list of notices above it is
 * a list too, so an unscoped row locator would be answering about both - and a
 * test asserting that a comment is absent would pass on a screen that had put it
 * somewhere else.
 */
async function openTheNotice(page: Page): Promise<Locator> {
  await page.goto(appPath("/news"));
  await page.getByRole("button", { name: NOTICE.title }).first().click();
  // The body arrives with the list rather than with the click, and waiting for
  // it is what says the thread below belongs to this notice.
  await expect(page.getByText(NOTICE.paragraph)).toBeVisible();

  const thread = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kommentarer" }),
  });
  await expect(thread).toBeVisible();
  return thread.getByRole("listitem");
}

test.describe("comments on the association's news", () => {
  test("a resident who is not a member writes a comment and reads it back", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureCommentFixture(request, clientAddress);
    await browseAs(page, clientAddress, "author");
    await signInThroughTheScreen(page, AUTHOR.email, AUTHOR.password);

    /*
     * The destination is offered to him, which is the contrast with spec 30 at
     * the place a person would actually look: that spec asserts the same account
     * is offered no motions link, because the right in EFL 6 kap. 15 § belongs
     * to a member. Answering a notice is not that right.
     *
     * `.first()` because the shell renders the same links twice, once for the
     * band and once for the bottom bar on a narrow screen.
     */
    await page.goto(appPath("/news"));
    await expect(
      page.getByRole("link", { name: "Nyheter", exact: true }).first(),
    ).toBeVisible();

    const rows = await openTheNotice(page);

    await page.getByLabel("Din kommentar").fill(COMMENT);
    await page.getByRole("button", { name: "Skicka kommentaren" }).click();

    /*
     * The comment as the server read it back, not the form having been
     * submitted. Nothing on this screen is optimistic: the panel asks for the
     * thread again and renders what came back, so a row carrying this text is
     * the server saying the comment is on the thread.
     */
    const mine = rows.filter({ hasText: COMMENT }).first();
    await expect(mine).toBeVisible();
    await expect(mine).toContainText(AUTHOR.name);
    // And it stands: nothing has been struck through.
    await expect(mine).not.toContainText("Struken");
  });

  test("the board strikes it through, and it reads as struck to its author and as withheld to a neighbour", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureCommentFixture(request, clientAddress);

    // The board, who holds site:manage and therefore the only act there is.
    await browseAs(page, clientAddress, "administrator");
    await signInThroughTheScreen(
      page,
      ADMINISTRATOR.email,
      ADMINISTRATOR.password,
    );

    const boardRows = await openTheNotice(page);
    const onTheBoardsScreen = boardRows.filter({ hasText: COMMENT }).first();
    await expect(
      onTheBoardsScreen,
      "the comment written by the test above is gone",
    ).toBeVisible();

    await onTheBoardsScreen
      .getByRole("button", { name: `Stryk kommentaren från ${AUTHOR.name}` })
      .click();

    /*
     * Struck through, and still there. The board reads the text afterwards
     * because the strike-through withholds words from other readers rather than
     * removing them, and the sentence beside it says exactly who can still read
     * it.
     */
    const struck = boardRows.filter({ hasText: COMMENT }).first();
    await expect(struck).toContainText("Struken");
    await expect(struck).toContainText(AUTHOR.name);
    await expect(struck).toContainText(
      "Texten visas för styrelsen och för den som skrev den",
    );

    /*
     * And no way back. Hiding is a dated close that nothing clears: what the
     * board can do to a comment is strike it through, and what it cannot do is
     * make one disappear. There is no endpoint for it, and a control that only
     * ever failed would be a worse way of saying so.
     */
    for (const label of [/^Återställ/, /^Ta fram/, /^Ångra/, /^Ta bort/]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }

    // The neighbour: another resident, neither the board nor the author.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, NEIGHBOUR.email, NEIGHBOUR.password);

    const neighbourRows = await openTheNotice(page);
    const withheld = neighbourRows.filter({ hasText: AUTHOR.name }).first();
    await expect(withheld).toContainText("Struken");
    await expect(withheld).toContainText(
      "Styrelsen har tagit bort texten från tråden",
    );
    /*
     * The text itself is nowhere on his screen - not struck through, not dimmed,
     * absent. The server did not send it, and there is no rule in the browser
     * that could have withheld it: a screen that decided this for itself would
     * be showing an answer nothing enforces.
     */
    await expect(page.getByText(COMMENT)).toHaveCount(0);

    // And its author, who wrote it and is entitled to read what the board took
    // off the thread.
    await browseAs(page, clientAddress, "author");
    await signInThroughTheScreen(page, AUTHOR.email, AUTHOR.password);

    const authorRows = await openTheNotice(page);
    const mine = authorRows.filter({ hasText: COMMENT }).first();
    await expect(mine).toBeVisible();
    await expect(mine).toContainText("Struken");
    await expect(mine).toContainText(
      "Texten visas för styrelsen och för den som skrev den",
    );
    // He moderates nothing, so the control the board used is not on his screen.
    await expect(
      page.getByRole("button", { name: /^Stryk kommentaren/ }),
    ).toHaveCount(0);
  });

  test("a comment carrying a personal identity number is refused on the screen", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    /*
     * The guardrail's first appearance on a member's own writing rather than on
     * the board's. Somebody pastes a neighbour's details into a reply about a
     * dispute, and what stops the whole house reading it is this refusal - which
     * has to reach the screen as a sentence, because a scan the writer is not
     * told about is a comment they will try to send again.
     */
    await ensureCommentFixture(request, clientAddress);
    await browseAs(page, clientAddress, "author");
    await signInThroughTheScreen(page, AUTHOR.email, AUTHOR.password);

    const rows = await openTheNotice(page);
    const refused = `Det är ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER} som står på dörren, ${suffix}.`;

    await page.getByLabel("Din kommentar").fill(refused);
    await page.getByRole("button", { name: "Skicka kommentaren" }).click();

    const notice = page.getByText(/innehåller ett personnummer/);
    await expect(notice).toBeVisible();
    /*
     * The refusal names the rule and never the value. What the scan caught is
     * exactly what must not travel back into a response body, a log or a screen
     * - and this screen is read by everybody the notice was written for.
     */
    await expect(notice).not.toContainText(
      LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER,
    );

    // And the comment is not on the thread: the refusal stopped the write and
    // not only the answer.
    await expect(rows.filter({ hasText: refused })).toHaveCount(0);
  });
});
