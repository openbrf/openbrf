import {
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

/**
 * The board's tools in the feed: writing as Styrelsen, which is writing a news
 * item.
 *
 * **A board seat holder posts as Styrelsen, named or not.** Through the
 * composer, with a title, marked important and pinned; the post is in the feed
 * on top with the board's mark on it, and its news item is published with the
 * news mailing claimed. Read back from the news screen's own endpoint as well
 * as from the feed, because that a board post is a news item is the claim.
 *
 * **A neighbour reads it, and is offered none of it.** The composer has no
 * "Från" for somebody who holds no seat, and the server refuses the board's
 * options from them whatever a browser sends - which is asserted against the
 * endpoints, because what keeps a resident from writing in the association's
 * name is the register the service asks rather than anything the screen draws.
 *
 * **A scheduled post waits where only the board sees it**, and comments can be
 * turned off.
 *
 * **The board answers under its post as Styrelsen**, and can take the pin off.
 *
 * That a scheduled post is published by its job at its instant, mailing and
 * all, and delivered by the next poll even when the job runs late, is
 * `apps/api/src/feed/board-post.int-spec.ts`: a browser would have to wait out
 * the instant to see it.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "styrelsebord-kastanj-2026";

/** What this run's board writes, unique so a kept stack reads its own. */
const RUN = String(Date.now());
const TITLE = `Vattnet stängs av ${RUN}`;
const TEXT = "Tisdag 9-12 i hela huset. Fyll en kanna kvällen före.";
const SCHEDULED_TITLE = `Städdag i maj ${RUN}`;

// The server accepts a time ahead of now and within a year, so the moment the
// spec schedules for is counted from today rather than written as a date.
function aMonthAhead(): string {
  const at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T10:00`;
}

let board: FeedPerson | null = null;
let neighbour: FeedPerson | null = null;

function made<T>(what: T | null, name: string): T {
  if (what === null) {
    throw new Error(`${name} was not made: an earlier test did not finish`);
  }
  return what;
}

test.describe("the board's tools", () => {
  test("a board seat holder posts as Styrelsen via their name, important and pinned", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    board = await ensureBoardMember(request, {
      firstName: "Ingrid",
      local: "tavla-ingrid",
      clientAddress: clientAddressFor(clientAddress, "board"),
      password: PASSWORD,
    });
    neighbour = await ensureResident(request, {
      firstName: "Olof",
      local: "tavla-olof",
      clientAddress: clientAddressFor(clientAddress, "neighbour"),
      password: PASSWORD,
    });

    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, board);
    await openFeed(page);

    await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
    const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
    await dialog
      .getByLabel("Från")
      .selectOption({ label: `Styrelsen via ${board.name}` });
    // Written as Styrelsen it goes to Alla, and the dialog says so.
    await expect(
      dialog.getByText("Som Styrelsen skriver du till Alla."),
    ).toBeVisible();
    await dialog.getByLabel(/^Rubrik/).fill(TITLE);
    await dialog.getByLabel("Text").fill(TEXT);
    await dialog.getByLabel(/^Viktigt meddelande/).check();
    await dialog.getByLabel("Fäst överst").check();

    const written = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/feed/board-posts",
    );
    await dialog.getByRole("button", { name: "Skapa" }).click();
    expect((await written).status()).toBe(201);
    await expect(dialog).toHaveCount(0);

    const card = postCard(page, TITLE);
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(card.getByText(TEXT)).toBeVisible();
    await expect(card.getByText(`Styrelsen via ${board.name}`)).toBeVisible();
    await expect(card.getByText("Viktigt", { exact: true })).toBeVisible();
    await expect(card.getByText("Fäst överst", { exact: true })).toBeVisible();

    // A news item, published to the members, with the mailing claimed.
    const news = await page.request.get(`${stack.baseUrl}/api/news`);
    expect(news.ok()).toBe(true);
    const item = (
      (await news.json()) as {
        title: string;
        published: boolean;
        visibility: string;
        emailQueuedAt: string | null;
      }[]
    ).find((each) => each.title === TITLE);
    expect(item).toMatchObject({ published: true, visibility: "MEMBER" });
    expect(item?.emailQueuedAt).not.toBeNull();
  });

  test("a neighbour reads it on top, and is offered none of the board's options", async ({
    page,
    clientAddress,
  }) => {
    const reader = made(neighbour, "the neighbour");
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, reader);
    const audiences = await openFeed(page);

    const card = postCard(page, TITLE);
    await expect(card).toBeVisible();
    await expect(card.getByText("Fäst överst", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
    const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
    await expect(dialog.getByLabel("Från")).toHaveCount(0);
    await expect(dialog.getByText("Viktigt meddelande")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Avbryt" }).click();

    // And the server refuses what the screen did not offer.
    const alla = audiences.find((each) => each.kind === "ALL")?.id ?? "";
    const asBoard = await page.request.post(
      `${stack.baseUrl}/api/feed/board-posts`,
      {
        data: {
          audienceId: alla,
          title: "Från en granne",
          body: "Jag skriver som styrelsen.",
          namesAuthor: false,
        },
      },
    );
    expect(asBoard.status()).toBe(422);
    expect(((await asBoard.json()) as { reason: string }).reason).toBe(
      "not-board",
    );
    const flagged = await page.request.post(`${stack.baseUrl}/api/feed/posts`, {
      data: { audienceId: alla, body: "Viktigt!", important: true },
    });
    expect(flagged.status()).toBe(400);
  });

  test("a scheduled post with comments off waits where only the board sees it", async ({
    page,
    clientAddress,
  }) => {
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, made(board, "the board member"));
    await openFeed(page);

    await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
    const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
    await dialog.getByLabel("Från").selectOption({ label: "Styrelsen" });
    await dialog.getByLabel(/^Rubrik/).fill(SCHEDULED_TITLE);
    await dialog.getByLabel("Text").fill("Lördag klockan tio.");
    await dialog.getByLabel("Tillåt kommentarer").uncheck();
    await dialog.getByLabel(/^Schemalägg publicering/).fill(aMonthAhead());
    await dialog.getByRole("button", { name: "Schemalägg" }).click();
    await expect(dialog).toHaveCount(0);

    const waiting = page.getByRole("region", { name: /Schemalagda inlägg/ });
    await expect(waiting.getByText(SCHEDULED_TITLE)).toBeVisible();
    await expect(postCard(page, SCHEDULED_TITLE)).toHaveCount(0);

    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, made(neighbour, "the neighbour"));
    await openFeed(page);
    await expect(postCard(page, TITLE)).toBeVisible();
    await expect(page.getByText(SCHEDULED_TITLE)).toHaveCount(0);
    await expect(page.getByText("Schemalagda inlägg")).toHaveCount(0);
  });

  test("the board answers as Styrelsen, and takes the pin off", async ({
    page,
    clientAddress,
  }) => {
    const writer = made(board, "the board member");
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, writer);
    await openFeed(page);

    const card = postCard(page, TITLE);
    await card.getByRole("button", { name: "0 kommentarer" }).click();
    await card
      .getByRole("combobox", { name: "Skriv som" })
      .selectOption({ label: `Styrelsen via ${writer.name}` });
    await card
      .getByRole("textbox", { name: "Din kommentar" })
      .fill("Det gäller hela huset.");
    await card.getByRole("button", { name: "Skicka" }).click();
    const answer = card.getByRole("listitem").filter({
      hasText: "Det gäller hela huset.",
    });
    await expect(answer).toBeVisible();
    await expect(
      answer.getByText(`Styrelsen via ${writer.name}`),
    ).toBeVisible();

    await card.getByRole("button", { name: /^Fler val för inlägget/ }).click();
    await card.getByRole("button", { name: "Lossa från toppen" }).click();
    await expect(card.getByText("Fäst överst", { exact: true })).toHaveCount(0);
  });
});
