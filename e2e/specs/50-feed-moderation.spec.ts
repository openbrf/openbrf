import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";

import { signIn } from "../src/api";
import {
  audienceId,
  browseAs,
  ensureBoardMember,
  ensureResident,
  type FeedPerson,
  openFeed,
  postCard,
  signInThroughTheScreen,
} from "../src/feed";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The board's moderation of Alla (ADR 0026).
 *
 * **A neighbour reports a post in Alla**, from its ⋯, and the dialog says the
 * board reads Alla already. The board finds the report in its queue under Alla,
 * with a link to the post.
 *
 * **The board strikes a resident's post in Alla from the feed**, without
 * waiting for a report: a control under the board's sign on the card, asked
 * once more before it strikes. The neighbours then read that the board struck
 * it, and not what it said, and the report it answered has left the queue.
 *
 * **The board strikes a comment in Alla** the same way, from the thread.
 *
 * The queue lists the oldest reports first, fifty to a page, and this spec
 * does not press "Visa fler anmälningar": on a reused stack it assumes fewer
 * than fifty reports are open.
 *
 * That the queue is paged past its first fifty, that a group is reached only
 * through a report and that a comment's report carries nothing of its post,
 * is `apps/api/src/feed/moderation.int-spec.ts`; reports out of a group are
 * `43-feed-groups.spec.ts`.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "moderera-alla-2026";

/** What this run writes, unique so a kept stack reads its own. */
const RUN = String(Date.now());
const POST = `Grannen i 3B spelar trummor mitt i natten. ${RUN}`;
const QUESTION = `Vem har nyckeln till cykelrummet? ${RUN}`;
const ANSWER = `Fråga någon som inte är så dum i huvudet. ${RUN}`;
const NOTE = `Det här pekar ut en granne. ${RUN}`;

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

/** Writes to Alla as somebody, and answers with what was written. */
async function writeToAlla(
  context: APIRequestContext,
  alla: string,
  body: string,
): Promise<string> {
  const written = await context.post(`${stack.baseUrl}/api/feed/posts`, {
    data: { audienceId: alla, body },
  });
  expect(written.status()).toBe(201);
  return ((await written.json()) as { id: string }).id;
}

test.describe("moderating Alla", () => {
  test("a neighbour reports a post in Alla, and the board strikes it from the feed", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    test.setTimeout(150_000);
    await ensureInstance(request);
    writer = await ensureResident(request, {
      firstName: "Tove",
      local: "moderering-tove",
      clientAddress: clientAddressFor(clientAddress, "writer"),
      password: PASSWORD,
    });
    neighbour = await ensureResident(request, {
      firstName: "Axel",
      local: "moderering-axel",
      clientAddress: clientAddressFor(clientAddress, "neighbour"),
      password: PASSWORD,
    });
    board = await ensureBoardMember(request, {
      firstName: "Majken",
      local: "moderering-majken",
      clientAddress: clientAddressFor(clientAddress, "board"),
      password: PASSWORD,
    });
    const author = made(writer, "the writer");

    // --- the writer posts to Alla ----------------------------------------
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, made(neighbour, "the neighbour"));
    const alla = await audienceId(page, { kind: "ALL" });
    const context = await signedInAs(clientAddress, author, "writer");
    try {
      await writeToAlla(context, alla, POST);
    } finally {
      await context.dispose();
    }

    // --- the neighbour reports it -----------------------------------------
    await openFeed(page);
    const card = postCard(page, POST);
    await card
      .getByRole("button", {
        name: `Fler val för inlägget från ${author.name}`,
      })
      .click();
    await card.getByRole("button", { name: "Anmäl till styrelsen" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Anmäl inlägget från ${author.name} till styrelsen`,
    });
    await expect(
      dialog.getByText(/Styrelsen läser redan det som skrivs till Alla/),
    ).toBeVisible();
    await dialog.getByLabel("Vad vill du säga till styrelsen?").fill(NOTE);
    await dialog.getByRole("button", { name: "Skicka anmälan" }).click();
    await expect(
      card.getByText("Inlägget är anmält till styrelsen."),
    ).toBeVisible();

    // --- the board finds it in its queue, under Alla ---------------------
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    await page.goto(appPath("/board/reports"));
    const queued = page.getByRole("listitem").filter({ hasText: NOTE });
    await expect(queued).toContainText("Alla");
    await expect(
      queued.getByRole("link", { name: "Öppna inlägget i flödet" }),
    ).toBeVisible();

    // --- and strikes it from the card in the feed, under its sign --------
    await openFeed(page);
    const onTheFeed = postCard(page, POST);
    await onTheFeed
      .getByRole("group", { name: "Styrelsen" })
      .getByRole("button", { name: "Stryk över" })
      .click();
    const confirm = page.getByRole("dialog", {
      name: `Stryk över inlägget från ${author.name}?`,
    });
    await confirm.getByRole("button", { name: "Stryk över" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(onTheFeed.getByText("Struket", { exact: true })).toBeVisible();

    // The report was answered by the strike, so the queue no longer asks.
    await page.goto(appPath("/board/reports"));
    await expect(
      page.getByRole("heading", { name: "Anmälda inlägg", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: NOTE }),
    ).toHaveCount(0);

    // --- the neighbour reads that it was struck, and not what it said ----
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, made(neighbour, "the neighbour"));
    await openFeed(page);
    await expect(
      page.getByText("Styrelsen har strukit över inlägget och dolt texten."),
    ).toBeVisible();
    await expect(page.getByText(POST)).toHaveCount(0);
  });

  test("the board strikes a comment in Alla from the thread", async ({
    page,
    clientAddress,
  }) => {
    const author = made(writer, "the writer");
    const answerer = made(neighbour, "the neighbour");

    // --- a question in Alla, and an answer under it -----------------------
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    const alla = await audienceId(page, { kind: "ALL" });
    const asWriter = await signedInAs(clientAddress, author, "writer");
    const asNeighbour = await signedInAs(clientAddress, answerer, "neighbour");
    try {
      const postId = await writeToAlla(asWriter, alla, QUESTION);
      const answered = await asNeighbour.post(
        `${stack.baseUrl}/api/feed/posts/${postId}/comments`,
        { data: { body: ANSWER } },
      );
      expect(answered.status()).toBe(201);
    } finally {
      await asWriter.dispose();
      await asNeighbour.dispose();
    }

    // --- the board strikes the answer through ----------------------------
    await openFeed(page);
    const card = postCard(page, QUESTION);
    await card.getByRole("button", { name: "1 kommentar" }).click();
    const answer = card.getByRole("listitem").filter({ hasText: ANSWER });
    await answer
      .getByRole("group", { name: "Styrelsen" })
      .getByRole("button", { name: "Stryk över" })
      .click();
    const confirm = page.getByRole("dialog", {
      name: `Stryk över kommentaren från ${answerer.name}?`,
    });
    await confirm.getByRole("button", { name: "Stryk över" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(answer.getByText("Struket", { exact: true })).toBeVisible();

    // --- the writer reads that the board struck it -----------------------
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, author);
    await openFeed(page);
    const theirs = postCard(page, QUESTION);
    await theirs.getByRole("button", { name: "1 kommentar" }).click();
    await expect(
      theirs.getByText(
        "Styrelsen har strukit över kommentaren och dolt texten.",
      ),
    ).toBeVisible();
    await expect(theirs.getByText(ANSWER)).toHaveCount(0);
  });
});
