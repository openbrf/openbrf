import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import "../i18n";
import type { AdminPage, PageBlock } from "../api/site";
import { PlaceOnPage } from "./PlaceOnPage";

/**
 * Putting a feature's own block on a page.
 *
 * Three blocks render and validate and no screen offered one, so the only way
 * to put a news teaser or either form on a page was a direct call to the API.
 * The page editor deliberately does not offer them - placing one belongs to the
 * screen that owns what it shows - and this is the control those screens use.
 *
 * What it must get right is what a board would otherwise have to undo by hand:
 * the block goes on the page they chose, the page keeps everything already on
 * it, and a page that carries one is not offered a second.
 */

const fetchPages = vi.fn();
const savePage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  savePage: (id: string, edit: unknown) => savePage(id, edit),
}));

function page(overrides: Partial<AdminPage>): AdminPage {
  return {
    id: "page-1",
    slug: "start",
    title: "Startsidan",
    content: { version: 1, blocks: [{ type: "paragraph", runs: [] }] },
    visibility: "PUBLIC",
    published: true,
    publishedAt: "2026-08-01T09:00:00.000Z",
    sortOrder: 1,
    revision: 4,
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fetchPages.mockReset().mockResolvedValue({ ok: true, value: [page({})] });
  savePage.mockReset();
});

function renderControl(): void {
  render(
    <PlaceOnPage
      block={{ type: "newsTeaser", count: 3 }}
      titleKey="siteAdmin.place.newsTeaser.title"
      descriptionKey="siteAdmin.place.newsTeaser.description"
      alreadyThereKey="siteAdmin.place.newsTeaser.alreadyThere"
    />,
  );
}

it("appends the block and keeps what the page already carried", async () => {
  savePage.mockImplementation(
    async (id: string, edit: { content: { blocks: PageBlock[] } }) => ({
      ok: true,
      value: page({ id, content: { version: 1, blocks: edit.content.blocks } }),
    }),
  );

  renderControl();
  await userEvent.click(
    await screen.findByRole("button", { name: "Placera på sidan" }),
  );

  await waitFor(() => {
    expect(savePage).toHaveBeenCalled();
  });
  const [id, edit] = savePage.mock.calls[0] as [
    string,
    { slug: string; title: string; content: { blocks: unknown[] } },
  ];
  expect(id).toBe("page-1");
  // The paragraph that was there, and the block after it: a placement is not a
  // page rewritten around one block.
  expect(edit.content.blocks).toEqual([
    { type: "paragraph", runs: [] },
    { type: "newsTeaser", count: 3 },
  ]);
  // The slug and the title travel unchanged, because the save replaces the page.
  expect(edit.slug).toBe("start");
  expect(edit.title).toBe("Startsidan");
});

it("does not offer a second one to a page that already carries it", async () => {
  /*
   * The page stays in the list and says why it is not on offer. Leaving it out
   * would be a page missing from a picker for a reason nothing on this screen
   * states, which is a question a board cannot answer from here.
   */
  fetchPages.mockResolvedValue({
    ok: true,
    value: [
      page({
        content: { version: 1, blocks: [{ type: "newsTeaser", count: 5 }] },
      }),
      page({ id: "page-2", slug: "styrelsen", title: "Styrelsen" }),
    ],
  });

  renderControl();

  expect(
    await screen.findByText("Sidan har redan ett nyhetsblock."),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Placera på sidan" })
      .hasAttribute("disabled"),
  ).toBe(true);

  // The other page is on offer, which is what makes the first one's sentence a
  // statement about that page rather than about the control.
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Sida" }),
    "page-2",
  );
  expect(
    screen
      .getByRole("button", { name: "Placera på sidan" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("says so once when every page already carries it", async () => {
  // Rather than leaving a board to discover it by choosing each page in turn.
  fetchPages.mockResolvedValue({
    ok: true,
    value: [
      page({
        content: { version: 1, blocks: [{ type: "newsTeaser", count: 5 }] },
      }),
      page({
        id: "page-2",
        slug: "styrelsen",
        title: "Styrelsen",
        content: { version: 1, blocks: [{ type: "newsTeaser", count: 3 }] },
      }),
    ],
  });

  renderControl();

  expect(await screen.findByText("Alla sidor har redan blocket.")).toBeTruthy();
});

it("says where the picture confirmation is given rather than asking for it here", async () => {
  /*
   * A page carrying a picture of identifiable people is saved only with the
   * confirmation that everyone on it has consented, and that question belongs
   * beside the pictures. Asking it again here would be a second place to answer
   * for a publication this screen cannot see.
   */
  savePage.mockResolvedValue({
    ok: false,
    failure: { status: 409, reason: "photo-consent-required" },
  });

  renderControl();
  await userEvent.click(
    await screen.findByRole("button", { name: "Placera på sidan" }),
  );

  expect(
    await screen.findByText(/publiceringssamtycket bekräftas i sidredigeraren/),
  ).toBeTruthy();
});

it("sends the revision it read, so a placement cannot write over an edit", async () => {
  /*
   * A save carries the whole page. Without the precondition a placement would
   * put the blocks this control fetched over whatever the page editor had saved
   * in between - the board's own prose, silently, from a screen that is not the
   * page editor. The server writes only if the page is still the one that was
   * read.
   */
  savePage.mockResolvedValue({ ok: true, value: page({}) });

  renderControl();
  await userEvent.click(
    await screen.findByRole("button", { name: "Placera på sidan" }),
  );

  await waitFor(() => {
    expect(savePage).toHaveBeenCalled();
  });
  const [, edit] = savePage.mock.calls[0] as [
    string,
    { expectedRevision?: number },
  ];
  expect(edit.expectedRevision).toBe(4);
});

it("says the page moved rather than reporting a placement that did not happen", async () => {
  savePage.mockResolvedValue({
    ok: false,
    failure: { status: 409, reason: "page-changed" },
  });

  renderControl();
  await userEvent.click(
    await screen.findByRole("button", { name: "Placera på sidan" }),
  );

  expect(
    await screen.findByText(/Sidan ändrades medan den här vyn hade den öppen/),
  ).toBeTruthy();
});

it("reports a failed read as one, and reads again when asked", async () => {
  /*
   * Answering a failed read with an empty list would tell a board with a dozen
   * pages that they have none and should create one - the wrong sentence, and
   * the one they would act on.
   */
  fetchPages.mockResolvedValueOnce({
    ok: false,
    failure: { status: 500, reason: "unexpected" },
  });

  renderControl();

  expect(
    await screen.findByText("Sidorna kunde inte läsas just nu."),
  ).toBeTruthy();
  expect(
    screen.queryByText(/Det finns ingen sida att placera blocket på/),
  ).toBeNull();

  fetchPages.mockResolvedValue({ ok: true, value: [page({})] });
  await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

  expect(
    await screen.findByRole("button", { name: "Placera på sidan" }),
  ).toBeTruthy();
});
