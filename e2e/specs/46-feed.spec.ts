import type { Page } from "@playwright/test";

import {
  browseAs,
  ensureResident,
  type FeedPerson,
  openFeed,
  pngBytes,
  postCard,
  signInThroughTheScreen,
  writePostThroughTheScreen,
} from "../src/feed";
import { clientAddressFor, expect, stack, test } from "../src/fixtures";
import { ensureInstance } from "../src/provision";
import { appPath } from "../src/stack";

/**
 * The feed as the house uses it: residents writing to Alla, and their
 * neighbours reading, liking and answering.
 *
 * **A resident posts to Alla with text and an image.** Through the composer,
 * as anybody who lives here would: the image goes up as it is picked, and the
 * post is written once with it.
 *
 * **A neighbour likes it, answers it, and is counted as having read it.** "Läst
 * av" is a count, never names - and it moves because the neighbour had the post
 * on screen, which only a browser that scrolls a real page can show.
 *
 * **Every post has an address of its own**, which is what a mailing or a report
 * links to, and it opens the post with its comments.
 *
 * **Search and filter answer inside the reader's own audiences.** Asserted on
 * screen here; that they never reach outside them is `43-feed-groups`, which
 * has a group to reach for.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "tvattstuga-syren-2026";

/** What the writer posts, unique to this run so a kept stack reads its own. */
const SAID = `Cyklarna i källaren säljs på lördag. ${String(Date.now())}`;

let writer: FeedPerson | null = null;
let reader: FeedPerson | null = null;
let postId: string | null = null;

function made<T>(what: T | null, name: string): T {
  if (what === null) {
    throw new Error(`${name} was not made: an earlier test did not finish`);
  }
  return what;
}

/** The post's own identifier, read off the address its date links to. */
async function postIdOn(page: Page, text: string): Promise<string> {
  const href = await postCard(page, text)
    .locator('a[href*="/feed/"]')
    .getAttribute("href");
  const id = href?.split("/").at(-1);
  if (id === undefined || id === "") {
    throw new Error("the post carries no address of its own");
  }
  return id;
}

