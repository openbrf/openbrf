import type { Page } from "@playwright/test";

import {
  audienceButton,
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
import { ensureInstance } from "../src/provision";
import { pngPicture } from "../src/site";
import { appPath } from "../src/stack";

/**
 * A group in the feed, as far as a deployed instance can show it.
 *
 * What is here is the half that only exists once the image is serving one origin
 * and several people with real residencies are looking at it.
 *
 * **A resident makes a group the board did not appoint.** No capability beyond
 * the one that opens the endpoints, no approval, no list for the board to read:
 * somebody types a name and the group exists, and a neighbour they pick reads it
 * on the next screen.
 *
 * **A group is invisible to somebody who is not in it.** On no list, in no
 * search, and refused by identifier exactly as something that does not exist -
 * the group, a post in it, the post's own address and the image on it. Asserted
 * against the endpoints as equalities rather than statuses: a body that differed
 * would be as good a signal as a status, and either is a way to find out what
 * groups the house has made.
 *
 * **The board reaches the group through one report and nothing else.** A member
 * reports a post, the board reads that post in its queue, strikes it through,
 * and the group loses the text while its author keeps it.
 *
 * Deliberately absent: the poll. `specs/40-feed-board.spec.ts` holds the
 * two-browser delivery test, and a second copy of it here would assert the same
 * mechanism against a different audience.
 */

test.describe.configure({ mode: "serial" });

/** The password the people this spec invents are activated with. */
const PASSWORD = "krattan-sommaraeng-2026";

/** One group, made through the screen, with its name unique to this run. */
const GROUP_NAME = `Trädgårdsgruppen ${String(Date.now())}`;

/*
 * The people the first test makes, held for the tests after it. The file is
 * serial and runs in one worker, so this is the order the tests are written in
 * rather than an assumption about them.
 */
let maker: FeedPerson | null = null;
let neighbour: FeedPerson | null = null;

function made(who: FeedPerson | null, what: string): FeedPerson {
  if (who === null) {
    throw new Error(`${what} was not created: the first test did not finish`);
  }
  return who;
}

/** Opens the feed with the group chosen, and waits until it is. */
async function openGroup(page: Page): Promise<void> {
  await openFeed(page);
  await audienceButton(page, GROUP_NAME).click();
  await expect(
    page.getByRole("heading", { name: GROUP_NAME, exact: true }),
  ).toBeVisible();
}

test.describe("a group in the feed", () => {
  test("is made by a resident, who then puts a neighbour in it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    maker = await ensureResident(request, {
      firstName: "Nils",
      local: "flode-grupp-nils",
      clientAddress: clientAddressFor(clientAddress, "maker"),
      password: PASSWORD,
    });
    neighbour = await ensureResident(request, {
      firstName: "Astrid",
      local: "flode-grupp-astrid",
      clientAddress: clientAddressFor(clientAddress, "neighbour"),
      password: PASSWORD,
    });

    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(page, maker);
    await openFeed(page);

    /*
     * Nobody appoints this group. There is no request to the board, no approval
     * and no capability beyond the one that opened the screen: a name, and the
     * group exists - and opens, because whoever made it made it to write in it.
     */
    await page.getByLabel("Starta en grupp").fill(GROUP_NAME);
    await page.getByRole("button", { name: "Skapa gruppen" }).click();
    await expect(
      page.getByRole("heading", { name: GROUP_NAME, exact: true }),
    ).toBeVisible();

    // The picker is the neighbours, searched by name. By the person's own
    // identifier rather than by the label the option carries, which spells the
    // apartment after the name.
    await page.getByLabel("Sök bland grannarna").fill(neighbour.name);
    await page
      .getByRole("combobox", { name: "Lägg till någon" })
      .selectOption(neighbour.personId);
    await page.getByRole("button", { name: "Lägg till", exact: true }).click();

    // The group says who is in it, and who started it.
    await expect(page.getByText(neighbour.name, { exact: true })).toBeVisible();
    await expect(page.getByText("Startade gruppen")).toBeVisible();

    // And the neighbour finds the group on their own screen.
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, neighbour);
    await openGroup(page);
  });

  test("is invisible to somebody who is not in it, by list and by every identifier", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    const outsider = await ensureResident(request, {
      firstName: "Sven",
      local: "flode-grupp-sven",
      clientAddress: clientAddressFor(clientAddress, "outsider"),
      password: PASSWORD,
    });

    // --- a post with an image in the group ------------------------------
    const said = `Vi vattnar i kväll. ${String(Date.now())}`;
    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(page, made(maker, "the maker"));
    const groupId = await audienceId(page, { group: GROUP_NAME });
    await openGroup(page);
    await writePostThroughTheScreen(page, said, [
      { name: "rabatt.png", buffer: pngPicture(32, 24) },
    ]);
    const card = postCard(page, said);
    const imageUrl = await card.getByRole("img").getAttribute("src");
    if (imageUrl === null) {
      throw new Error("the post's image carries no address");
    }
    // The address the date links to, which is the post's own.
    const postHref = await card
      .locator('a[href*="/feed/"]')
      .getAttribute("href");
    const postId = postHref?.split("/").at(-1);
    if (postId === undefined || postId === "") {
      throw new Error("the post carries no address of its own");
    }
    // Served to somebody in the group.
    expect(
      (await page.request.get(`${stack.baseUrl}${imageUrl}`)).status(),
    ).toBe(200);

    // --- the outsider ------------------------------------------------------
    await browseAs(page, clientAddress, "outsider");
    await signInThroughTheScreen(page, outsider);

    // Not on the list the screen is sent, and not on the screen.
    const audiences = await openFeed(page);
    expect(audiences.map((audience) => audience.id)).not.toContain(groupId);
    await expect(audienceButton(page, "Alla")).toBeVisible();
    await expect(audienceButton(page, GROUP_NAME)).toHaveCount(0);

    // Not in a search of the whole feed either.
    const searched = await page.request.get(
      `${stack.baseUrl}/api/feed/posts?q=${encodeURIComponent(said)}`,
    );
    expect(searched.ok()).toBe(true);
    expect(JSON.stringify(await searched.json())).not.toContain(said);

    /*
     * The group, the post and the image by identifier: each one answered
     * exactly as an identifier that names nothing at all.
     */
    for (const [asked, nothing] of [
      [
        `/api/feed/posts?audience=${encodeURIComponent(groupId)}`,
        "/api/feed/posts?audience=audience-nothing-at-all",
      ],
      [
        `/api/feed/posts/${encodeURIComponent(postId)}`,
        "/api/feed/posts/post-nothing-at-all",
      ],
      [imageUrl, "/api/media/file-nothing-at-all"],
    ] as const) {
      const refused = await page.request.get(`${stack.baseUrl}${asked}`, {
        failOnStatusCode: false,
      });
      const absent = await page.request.get(`${stack.baseUrl}${nothing}`, {
        failOnStatusCode: false,
      });
      expect(refused.status(), asked).toBe(404);
      expect(absent.status(), asked).toBe(refused.status());
      expect(await absent.text(), asked).toBe(await refused.text());
    }

    // And the post's own address, opened on screen, says what it says of a
    // post that never existed.
    await page.goto(appPath(`/feed/${postId}`));
    await expect(
      page.getByText("Det inlägget finns inte, eller är inte ditt att läsa."),
    ).toBeVisible();
    await expect(page.getByText(said)).toHaveCount(0);
  });

  test("gives the board one post when somebody in the group reports it", async ({
    page,
    api: request,
    clientAddress,
  }) => {
    await ensureInstance(request);
    const board = await ensureBoardMember(request, {
      firstName: "Bo",
      local: "flode-grupp-styrelse",
      clientAddress: clientAddressFor(clientAddress, "board"),
      password: PASSWORD,
    });
    const author = made(neighbour, "the neighbour");

    // --- the neighbour writes something --------------------------------
    const said = `Det här borde ingen skriva. ${String(Date.now())}`;
    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, author);
    await openGroup(page);
    await writePostThroughTheScreen(page, said);

    // --- the maker reports it -------------------------------------------
    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(page, made(maker, "the maker"));
    const groupId = await audienceId(page, { group: GROUP_NAME });
    await openGroup(page);
    const card = postCard(page, said);
    await card
      .getByRole("button", {
        name: `Fler val för inlägget från ${author.name}`,
      })
      .click();
    await card.getByRole("button", { name: "Anmäl till styrelsen" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Anmäl inlägget från ${author.name} till styrelsen`,
    });
    await dialog
      .getByLabel("Vad vill du säga till styrelsen?")
      .fill("Det här handlar om min lägenhet.");
    await dialog.getByRole("button", { name: "Skicka anmälan" }).click();
    await expect(
      card.getByText("Inlägget är anmält till styrelsen."),
    ).toBeVisible();

    // --- the board reads that post and strikes it through ----------------
    await browseAs(page, clientAddress, "board");
    await signInThroughTheScreen(page, board);

    /*
     * The queue is the board's whole way in. The group itself is not on this
     * screen and there is no control that would open it: it is not among the
     * audiences the screen is sent, and what is here is the post that was
     * carried out, with the group's name beside it.
     */
    const audiences = await openFeed(page);
    expect(audiences.map((audience) => audience.id)).not.toContain(groupId);
    await expect(
      page.getByRole("heading", { name: "Anmälda inlägg" }),
    ).toBeVisible();
    /*
     * The row carrying this post rather than the first row in the queue: the
     * queue is the whole instance's, and a stack that has run this spec before
     * can hold a report this run did not make.
     */
    const reported = page.getByRole("listitem").filter({ hasText: said });
    await expect(reported).toContainText(GROUP_NAME);
    await reported.getByRole("button", { name: "Stryk över inlägget" }).click();
    // Answered, so it leaves the queue.
    await expect(page.getByText(said)).toHaveCount(0);

    // --- the group loses the text, and its author keeps it ---------------
    await browseAs(page, clientAddress, "maker");
    await signInThroughTheScreen(page, made(maker, "the maker"));
    await openGroup(page);
    await expect(
      page.getByText("Styrelsen har strukit över inlägget och dolt texten."),
    ).toBeVisible();
    await expect(page.getByText(said)).toHaveCount(0);

    await browseAs(page, clientAddress, "neighbour");
    await signInThroughTheScreen(page, author);
    await openGroup(page);
    // A strike is a strike-through and never a disappearance.
    const own = postCard(page, said);
    await expect(own).toBeVisible();
    await expect(own.getByText("Struket", { exact: true })).toBeVisible();
  });
});
