import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { AdminPage, PageBlock } from "../api/site";
import { SiteAdminScreen } from "./SiteAdminScreen";

/**
 * What the board is shown and what pressing a button actually sends.
 *
 * The guardrails live on the server and are tested there. What is tested here
 * is the half the interface owns: that the capability decides whether the
 * screen has anything to offer, that a page is created as a draft, that the
 * warning about special-category free text stands on the editor whether or not
 * anything is wrong, and that the browser warns about a personal identity
 * number before the server has to refuse one.
 */

/**
 * The router's Link needs a router context these tests have no use for, so it
 * is replaced with an anchor. What is under test here is the screen, not
 * routing.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

const fetchPages = vi.fn();
const createPage = vi.fn();
const setPageStatus = vi.fn();
const setFrontPage = vi.fn();
const savePage = vi.fn();
const deletePage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  createPage: (page: unknown) => createPage(page),
  setPageStatus: (id: string, input: unknown) => setPageStatus(id, input),
  setFrontPage: (id: string, input: unknown) => setFrontPage(id, input),
  savePage: (id: string, edit: unknown) => savePage(id, edit),
  deletePage: (id: string, input: unknown) => deletePage(id, input),
}));

/**
 * The text editor is replaced by a plain field.
 *
 * The mapping between the editor's document and the stored runs has its own
 * tests; what this file is about is the screen around it, and loading a whole
 * editing engine to assert a warning sentence would test the engine instead.
 *
 * A "|" stands for a return: the field reports one paragraph per piece, with
 * the caret at the start of the last, as the editor does after a split. Past
 * `maxParagraphs` the pieces are joined as the editor joins them, with the
 * editor's own helper. Past the length a paragraph may have, the text is cut
 * as the editor cuts it.
 */
vi.mock("./RichText", async () => {
  const { joinParagraphsBeyond } =
    await vi.importActual<typeof import("./prosemirror-runs")>(
      "./prosemirror-runs",
    );
  return {
    default: ({
      runs,
      onChange,
      label,
      focusAt,
      maxParagraphs = Number.POSITIVE_INFINITY,
      onFull,
      onLong,
    }: {
      runs: { text: string }[];
      onChange: (
        paragraphs: { text: string }[][],
        caret: { paragraph: number; offset: number },
      ) => void;
      label: string;
      focusAt?: number;
      maxParagraphs?: number;
      onFull?: () => void;
      onLong?: (blocks: readonly number[]) => void;
    }) => (
      <input
        aria-label={label}
        value={runs.map((run) => run.text).join("")}
        autoFocus={focusAt !== undefined}
        onChange={(event) => {
          const cut: number[] = [];
          const pieces = event.target.value.split("|").map((piece, index) => {
            if (piece.length <= 5000) {
              return piece;
            }
            cut.push(index);
            return piece.slice(0, 5000);
          });
          if (cut.length > 0) {
            onLong?.(cut);
          }
          const held = joinParagraphsBeyond(
            pieces.map((text) => [{ text }]),
            { paragraph: pieces.length - 1, offset: 0 },
            maxParagraphs,
          );
          if (held.paragraphs.length < pieces.length) {
            onFull?.();
          }
          onChange(held.paragraphs, held.caret);
        }}
      />
    ),
  };
});

const HOME: AdminPage = {
  id: "page-1",
  slug: "hem",
  title: "Valkommen",
  content: {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
  },
  status: "PUBLIC",
  frontPage: true,
  slugFollowsTitle: false,
  publishedAt: "2026-08-29T09:00:00.000Z",
  sortOrder: 0,
  revision: 2,
  updatedAt: "2026-08-29T09:00:00.000Z",
};