test.describe("the house's feed", () => {
  test("a resident posts to Alla with text and an image", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    writer = await ensureResident(request, {
      firstName: "Greta",
      local: "flode-greta",
      clientAddress: clientAddressFor(clientAddress, "writer"),
      password: PASSWORD,
    });
    reader = await ensureResident(request, {
      firstName: "Olle",
      local: "flode-olle",
      clientAddress: clientAddressFor(clientAddress, "reader"),
      password: PASSWORD,
    });

    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, writer);
    await openFeed(page);

    // From the whole feed, a post goes to Alla, and the composer says so.
    await page.getByRole("button", { name: "Skriv ett inlägg..." }).click();
    const dialog = page.getByRole("dialog", { name: "Skriv ett inlägg" });
    await expect(dialog.getByText(writer.name)).toBeVisible();
    await expect(dialog.getByText("Alla", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Avbryt" }).click();

    await writePostThroughTheScreen(page, SAID, [
      { name: "cykel.png", buffer: pngBytes(40, 30) },
    ]);

    const card = postCard(page, SAID);
    await expect(card.getByText("Till Alla")).toBeVisible();
    await expect(card.getByText("Du", { exact: true })).toBeVisible();
    const image = card.getByRole("img");
    await expect(image).toHaveCount(1);
    const imageUrl = await image.getAttribute("src");
    expect(imageUrl).toMatch(/^\/api\/media\//);
    expect(
      (await page.request.get(`${stack.baseUrl}${imageUrl ?? ""}`)).status(),
    ).toBe(200);

    postId = await postIdOn(page, SAID);
  });

  test("a neighbour sees it, likes it, answers it and is counted as having read it", async ({
    page,
    clientAddress,
  }) => {
    const id = made(postId, "the post");
    await browseAs(page, clientAddress, "reader");
    await signInThroughTheScreen(page, made(reader, "the reader"));

    // Armed before the feed opens: the read is recorded once the post has been
    // on screen, which is the moment the feed draws it near the top.
    const recorded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/feed/posts/${id}/read`,
    );
    await openFeed(page);
    const card = postCard(page, SAID);
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    expect((await recorded).ok()).toBe(true);

    // A like, answered with the count.
    await card.getByRole("button", { name: /^Gilla/ }).click();
    await expect(card.getByRole("button", { name: /^Gillat/ })).toContainText(
      "1",
    );

    // An answer, written in the thread the count opens.
    await card.getByRole("button", { name: "0 kommentarer" }).click();
    await card
      .getByRole("textbox", { name: "Din kommentar" })
      .fill("Jag tar en!");
    await card.getByRole("button", { name: "Skicka" }).click();
    await expect(card.getByText("Jag tar en!")).toBeVisible();
    await expect(
      card.getByRole("button", { name: "1 kommentar" }),
    ).toBeVisible();
  });

  test("the writer sees what the house did with it, and its own address opens it", async ({
    page,
    clientAddress,
  }) => {
    const id = made(postId, "the post");
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, made(writer, "the writer"));
    await openFeed(page);

    const card = postCard(page, SAID);
    // A count, never names.
    await expect(card.getByText("Läst av 1")).toBeVisible();
    await expect(card.getByRole("button", { name: /^Gilla/ })).toContainText(
      "1",
    );
    await expect(
      card.getByRole("button", { name: "1 kommentar" }),
    ).toBeVisible();
    expect(await card.textContent()).not.toContain(
      made(reader, "the reader").name,
    );

    // The address the date links to, which a mailing or a report can carry.
    await card.locator('a[href*="/feed/"]').click();
    await expect(page).toHaveURL(new RegExp(`/app/feed/${id}$`));
    await expect(page.getByText(SAID)).toBeVisible();
    // Opened with its comments, which is what somebody following a link to a
    // post came for.
    await expect(page.getByText("Jag tar en!")).toBeVisible();

    // And it opens the same from a fresh load of that address.
    await page.goto(appPath(`/feed/${id}`));
    await expect(page.getByText(SAID)).toBeVisible();
  });

  test("search and filter narrow the feed", async ({ page, clientAddress }) => {
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, made(writer, "the writer"));
    await openFeed(page);
    await expect(postCard(page, SAID)).toBeVisible();

    const search = page.getByLabel("Sök i inläggen");
    await search.fill("Cyklarna i källaren");
    await expect(postCard(page, SAID)).toBeVisible();
    await search.fill(`ingenting-skrivet-${String(Date.now())}`);
    await expect(
      page.getByText("Inga inlägg här matchar sökningen eller filtret."),
    ).toBeVisible();
    await search.fill("");
    await expect(postCard(page, SAID)).toBeVisible();

    // The board's posts only: a resident's post is not among them.
    await page.getByRole("button", { name: "Filtrera inlägg" }).click();
    const dialog = page.getByRole("dialog", { name: "Filtrera inlägg" });
    await dialog.getByRole("radio", { name: "Styrelsen" }).check();
    await dialog.getByRole("button", { name: "Visa inläggen" }).click();
    await expect(
      page.getByRole("button", { name: "Filtrera inlägg (1 val)" }),
    ).toBeVisible();
    await expect(postCard(page, SAID)).toHaveCount(0);

    // The neighbours' posts: it is back.
    await page.getByRole("button", { name: "Filtrera inlägg (1 val)" }).click();
    await dialog.getByRole("radio", { name: "Grannar" }).check();
    await dialog.getByRole("button", { name: "Visa inläggen" }).click();
    await expect(postCard(page, SAID)).toBeVisible();
  });

  test("the chat's old address goes to the feed", async ({
    page,
    clientAddress,
  }) => {
    await browseAs(page, clientAddress, "writer");
    await signInThroughTheScreen(page, made(writer, "the writer"));

    await page.goto(appPath("/chat"));

    await expect(page).toHaveURL(/\/app\/feed$/);
    await expect(
      page.getByRole("heading", { name: "Flöde", exact: true }),
    ).toBeVisible();
  });
});
