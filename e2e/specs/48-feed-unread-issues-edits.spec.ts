import {
  type APIRequestContext,
  type Locator,
  type Page,
  request as playwrightRequest,
} from "@playwright/test";

import { createIssueType, signIn } from "../src/api";
import {
  audienceId,
  browseAs,
  ensureBoardMember,
  ensureResident,
  type FeedPerson,
  openFeed,
  postCard,
  signInThroughTheScreen,
  writePostThroughTheScreen,
} from "../src/feed";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { uniqueSurname } from "../src/identity";
import { offeredDestinationsWithCounts } from "../src/navigation";
import { ensureInstance } from "../src/provision";
import { pngPicture } from "../src/site";
import { appPath } from "../src/stack";

/**
 * What the feed does beyond a noticeboard (ADR 0026): unread kept live, a post
 * made into an issue report, the board's must-read list, and edits that keep
 * what they replaced.
 *
 * **Unread, live.** A neighbour on another screen sees "Flöde" count a post
 * written meanwhile within one poll of the navigation, and on the feed a line
 * marks what is new since their last visit.
 *
 * **A post becomes an issue report.** Its writer presses "Gör felanmälan", and
 * the form opens with the post's text and image in it. The report is linked to
 * the post, which then shows the writer where the report stands - and shows the
 * neighbour nothing of it.
 *
 * **Edit with history.** The writer edits their post, which then reads
 * "Redigerat" to everybody; the writer and the board read the earlier version,
 * the neighbour neither on screen nor from the endpoint.
 *
 * **Must-read.** On an important post the board lists who in the audience has
 * not opened it; the neighbour is on that list until they have had it on
 * screen, and is refused the list themselves.
 *
 * That a comment is edited on the same terms, that the history and the read
 * records are erased with the post and are on the access report, and that a
 * group's post is answered by id exactly as one that does not exist, is
 * `apps/api/src/feed/feed-additions.int-spec.ts`.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "lasvarda-linden-2026";

/** What this run writes, unique so a kept stack reads its own. */
const RUN = String(Date.now());
const LIVE = `Någon har lämnat en barnvagn i porten. ${RUN}`;
const BROKEN = `Lampan i trapphuset blinkar igen. ${RUN}`;
const ORIGINAL = `Grillen på gården är ledig på fredag. ${RUN}`;
const EDITED = `Grillen på gården är ledig på lördag. ${RUN}`;
const IMPORTANT = `Stamspolning på tisdag ${RUN}`;
const ISSUE_TYPE = uniqueSurname("Belysning");

let writer: FeedPerson | null = null;
let neighbour: FeedPerson | null = null;
let board: FeedPerson | null = null;

function made<T>(what: T | null, name: string): T {
  if (what === null) {
    throw new Error(`${name} was not made: an earlier test did not finish`);
  }
  return what;
}

/** A request context signed in as somebody, beside the browser. */
async function signedInAs(
  clientAddress: string,
  person: FeedPerson,
  persona: string,
): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: {
      "x-forwarded-for": clientAddressFor(clientAddress, persona),
    },
  });
  await signIn(context, stack.baseUrl, {
    email: person.email,
    password: person.password,
  });
  return context;
}

/** How "Flöde" reads in the navigation, count and all. */
async function feedSign(page: Page): Promise<string> {
  const names = await offeredDestinationsWithCounts(page);
  return names.find((name) => name.startsWith("Flöde")) ?? "";
}

/** Opens a post's "⋯" and answers the menu it opened. */
async function openMenu(card: Locator, author: string): Promise<Locator> {
  await card
    .getByRole("button", { name: `Fler val för inlägget från ${author}` })
    .click();
  return card.getByRole("listitem");
}