const DRAFT: AdminPage = {
  ...HOME,
  id: "page-2",
  slug: "styrelsen",
  title: "Styrelsen",
  status: "DRAFT",
  frontPage: false,
  slugFollowsTitle: true,
  publishedAt: null,
  sortOrder: 1,
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Bo",
    lastName: "Bostad",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

function renderScreen(capabilities: string[] = ["site:manage"]) {
  return render(<SiteAdminScreen viewer={viewerWith(capabilities)} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchPages.mockResolvedValue({ ok: true, value: [HOME, DRAFT] });
  createPage.mockResolvedValue({ ok: true, value: DRAFT });
  setPageStatus.mockResolvedValue({
    ok: true,
    value: { ...DRAFT, status: "PUBLIC" },
  });
  setFrontPage.mockResolvedValue({
    ok: true,
    value: { ...DRAFT, status: "PUBLIC", frontPage: true },
  });
  savePage.mockResolvedValue({ ok: true, value: DRAFT });
  deletePage.mockResolvedValue({ ok: true, value: undefined });
});

describe("who the screen is for", () => {
  it("offers nothing to an account that may not write the website", async () => {
    renderScreen([]);

    expect(await screen.findByText(/styrelsens/i)).toBeDefined();
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it("offers the way to the menu, and only to whoever may arrange it", async () => {
    // The menu is a screen of its own, so this link is the way to it from the
    // pages: without it, a board would have to know the address.
    const offered = renderScreen();
    expect(
      await screen.findByRole("link", { name: "Ordna menyn" }),
    ).toHaveProperty("href", expect.stringContaining("/admin/site/menu"));

    offered.unmount();
    renderScreen([]);
    expect(screen.queryByRole("link", { name: "Ordna menyn" })).toBeNull();
  });
});

describe("the list of pages", () => {
  it("shows drafts beside published pages, in words", async () => {
    renderScreen();

    expect(await screen.findByText("Valkommen")).toBeDefined();
    expect(screen.getByText("Styrelsen")).toBeDefined();
    // Never colour alone: the status is written out for every page, and so
    // is which one is the front page.
    expect(screen.getByText("Öppen")).toBeDefined();
    expect(screen.getByText("Utkast")).toBeDefined();
    expect(screen.getByText("Startsida")).toBeDefined();
  });
});

describe("writing a new page", () => {
  it("asks for a title and nothing else, and shows the address it will give", async () => {
    const user = userEvent.setup();
    renderScreen();

    await screen.findByText("Valkommen");
    // No address to type and no audience to choose: the address comes from
    // the title and a new page is a draft.
    expect(screen.queryByLabelText(/^Adress/)).toBeNull();
    await user.type(screen.getByLabelText(/^Rubrik/), "Om föreningen");
    expect(screen.getByText(/Den hamnar på \/om-foreningen\./)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Skapa sidan" }));

    await waitFor(() => {
      expect(createPage).toHaveBeenCalledWith({
        title: "Om föreningen",
        content: { blocks: [] },
      });
    });
  });
});

describe("the editor", () => {
  async function openEditor() {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [edit] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(edit as HTMLElement);
    return user;
  }

  it("warns against special-category free text whether or not anything is wrong", async () => {
    await openEditor();

    expect(
      await screen.findByText(
        /namngiven persons halsa|namngiven persons hälsa/i,
      ),
    ).toBeDefined();
  });

  it("warns about a personal identity number before the server refuses one", async () => {
    const user = await openEditor();

    const paragraph = await screen.findByLabelText("Stycke 1");
    await user.clear(paragraph);
    await user.type(paragraph, "Ring Anna pa 19811218-9876");

    expect(await screen.findByText(/personnummer/i)).toBeDefined();
  });

  it("names the block the board is looking at when the API refuses one", async () => {
    /*
     * The half-written blocks this screen leaves out of a submission are still
     * on the screen, so the API's positions and the board's block numbers are
     * not the same numbers. A notice naming the wrong one sends somebody to
     * edit a paragraph that is not the problem, and disagrees with the warning
     * standing above it about the same page.
     */
    const user = await openEditor();
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [{ part: "block", index: 1 }],
      },
    });

    const add = screen.getByRole("button", {
      name: /Lagg till ett stycke|Lägg till ett stycke/,
    });
    await user.click(add);
    await user.click(add);
    await user.type(
      await screen.findByLabelText("Stycke 3"),
      "Ring Anna pa 19811218-9876",
    );

    await user.click(screen.getByRole("button", { name: "Spara" }));

    // The second block sent is the third on the screen. Both notices name that
    // one, and neither names the position it was sent at.
    expect(await screen.findAllByText(/block 3/)).not.toHaveLength(0);
    expect(screen.queryByText(/block 2/)).toBeNull();
  });

  it("says at the paragraph why a paste past its length was cut", async () => {
    const user = await openEditor();
    const paragraph = await screen.findByLabelText("Stycke 1");

    await user.clear(paragraph);
    await user.click(paragraph);
    await user.paste("x".repeat(5100));

    expect((paragraph as HTMLInputElement).value).toHaveLength(5000);
    expect(
      await screen.findByText(/Ett stycke rymmer högst 5000 tecken/),
    ).toBeDefined();
  });

  it("names the length, not a link, when the API refuses text as too long", async () => {
    /*
     * The editor holds a paragraph to the length the server takes, but a page
     * stored before that, or a heading, can still be refused for it. Telling
     * the board to check a link it never wrote sends them looking in the wrong
     * place.
     */
    const user = await openEditor();
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "content.blocks.0.runs.0.text", message: "Too big" }],
      },
    });

    await user.click(screen.getByRole("button", { name: "Spara" }));

    const notice = await screen.findByText(/högst 5000 tecken/);
    expect(notice.textContent).toMatch(/block 1/);
    expect(screen.queryByText(/En länk måste/)).toBeNull();
  });

  it("names the link when a link is what the API refused", async () => {
    const user = await openEditor();
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "content.blocks.0.runs.1.link", message: "Invalid" }],
      },
    });

    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(await screen.findByText(/En länk måste/)).toBeDefined();
    expect(screen.queryByText(/högst 5000 tecken/)).toBeNull();
  });

  it.each([
    ["a cleared title", "Rubrik", ""],
    ["a title of blanks", "Rubrik", "   "],
    ["a title past 200 characters", "Rubrik", "t".repeat(201)],
  ])(
    "names the title, not a paragraph, for %s",
    async (_name, label, value) => {
      const user = await openEditor();
      savePage.mockResolvedValue({
        ok: false,
        failure: {
          status: 400,
          reason: "invalid-body",
          detail: [{ path: "title", message: "Invalid" }],
        },
      });

      const field = screen.getByDisplayValue("Valkommen");
      await user.clear(field);
      if (value !== "") {
        await user.click(field);
        await user.paste(value);
      }
      await user.click(screen.getByRole("button", { name: "Spara" }));

      expect(
        await screen.findByText(/Rubriken måste vara mellan 1 och 200/),
      ).toBeDefined();
      expect(screen.queryByText(/högst 5000 tecken/)).toBeNull();
      expect(screen.queryByText(/En länk måste/)).toBeNull();
    },
  );

  it.each([
    ["a cleared address", ""],
    ["an address of blanks", "   "],
  ])("names the address, not a paragraph, for %s", async (_name, value) => {
    const user = await openEditor();
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "slug", message: "Invalid" }],
      },
    });

    const field = screen.getByDisplayValue("hem");
    await user.clear(field);
    if (value !== "") {
      await user.click(field);
      await user.paste(value);
    }
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await screen.findByText(/Den adressen går inte att använda/),
    ).toBeDefined();
    expect(screen.queryByText(/högst 5000 tecken/)).toBeNull();
  });

  it("keeps writing in the paragraph a return split off", async () => {
    /*
     * The editor being typed into stays mounted, so the keyboard focus is not
     * dropped to the page, and the new paragraph takes it.
     */
    const user = await openEditor();
    const first = await screen.findByLabelText("Stycke 1");

    await user.type(first, "|");

    const second = await screen.findByLabelText("Stycke 2");
    expect(screen.getByLabelText("Stycke 1")).toBe(first);
    expect((first as HTMLInputElement).value).toBe("Hej.");
    expect(document.activeElement).toBe(second);
  });

  it("names the block a move control moves, and keeps the focus on it", async () => {
    const user = await openEditor();
    await user.click(
      screen.getByRole("button", {
        name: /Lagg till en rubrik|Lägg till en rubrik/,
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Flytta block 1, Stycke, nedåt" }),
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Flytta block 2, Stycke, nedåt" }),
    );
    expect(screen.getByRole("status")).toHaveProperty(
      "textContent",
      "Stycke är nu block 2 av 2.",
    );
    expect(
      screen.getByRole("button", { name: "Ta bort block 1, Rubrik" }),
    ).toBeDefined();
  });

  it("holds the page to the lengths and the block count the server allows", async () => {
    const full: AdminPage = {
      ...HOME,
      content: {
        version: 1,
        blocks: [
          { type: "heading", level: 2, runs: [{ text: "Rubrik" }] },
          { type: "image", mediaFileId: "media-1", alt: "" },
          ...Array.from({ length: 198 }, () => ({
            type: "paragraph" as const,
            runs: [{ text: "Text." }],
          })),
        ],
      },
    };
    fetchPages.mockResolvedValue({ ok: true, value: [full] });
    await openEditor();

    expect(screen.getByLabelText("Rubriktext")).toHaveProperty(
      "maxLength",
      5000,
    );
    expect(screen.getByLabelText(/^Beskrivning av bilden/)).toHaveProperty(
      "maxLength",
      300,
    );
    expect(screen.getByLabelText("Bildtext")).toHaveProperty("maxLength", 500);
    expect(
      screen.getByRole("button", {
        name: /Lagg till ett stycke|Lägg till ett stycke/,
      }),
    ).toHaveProperty("disabled", true);
  });

  it("joins what a full page has no block for to the paragraph, and says why", async () => {
    // Every return or pasted paragraph used to become a block of its own, and
    // the server then refused the whole save for holding more than 200.
    const full: AdminPage = {
      ...HOME,
      content: {
        version: 1,
        blocks: Array.from({ length: 200 }, () => ({
          type: "paragraph" as const,
          runs: [{ text: "Text." }],
        })),
      },
    };
    fetchPages.mockResolvedValue({ ok: true, value: [full] });
    const user = await openEditor();

    await user.click(screen.getByLabelText("Stycke 1"));
    await user.paste("|Mer.");

    expect(
      await screen.findAllByText(/så många som en sida får ha/),
    ).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledTimes(1);
    });
    const [, edit] = savePage.mock.calls[0] as [
      string,
      { content: { blocks: { runs?: { text: string }[] }[] } },
    ];
    expect(edit.content.blocks).toHaveLength(200);
    // Nothing dropped: the text that had no block is in the paragraph.
    expect(edit.content.blocks[0]?.runs?.map((run) => run.text).join("")).toBe(
      "Text. Mer.",
    );
  });

  it("takes a page down before it saves the edits beside it", async () => {
    // The page is public, so the radio for a draft is the one choice that is
    // not open on the front page; it is made on the other page here.
    fetchPages.mockResolvedValue({
      ok: true,
      value: [HOME, { ...DRAFT, status: "MEMBERS_ONLY" }],
    });
    setPageStatus.mockResolvedValue({
      ok: true,
      value: { ...DRAFT, revision: 3 },
    });
    savePage.mockResolvedValue({ ok: true, value: { ...DRAFT, revision: 4 } });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);

    await user.click(screen.getByRole("radio", { name: /^Utkast/ }));
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalled();
    });
    // Down first, so half-finished edits are never public even for a moment,
    // and each step claims the revision the one before it produced.
    expect(setPageStatus).toHaveBeenCalledWith("page-2", {
      status: "DRAFT",
      expectedRevision: 2,
    });
    expect(setPageStatus.mock.invocationCallOrder[0]).toBeLessThan(
      savePage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(savePage).toHaveBeenCalledWith(
      "page-2",
      expect.objectContaining({ expectedRevision: 3 }),
    );
  });

  it("saves what is on the screen before publishing it, then makes it the front page", async () => {
    /*
     * The body lives in this screen until it is saved. Publishing without
     * saving first would put the previously stored version on the website -
     * for a page written and not yet saved, a blank one.
     *
     * Each step moves the revision, so each claims the number the one before
     * it produced and not the one the editor was holding when the board
     * pressed the button. The mocks therefore answer with moved revisions: the
     * same one would make the assertions unable to tell a fresh number from a
     * spent one.
     */
    savePage.mockResolvedValue({ ok: true, value: { ...DRAFT, revision: 3 } });
    setPageStatus.mockResolvedValue({
      ok: true,
      value: { ...DRAFT, status: "PUBLIC", revision: 4 },
    });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);

    const paragraph = await screen.findByLabelText("Stycke 1");
    await user.clear(paragraph);
    await user.type(paragraph, "Trapphuset stadas varje tisdag.");

    // Only a public page can be the front page, so the switch waits for it.
    const front = screen.getByRole("switch", {
      name: "Använd som startsida",
    });
    expect(front.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("radio", { name: /^Öppen/ }));
    expect(front.hasAttribute("disabled")).toBe(false);
    await user.click(front);
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(setFrontPage).toHaveBeenCalledWith("page-2", {
        expectedRevision: 4,
      });
    });
    expect(savePage).toHaveBeenCalledWith("page-2", {
      // No address: the page follows its title, and the server makes it.
      title: "Styrelsen",
      content: {
        blocks: [
          {
            type: "paragraph",
            runs: [{ text: "Trapphuset stadas varje tisdag." }],
          },
        ],
      },
      // The copy the editor is holding: the save writes only if the page is
      // still the one it read, so a second writer cannot be written over.
      expectedRevision: 2,
    });
    expect(setPageStatus).toHaveBeenCalledWith("page-2", {
      status: "PUBLIC",
      // The revision the save answered with, not the one this editor opened on.
      expectedRevision: 3,
    });
  });

  it("keeps the front page public, and does not offer to delete it", async () => {
    await openEditor();

    expect(
      screen.getByRole("radio", { name: /^Utkast/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("radio", { name: /^Endast medlemmar/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    const front = screen.getByRole("switch", { name: "Använd som startsida" });
    expect((front as HTMLInputElement).checked).toBe(true);
    // Another page is chosen instead; this one cannot be switched off.
    expect(front.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Ta bort sidan" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends an address only when the board writes one under Advanced", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);

    // While the page follows its title, the address moves as the title is
    // typed, before anything is saved.
    // The editor's, below the new-page panel's.
    const title = screen.getAllByLabelText(/^Rubrik/).at(-1) as HTMLElement;
    await user.clear(title);
    await user.type(title, "Årsstämma");
    expect(screen.getByText("Adress: /arsstamma")).toBeDefined();

    await user.click(screen.getByText("Avancerat"));
    const address = screen.getByLabelText(/^Adress/);
    await user.clear(address);
    await user.type(address, "stamma");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({ slug: "stamma", title: "Årsstämma" }),
      );
    });
  });

  it("reads the page again after somebody else saved it, so the next save can land", async () => {
    /*
     * A save claims the copy it read, so once somebody else has written the
     * editor is holding a revision that will never match again: every retry
     * would be refused for the same reason, with the board's unsaved text
     * trapped behind it. It reads the page again and keeps what they wrote,
     * and the notice says the next save writes over the other version - which
     * is a decision for the person who can see both.
     */
    savePage.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, reason: "page-changed" },
    });
    /*
     * The list as it is when the editor opens, and then as it is after somebody
     * else has saved. Ordered deliberately: with the newer revision on the
     * first read the editor would hold it from the start, and the assertion
     * below would pass whether or not the conflict is recovered from.
     */
    fetchPages
      .mockResolvedValueOnce({ ok: true, value: [HOME, DRAFT] })
      .mockResolvedValue({
        ok: true,
        value: [HOME, { ...DRAFT, revision: 9 }],
      });
    savePage.mockResolvedValue({ ok: true, value: { ...DRAFT, revision: 10 } });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await screen.findByText(/Någon annan sparade sidan medan den var öppen/),
    ).toBeTruthy();

    // The second save carries the revision the re-read brought back.
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(
        "page-2",
        expect.objectContaining({ expectedRevision: 9 }),
      );
    });
  });

  it("says so when the page a deletion would remove is not the one it read", async () => {
    /*
     * A deletion has nothing to read again afterwards, so it takes the same
     * precondition a save does and is refused the same way. What the board is
     * told is the same sentence, because what it has to do is the same: look at
     * the page that is there before deciding a second time.
     */
    deletePage.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "page-changed" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Ta bort sidan" }));

    await waitFor(() => {
      expect(deletePage).toHaveBeenCalledWith("page-2", {
        expectedRevision: 2,
      });
    });
    expect(
      await screen.findByText(/Någon annan sparade sidan medan den var öppen/),
    ).toBeTruthy();
    // And the editor is still open on the page nothing removed.
    expect(screen.getByRole("button", { name: "Ta bort sidan" })).toBeTruthy();
  });

  it("keeps the controls off until the page it would claim against is the one it holds", async () => {
    /*
     * The reload after a conflict is a request like any other. With the buttons
     * back while it is in flight, a second press sends the revision that was
     * just refused and is refused again - the same loop the notice says is
     * over.
     */
    let releaseReload: (value: unknown) => void = () => undefined;
    savePage.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, reason: "page-changed" },
    });
    fetchPages
      .mockResolvedValueOnce({ ok: true, value: [HOME, DRAFT] })
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            releaseReload = resolve;
          }),
      );

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Spara" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    await act(async () => {
      releaseReload({ ok: true, value: [HOME, { ...DRAFT, revision: 9 }] });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Spara" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("keeps the revision its own save produced when the publication is refused", async () => {
    /*
     * Publishing saves the page first, and a publication refused on the merits
     * - a personal identity number on the page, a picture nobody consented to -
     * leaves that save standing. The editor must hold the revision the save
     * produced: otherwise the next save is refused as a conflict and the board
     * is told somebody else wrote the page, at the moment they are correcting
     * one that was refused for carrying somebody's personnummer. Nobody else
     * wrote it. Their own save did.
     */
    savePage.mockResolvedValue({ ok: true, value: { ...DRAFT, revision: 3 } });
    setPageStatus.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);
    await user.click(screen.getByRole("radio", { name: /^Öppen/ }));
    await user.click(screen.getByRole("button", { name: "Spara" }));

    // Refused, and said as the refusal it is.
    expect(await screen.findByText(/personnummer/i)).toBeTruthy();

    // The next save carries what the first one produced, not what it spent.
    setPageStatus.mockResolvedValue({ ok: true, value: DRAFT });
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(
        "page-2",
        expect.objectContaining({ expectedRevision: 3 }),
      );
    });
  });

  describe("blocks this screen does not arrange", () => {
    /*
     * A save carries the whole page, so a block the editor leaves out of the
     * body is a block the save deletes from the saved page. Nobody is told:
     * the editor does not show the block, and the API stores what it was sent.
     */
    async function saveAfterEditing(blocks: PageBlock[]) {
      const page: AdminPage = {
        ...DRAFT,
        slug: "integritet",
        title: "Integritetspolicy",
        content: { version: 1, blocks },
      };
      fetchPages.mockResolvedValue({ ok: true, value: [HOME, page] });

      const user = userEvent.setup();
      renderScreen();
      await screen.findByText("Valkommen");
      const [, second] = screen.getAllByRole("button", { name: "Redigera" });
      await user.click(second as HTMLElement);

      const paragraph = await screen.findByLabelText("Stycke 1");
      await user.clear(paragraph);
      await user.type(paragraph, "Vi behandlar dina uppgifter så här.");
      await user.click(screen.getByRole("button", { name: "Spara" }));

      await waitFor(() => {
        expect(savePage).toHaveBeenCalled();
      });
      return savePage.mock.calls.at(-1)?.[1] as {
        content: { blocks: PageBlock[] };
      };
    }

    it("keeps the controller's contact block on the privacy notice", async () => {
      /*
       * Placed by the privacy notice screen, and what the notice needs to say
       * who is responsible for the processing (GDPR art. 13(1)(a)). Losing it on
       * a save to a paragraph leaves a notice that no longer names anyone.
       */
      const edit = await saveAfterEditing([
        { type: "paragraph", runs: [{ text: "Gammal text." }] },
        { type: "controllerContact" },
      ]);

      expect(edit.content.blocks).toEqual([
        {
          type: "paragraph",
          runs: [{ text: "Vi behandlar dina uppgifter så här." }],
        },
        { type: "controllerContact" },
      ]);
    });

    it("keeps a block type it does not know, unchanged", async () => {
      /*
       * A newer API can store a block this build of the interface has never
       * heard of. Not knowing how to edit it is no reason to delete it.
       */
      const future = {
        type: "somethingNewer",
        setting: 4,
      } as unknown as PageBlock;

      const edit = await saveAfterEditing([
        { type: "paragraph", runs: [{ text: "Gammal text." }] },
        future,
      ]);

      expect(edit.content.blocks).toEqual([
        {
          type: "paragraph",
          runs: [{ text: "Vi behandlar dina uppgifter så här." }],
        },
        { type: "somethingNewer", setting: 4 },
      ]);
    });
  });
});