test.describe("the feed's additions", () => {
  test("a post written meanwhile is counted live, and marked as new on the feed", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    // Three people made, and a wait of up to one navigation poll.
    test.setTimeout(150_000);
    await ensureInstance(request);
    writer = await ensureResident(request, {
      firstName: "Signe",
      local: "lasvard-signe",
      clientAddress: clientAddressFor(clientAddress, "writer"),
      password: PASSWORD,
    });
    neighbour = await ensureResident(request, {
      firstName: "Arvid",
      local: "lasvard-arvid",
      clientAddress: clientAddressFor(clientAddress, "neighbour"),
      password: PASSWORD,
    });
    board = await ensureBoardMember(request, {
      firstName: "Maj",
      local: "lasvard-maj",
      clientAddress: clientAddressFor(clientAddress, "board"),
      password: PASSWORD,
    });
    await createIssueType(request, stack.baseUrl, {
      name: ISSUE_TYPE,
      audience: "MEMBER",
    });

    // The neighbour reads the feed to the end, which is their last visit.
    const reader = made(neighbour, "the neighbour");
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, reader);
    const marked = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/feed\/audiences\/[^/]+\/read$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await openFeed(page);
    expect((await marked).ok()).toBe(true);

    // On another screen, with nothing unread.
    await page.goto(appPath("/issues"));
    await expect.poll(() => feedSign(page)).toBe("Flöde");

    // The writer posts to Alla from a browser of their own.
    const author = await signedInAs(
      clientAddress,
      made(writer, "the writer"),
      "writer",
    );
    try {
      const alla = await audienceId(page, { kind: "ALL" });
      const written = await author.post(`${stack.baseUrl}/api/feed/posts`, {
        data: { audienceId: alla, body: LIVE },
      });
      expect(written.status()).toBe(201);
    } finally {
      await author.dispose();
    }

    // The navigation polls every thirty seconds away from the feed: one poll,
    // and some room for the request itself.
    await expect
      .poll(() => feedSign(page), { timeout: 45_000 })
      .toMatch(/^Flöde\s*1$/);

    // On the feed, the post is signed new since the last visit.
    await openFeed(page);
    await expect(postCard(page, LIVE)).toBeVisible();
    await expect(
      postCard(page, LIVE).getByText("Nytt", { exact: true }),
    ).toBeVisible();

    // Having read it, the count is gone.
    await expect.poll(() => feedSign(page)).toBe("Flöde");
  });

  test("a writer makes an issue report of their post, and only they see where it stands", async ({
    page,
    clientAddress,
  }) => {
    const author = made(writer, "the writer");
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, author);
    await openFeed(page);
    await writePostThroughTheScreen(page, BROKEN, [
      { name: "lampa.png", buffer: pngPicture(24, 24) },
    ]);

    const menu = await openMenu(postCard(page, BROKEN), author.name);
    await menu.getByRole("button", { name: "Gör felanmälan" }).click();
    await expect(page).toHaveURL(/\/issues\?post=/);
    const postId = new URL(page.url()).searchParams.get("post") ?? "";
    expect(postId).not.toBe("");

    // The form opens with the post's text and its image.
    await expect(page.getByLabel("Vad har hänt")).toHaveValue(BROKEN);
    await expect(page.getByText(/^Bild 1 från inlägget/)).toBeVisible();

    await page.getByLabel("Vad gäller det").selectOption({ label: ISSUE_TYPE });
    await page.getByLabel("Var i huset").fill("Trapphuset, port 2");
    const filed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/issues",
    );
    await page.getByRole("button", { name: "Skicka anmälan" }).click();
    expect((await filed).status()).toBe(201);
    await expect(
      page.getByText(
        "Anmälan är kopplad till inlägget, och där syns hur det går med den.",
      ),
    ).toBeVisible();

    // Back on the post, the report's status is on it, and it cannot be
    // reported a second time.
    await page.getByRole("link", { name: "Tillbaka till inlägget" }).click();
    const card = postCard(page, BROKEN);
    await expect(card.getByText("Felanmälan:")).toBeVisible();
    await expect(card.getByText("Ny", { exact: true })).toBeVisible();
    const again = await openMenu(card, author.name);
    await expect(
      again.getByRole("button", { name: "Gör felanmälan" }),
    ).toHaveCount(0);

    // The neighbour reads the post, and nothing of the report.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, made(neighbour, "the neighbour"));
    await page.goto(appPath(`/feed/${postId}`));
    const theirs = postCard(page, BROKEN);
    await expect(theirs).toBeVisible();
    await expect(theirs.getByText("Felanmälan:")).toHaveCount(0);
    const offered = await openMenu(theirs, author.name);
    await expect(
      offered.getByRole("button", { name: "Gör felanmälan" }),
    ).toHaveCount(0);
  });

  test("an edited post keeps what it said, for its writer and the board alone", async ({
    page,
    clientAddress,
  }) => {
    const author = made(writer, "the writer");
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, author);
    await openFeed(page);
    await writePostThroughTheScreen(page, ORIGINAL);

    const menu = await openMenu(postCard(page, ORIGINAL), author.name);
    await menu.getByRole("button", { name: "Redigera" }).click();
    const editing = page.getByRole("dialog", { name: "Redigera inlägget" });
    await editing.getByLabel("Inlägget").fill(EDITED);
    await editing.getByRole("button", { name: "Spara" }).click();
    await expect(editing).toHaveCount(0);

    const card = postCard(page, EDITED);
    await expect(card).toBeVisible();
    await expect(card.getByText("Redigerat")).toBeVisible();
    await (
      await openMenu(card, author.name)
    )
      .getByRole("button", { name: "Tidigare versioner" })
      .click();
    const history = page.getByRole("dialog", {
      name: `Tidigare versioner av inlägget från ${author.name}`,
    });
    await expect(history.getByText(ORIGINAL)).toBeVisible();
    await history.getByRole("button", { name: "Stäng" }).click();
    const postId = (
      await card.locator('a[href*="/feed/"]').getAttribute("href")
    )
      ?.split("/")
      .at(-1);
    expect(postId).toBeDefined();

    // The neighbour sees that it was edited, and not what it said before.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, made(neighbour, "the neighbour"));
    await openFeed(page);
    const theirs = postCard(page, EDITED);
    await expect(theirs.getByText("Redigerat")).toBeVisible();
    await expect(page.getByText(ORIGINAL)).toHaveCount(0);
    const offered = await openMenu(theirs, author.name);
    await expect(
      offered.getByRole("button", { name: "Tidigare versioner" }),
    ).toHaveCount(0);
    await expect(offered.getByRole("button", { name: "Redigera" })).toHaveCount(
      0,
    );
    const withheld = await page.request.get(
      `${stack.baseUrl}/api/feed/posts/${postId ?? ""}/revisions`,
    );
    expect(withheld.status()).toBe(422);
    expect(((await withheld.json()) as { reason: string }).reason).toBe(
      "history-withheld",
    );
    const rewritten = await page.request.patch(
      `${stack.baseUrl}/api/feed/posts/${postId ?? ""}`,
      { data: { body: "Det här skrev jag." } },
    );
    expect(rewritten.status()).toBe(422);
    expect(((await rewritten.json()) as { reason: string }).reason).toBe(
      "not-editable",
    );

    // The board reads the earlier version.
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    await openFeed(page);
    await (
      await openMenu(postCard(page, EDITED), author.name)
    )
      .getByRole("button", { name: "Tidigare versioner" })
      .click();
    await expect(
      page
        .getByRole("dialog", {
          name: `Tidigare versioner av inlägget från ${author.name}`,
        })
        .getByText(ORIGINAL),
    ).toBeVisible();
  });

  test("the board lists who has not opened an important post, until they have", async ({
    page,
    clientAddress,
  }) => {
    const reader = made(neighbour, "the neighbour");
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    const alla = await audienceId(page, { kind: "ALL" });
    const written = await page.request.post(
      `${stack.baseUrl}/api/feed/board-posts`,
      {
        data: {
          audienceId: alla,
          title: IMPORTANT,
          body: "Vattnet är avstängt 8-12. Spola inte under tiden.",
          namesAuthor: false,
          important: true,
        },
      },
    );
    expect(written.status()).toBe(201);
    const { id: postId } = (await written.json()) as { id: string };

    await openFeed(page);
    const controls = postCard(page, IMPORTANT).getByRole("group", {
      name: "Styrelsen",
    });
    await controls
      .getByRole("button", { name: "Vilka har inte läst?" })
      .click();
    const notRead = controls.getByRole("region", {
      name: "Har inte läst inlägget",
    });
    await expect(notRead.getByText(reader.name)).toBeVisible();

    // The neighbour has the post on screen, which is opening it, and is not
    // offered the list.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, reader);
    const opened = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/feed/posts/${postId}/read`,
    );
    await openFeed(page);
    const theirs = postCard(page, IMPORTANT);
    await theirs.scrollIntoViewIfNeeded();
    expect((await opened).ok()).toBe(true);
    await expect(
      theirs.getByRole("button", { name: "Vilka har inte läst?" }),
    ).toHaveCount(0);
    const refused = await page.request.get(
      `${stack.baseUrl}/api/feed/posts/${postId}/not-read`,
    );
    expect(refused.status()).toBe(422);
    expect(((await refused.json()) as { reason: string }).reason).toBe(
      "not-board",
    );

    // And the board's list no longer names them.
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    await openFeed(page);
    const again = postCard(page, IMPORTANT).getByRole("group", {
      name: "Styrelsen",
    });
    await again.getByRole("button", { name: "Vilka har inte läst?" }).click();
    await expect(
      page.getByText(
        /i målgruppen har inte öppnat inlägget än|Alla i målgruppen har öppnat inlägget/,
      ),
    ).toBeVisible();
    await expect(again.getByText(reader.name)).toHaveCount(0);
  });
});
