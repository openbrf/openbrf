import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import i18n from "../i18n";
import type { Viewer } from "../api/instance";
import type { AdminPage, PageBlock } from "../api/site";
import { asSupportSession } from "../support/support-fixtures";
import { PageEditorScreen } from "./PageEditorScreen";

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
const navigate = vi.fn();

const blocker = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
    "aria-label": label,
  }: {
    to: string;
    params?: { pageId?: string };
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
  }): ReactElement => (
    <a
      className={className}
      aria-label={label}
      href={
        params?.pageId === undefined ? to : to.replace("$pageId", params.pageId)
      }
    >
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useBlocker: (options: unknown) => {
    blocker(options);
  },
}));

const fetchPages = vi.fn();
const createPage = vi.fn();
const setPageStatus = vi.fn();
const setFrontPage = vi.fn();
const savePage = vi.fn();
const deletePage = vi.fn();
const fetchPluginBlocks = vi.fn();
const fetchAssociationFacts = vi.fn();

vi.mock("./site-facts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./site-facts-api")>()),
  fetchAssociationFacts: () => fetchAssociationFacts(),
}));

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  createPage: (page: unknown) => createPage(page),
  setPageStatus: (id: string, input: unknown) => setPageStatus(id, input),
  setFrontPage: (id: string, input: unknown) => setFrontPage(id, input),
  savePage: (id: string, edit: unknown) => savePage(id, edit),
  deletePage: (id: string, input: unknown) => deletePage(id, input),
  fetchPluginBlocks: () => fetchPluginBlocks(),
}));

/**
 * A plugin's words are fetched from the instance; here they are put in the
 * store by the test that needs them, so loading them is nothing.
 */
vi.mock("../plugins/plugin-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-i18n")>()),
  loadPluginTranslations: async () => undefined,
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
  builtIn: null,
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

/** The news index, which every instance has as a built-in page. */
const NEWS: AdminPage = {
  ...HOME,
  id: "built-in-news",
  slug: "nyheter",
  title: "Nyheter",
  content: { version: 1, blocks: [] },
  frontPage: false,
  builtIn: "NEWS",
  sortOrder: 1001,
  revision: 1,
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

function renderScreen(
  pageId = "page-1",
  capabilities: string[] = ["site:manage"],
) {
  return render(
    <PageEditorScreen viewer={viewerWith(capabilities)} pageId={pageId} />,
  );
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
  fetchPluginBlocks.mockResolvedValue({ ok: true, value: { blocks: [] } });
});

/**
 * A page of two hundred blocks is drawn whole in jsdom, which a busy machine
 * running the suite in parallel can make take longer than the default allows.
 */
const FULL_PAGE = { timeout: 15_000 };

/** The words the editor last said where a screen reader hears them. */
function announced(): string | null | undefined {
  return document.querySelector("p.sr-only[role=status]")?.textContent;
}

/** Adds a block of this kind with the + at the end of the page. */
async function addBlock(
  user: ReturnType<typeof userEvent.setup>,
  kind: string,
  where = "Lägg till ett block sist på sidan",
): Promise<void> {
  await user.click(screen.getByRole("button", { name: where }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: kind }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

describe("the editor", () => {
  async function openEditor() {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByDisplayValue("Valkommen");
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

    await addBlock(user, "Stycke");
    await addBlock(user, "Stycke");
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
    await addBlock(user, "Rubrik");

    await user.click(
      screen.getByRole("button", { name: "Flytta ner, block 1, Stycke" }),
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Flytta ner, block 2, Stycke" }),
    );
    expect(announced()).toBe("Stycke är nu block 2 av 2.");
    expect(
      screen.getByRole("button", { name: "Ta bort, block 1, Rubrik" }),
    ).toBeDefined();
  });

  it("keeps the focus in the editor and says so when a block is removed from the keyboard", async () => {
    const user = await openEditor();
    await addBlock(user, "Rubrik");
    await addBlock(user, "Rubrik");
    // Three blocks: a paragraph and two headings.
    const remove = (number: number, kind: string) =>
      screen.getByRole("button", {
        name: `Ta bort, block ${String(number)}, ${kind}`,
      });

    // The middle one: the focus goes to the block that took its place.
    remove(2, "Rubrik").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Flytta block 2, Rubrik" }),
    );
    expect(announced()).toBe(
      "Rubrik (block 2) togs bort. Block kvar på sidan: 2. Ångra lägger tillbaka det.",
    );

    // The last one: the focus goes to the block before it.
    remove(2, "Rubrik").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Flytta block 1, Stycke" }),
    );

    // The only one left: the focus goes to the + at the end of the page.
    remove(1, "Stycke").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Lägg till ett block sist på sidan" }),
    );
    expect(announced()).toBe(
      "Stycke (block 1) togs bort. Block kvar på sidan: 0. Ångra lägger tillbaka det.",
    );
  });

  it(
    "holds the page to the lengths and the block count the server allows",
    FULL_PAGE,
    async () => {
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

      expect(screen.getByLabelText("Rubriktext, block 1")).toHaveProperty(
        "maxLength",
        5000,
      );
      expect(screen.getByLabelText("Bildtext, block 2")).toHaveProperty(
        "maxLength",
        500,
      );
      // The picture's description is a setting, beside the page once the
      // picture is selected.
      await userEvent.click(screen.getByLabelText("Bildtext, block 2"));
      expect(screen.getByLabelText(/^Beskrivning av bilden/)).toHaveProperty(
        "maxLength",
        300,
      );
      // A full page offers no + that would add a block it cannot hold.
      expect(
        screen
          .getByRole("button", { name: "Lägg till ett block sist på sidan" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen
          .getByRole("button", {
            name: "Lägg till ett block efter block 1, Rubrik",
          })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    },
  );

  it(
    "joins what a full page has no block for to the paragraph, and says why",
    FULL_PAGE,
    async () => {
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

      await user.click(await screen.findByLabelText("Stycke 1"));
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
      expect(
        edit.content.blocks[0]?.runs?.map((run) => run.text).join(""),
      ).toBe("Text. Mer.");
    },
  );

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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

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

  describe("closing a public page to the members", () => {
    /*
     * A page leaving the street must not have its new words read there first.
     * The members' text saved before the status would be public between the
     * two requests - and, if the status were refused, public for good.
     */
    const PUBLIC_PAGE: AdminPage = {
      ...DRAFT,
      status: "PUBLIC",
      slugFollowsTitle: false,
      publishedAt: "2026-09-01T09:00:00.000Z",
    };

    async function closeWithEdits() {
      fetchPages.mockResolvedValue({ ok: true, value: [HOME, PUBLIC_PAGE] });
      const user = userEvent.setup();
      renderScreen("page-2");
      await screen.findByDisplayValue("Styrelsen");

      const paragraph = await screen.findByLabelText("Stycke 1");
      await user.clear(paragraph);
      await user.type(paragraph, "Portkoden är 1234.");
      await user.click(
        screen.getByRole("radio", { name: /^Endast medlemmar/ }),
      );
      await user.click(screen.getByRole("button", { name: "Spara" }));
    }

    it("restricts the audience before it writes the edits", async () => {
      // What the server holds when the body arrives: the status request has
      // already answered, so the words land on a members' page.
      let statusWhenBodySaved: string | null = null;
      let stored: AdminPage = PUBLIC_PAGE;
      setPageStatus.mockImplementation(
        async (_id: string, input: { status: AdminPage["status"] }) => {
          stored = { ...stored, status: input.status, revision: 3 };
          return { ok: true, value: stored };
        },
      );
      savePage.mockImplementation(async () => {
        statusWhenBodySaved = stored.status;
        stored = { ...stored, revision: 4 };
        return { ok: true, value: stored };
      });

      await closeWithEdits();

      await waitFor(() => {
        expect(savePage).toHaveBeenCalled();
      });
      expect(setPageStatus).toHaveBeenCalledWith("page-2", {
        status: "MEMBERS_ONLY",
        expectedRevision: 2,
      });
      expect(statusWhenBodySaved).toBe("MEMBERS_ONLY");
      // The body claims the revision the status produced.
      expect(savePage).toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({ expectedRevision: 3 }),
      );
    });

    it("writes nothing when the audience could not be restricted", async () => {
      setPageStatus.mockResolvedValue({
        ok: false,
        failure: { status: 503 },
      });

      await closeWithEdits();

      expect(
        await screen.findByText(
          "Det gick inte att spara just nu. Försök igen.",
        ),
      ).toBeDefined();
      // The page is still public, so the members' words stay in the editor.
      expect(savePage).not.toHaveBeenCalled();
    });
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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

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

  it("keeps the address the board typed, even when it is the one the page has", async () => {
    /*
     * Writing the stored address under Advanced is the choice to keep it.
     * Left out of the save, a page that follows its title would move to the
     * address its new title gives, which is not the one on the screen - and
     * would go on moving with every rename after.
     */
    const user = userEvent.setup();
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

    const title = screen.getAllByLabelText(/^Rubrik/).at(-1) as HTMLElement;
    await user.clear(title);
    await user.type(title, "Årsstämma");

    await user.click(screen.getByText("Avancerat"));
    const address = screen.getByLabelText(/^Adress/);
    await user.clear(address);
    await user.type(address, "styrelsen");
    expect(screen.getByText("Adress: /styrelsen")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({ slug: "styrelsen", title: "Årsstämma" }),
      );
    });
  });

  it.each([
    [
      "a published page",
      { publishedAt: "2026-09-01T09:00:00.000Z" },
      /Sidan har publicerats/,
    ],
    // Typed by hand, or kept from before addresses followed titles: either
    // way it has never been published, and the sentence must not say it has.
    [
      "a draft never published",
      { publishedAt: null },
      /En ny rubrik ändrar inte den här adressen/,
    ],
  ])(
    "says why the address of %s no longer follows its title",
    async (_name, override, sentence) => {
      fetchPages.mockResolvedValue({
        ok: true,
        value: [HOME, { ...DRAFT, slugFollowsTitle: false, ...override }],
      });
      const user = userEvent.setup();
      renderScreen("page-2");
      await screen.findByDisplayValue("Styrelsen");

      await user.click(screen.getByText("Avancerat"));
      expect(screen.getByText(sentence)).toBeDefined();
    },
  );

  it("lets the old front page be taken down and deleted once another is chosen", async () => {
    /*
     * Choosing a page replaces the front page on the server in one
     * transaction, and the page that was the front page is read from there
     * when it is opened next: it no longer refuses the acts the choice was
     * made to allow.
     */
    const published: AdminPage = {
      ...DRAFT,
      status: "PUBLIC",
      slugFollowsTitle: false,
      publishedAt: "2026-09-01T09:00:00.000Z",
    };
    fetchPages.mockResolvedValue({ ok: true, value: [HOME, published] });
    savePage.mockResolvedValue({ ok: true, value: published });
    setFrontPage.mockResolvedValue({
      ok: true,
      value: { ...published, frontPage: true },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    const chosen = renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
    await user.click(
      screen.getByRole("switch", { name: "Använd som startsida" }),
    );
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(setFrontPage).toHaveBeenCalledWith("page-2", {
        expectedRevision: 2,
      });
    });
    // The page says it is the front page now.
    expect(await screen.findByText("Öppen · Startsida")).toBeDefined();

    chosen.unmount();
    fetchPages.mockResolvedValue({
      ok: true,
      value: [
        { ...HOME, frontPage: false },
        { ...published, frontPage: true },
      ],
    });
    renderScreen("page-1");
    await screen.findByDisplayValue("Valkommen");
    expect(
      screen.getByRole("radio", { name: /^Utkast/ }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("radio", { name: /^Endast medlemmar/ })
        .hasAttribute("disabled"),
    ).toBe(false);
    const remove = screen.getByRole("button", { name: "Ta bort sidan" });
    expect(remove.hasAttribute("disabled")).toBe(false);
    await user.click(remove);

    await waitFor(() => {
      expect(deletePage).toHaveBeenCalledWith("page-1", {
        expectedRevision: 2,
      });
    });
  });

  it("keeps a plugin's block it cannot show, in its place, when it saves", async () => {
    /*
     * A namespaced block no definition is registered for: what a page holds
     * once the plugin that wrote it is switched off. The editor has nothing to
     * edit it with, and a save carries the whole page - so leaving it out would
     * delete it without anybody having asked for that.
     */
    const poll = {
      type: "example-plugin/poll" as const,
      question: "Ska vi måla om trapphuset?",
    };
    fetchPages.mockResolvedValue({
      ok: true,
      value: [
        HOME,
        {
          ...DRAFT,
          content: {
            version: 1,
            blocks: [poll, { type: "paragraph", runs: [{ text: "Hej." }] }],
          },
        },
      ],
    });

    const user = userEvent.setup();
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

    // Named as what it is, not by its type id, and with the controls every
    // block has.
    expect(
      await screen.findAllByText("Block från ett tillägg"),
    ).not.toHaveLength(0);
    // Said once the instance has told the editor which plugins serve.
    expect(
      await screen.findByText(/Blocket är inte tillgängligt just nu/),
    ).toBeDefined();
    expect(screen.queryByText(/example-plugin/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Ta bort, block 1/ }),
    ).toBeDefined();

    const paragraph = await screen.findByLabelText("Stycke 2");
    await user.clear(paragraph);
    await user.type(paragraph, "Svara senast fredag.");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({
          content: {
            blocks: [
              poll,
              { type: "paragraph", runs: [{ text: "Svara senast fredag." }] },
            ],
          },
        }),
      );
    });
  });

  it("does not say a plugin's block is off the website when it could not ask", async () => {
    // The instance never answered, so the block may be a serving plugin's
    // that the website is showing right now.
    fetchPluginBlocks.mockResolvedValue({
      ok: false,
      failure: { status: 503, reason: "unavailable" },
    });
    fetchPages.mockResolvedValue({
      ok: true,
      value: [
        HOME,
        {
          ...DRAFT,
          content: {
            version: 1,
            blocks: [{ type: "example-plugin/poll", question: "Måla?" }],
          },
        },
      ],
    });

    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

    expect(
      await screen.findByText(/tilläggens block kunde inte hämtas/),
    ).toBeDefined();
    expect(screen.queryByText(/visas inte på webbplatsen/)).toBeNull();
  });

  it("keeps a stored plugin's block its plugin now asks more of, and says why the page was not saved", async () => {
    /*
     * The block was set up before an upgrade added a setting the plugin now
     * requires. A save carries the whole page, so sending it without the block
     * would delete the block and everything set on it - while the board was
     * only changing the title.
     */
    i18n.addResourceBundle("sv", "plugin-laundry", {
      blocks: {
        schedule: {
          label: "Tvättschema",
          heading: "Schemats rubrik",
          message: "Meddelande",
        },
      },
    });
    const block = {
      type: "laundry/schedule" as const,
      settings: { message: "Existing content" },
    };
    fetchPages.mockResolvedValue({
      ok: true,
      value: [
        HOME,
        {
          ...DRAFT,
          content: {
            version: 1,
            blocks: [block, { type: "paragraph", runs: [{ text: "Hej." }] }],
          },
        },
      ],
    });
    fetchPluginBlocks.mockResolvedValue({
      ok: true,
      value: {
        blocks: [
          {
            type: "laundry/schedule",
            pluginId: "laundry",
            labelKey: "blocks.schedule.label",
            icon: "calendar",
            category: "association",
            fields: [
              {
                key: "message",
                labelKey: "blocks.schedule.message",
                type: "text",
                required: true,
              },
              {
                key: "heading",
                labelKey: "blocks.schedule.heading",
                type: "text",
                required: true,
              },
            ],
          },
        ],
      },
    });

    const user = userEvent.setup();
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");

    expect(
      await screen.findByText(/Tillägget frågar nu efter inställningar/),
    ).toBeDefined();
    const title = screen.getByDisplayValue("Styrelsen");
    await user.clear(title);
    await user.type(title, "Tvättstugan");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await screen.findByText(/Sidan sparades inte: block 1 saknar/),
    ).toBeDefined();
    expect(savePage).not.toHaveBeenCalled();

    // Answered, the block goes back with the rest of the page.
    await user.type(screen.getByLabelText("Schemats rubrik"), "Schema");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({
          title: "Tvättstugan",
          content: {
            blocks: [
              {
                type: "laundry/schedule",
                settings: { message: "Existing content", heading: "Schema" },
              },
              { type: "paragraph", runs: [{ text: "Hej." }] },
            ],
          },
        }),
      );
    });
    expect(screen.queryByText(/Sidan sparades inte/)).toBeNull();
  });

  it("does not count a stored plugin's block as unsaved work once its plugin has answered", async () => {
    // Before the answer the block reads as ready; after it, as one the plugin
    // asks more of. Nothing was edited, so nothing is to be lost by leaving.
    i18n.addResourceBundle("sv", "plugin-laundry", {
      blocks: { schedule: { label: "Tvättschema", heading: "Rubrik" } },
    });
    let answer: (value: unknown) => void = () => undefined;
    fetchPluginBlocks.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    fetchPages.mockResolvedValue({
      ok: true,
      value: [
        HOME,
        {
          ...DRAFT,
          content: {
            version: 1,
            blocks: [{ type: "laundry/schedule", settings: {} }],
          },
        },
      ],
    });
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
    const latest = () =>
      blocker.mock.calls.at(-1)?.[0] as { enableBeforeUnload: () => boolean };

    answer({
      ok: true,
      value: {
        blocks: [
          {
            type: "laundry/schedule",
            pluginId: "laundry",
            labelKey: "blocks.schedule.label",
            icon: "calendar",
            category: "association",
            fields: [
              {
                key: "heading",
                labelKey: "blocks.schedule.heading",
                type: "text",
                required: true,
              },
            ],
          },
        ],
      },
    });

    expect(
      await screen.findByText(/Tillägget frågar nu efter inställningar/),
    ).toBeDefined();
    expect(latest().enableBeforeUnload()).toBe(false);

    await userEvent.setup().type(screen.getByDisplayValue("Styrelsen"), "x");
    expect(latest().enableBeforeUnload()).toBe(true);
  });

  it("offers a serving plugin's block, sets it up with its own form, and sends it", async () => {
    i18n.addResourceBundle("sv", "plugin-laundry", {
      blocks: {
        schedule: {
          label: "Tvättschema",
          heading: "Schemats rubrik",
          days: "Antal dagar",
        },
      },
    });
    fetchPluginBlocks.mockResolvedValue({
      ok: true,
      value: {
        blocks: [
          {
            type: "laundry/schedule",
            pluginId: "laundry",
            labelKey: "blocks.schedule.label",
            icon: "calendar",
            category: "association",
            fields: [
              {
                key: "heading",
                labelKey: "blocks.schedule.heading",
                type: "text",
                required: true,
              },
              {
                key: "days",
                labelKey: "blocks.schedule.days",
                type: "number",
                required: false,
                integer: true,
                default: 7,
              },
            ],
          },
        ],
      },
    });

    const user = await openEditor();
    // Offered by the + once the instance has said which plugins serve.
    await waitFor(() => {
      expect(fetchPluginBlocks).toHaveBeenCalled();
    });
    await addBlock(user, "Tvättschema");

    // Named by the plugin, in the board's language, like any other block.
    expect(await screen.findAllByText("Tvättschema")).not.toHaveLength(0);
    expect(
      screen.getAllByText(/Blocket kommer från ett tillägg/),
    ).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /Ta bort, block 2/ }),
    ).toBeDefined();
    expect(screen.getByLabelText("Antal dagar")).toHaveProperty("value", "7");

    await user.type(screen.getByLabelText("Schemats rubrik"), "Tvättstugan");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-1",
        expect.objectContaining({
          content: {
            blocks: [
              { type: "paragraph", runs: [{ text: "Hej." }] },
              {
                type: "laundry/schedule",
                settings: { days: 7, heading: "Tvättstugan" },
              },
            ],
          },
        }),
      );
    });
  });

  it("does not send a plugin's block before its required settings are answered", async () => {
    // Like a picture with no file chosen: a state the editor allows while the
    // board is working, and not a block the website can render.
    i18n.addResourceBundle("sv", "plugin-laundry", {
      blocks: {
        schedule: { label: "Tvättschema", heading: "Schemats rubrik" },
      },
    });
    fetchPluginBlocks.mockResolvedValue({
      ok: true,
      value: {
        blocks: [
          {
            type: "laundry/schedule",
            pluginId: "laundry",
            labelKey: "blocks.schedule.label",
            icon: "calendar",
            category: "association",
            fields: [
              {
                key: "heading",
                labelKey: "blocks.schedule.heading",
                type: "text",
                required: true,
              },
            ],
          },
        ],
      },
    });

    const user = await openEditor();
    await waitFor(() => {
      expect(fetchPluginBlocks).toHaveBeenCalled();
    });
    await addBlock(user, "Tvättschema");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(
        "page-1",
        expect.objectContaining({
          content: {
            blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
          },
        }),
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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
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

  describe("a page somebody else closed while it was open here", () => {
    /*
     * Two editors on one public page. The other takes it down or closes it to
     * the members, so this editor's save is refused and the page read again.
     * Nobody here chose an audience: the retry must leave the page where the
     * other editor put it, not open it to the street again with this editor's
     * words on it.
     */
    const PUBLIC_PAGE: AdminPage = {
      ...DRAFT,
      status: "PUBLIC",
      slugFollowsTitle: false,
      publishedAt: "2026-09-01T09:00:00.000Z",
    };

    const CONFLICT = {
      ok: false,
      failure: { status: 409, reason: "page-changed" },
    } as const;

    /** Opens the public page with new words, as the other editor closes it. */
    async function editWhileClosed(closed: AdminPage["status"]) {
      const restricted = { ...PUBLIC_PAGE, status: closed, revision: 9 };
      fetchPages
        .mockResolvedValueOnce({ ok: true, value: [HOME, PUBLIC_PAGE] })
        .mockResolvedValue({ ok: true, value: [HOME, restricted] });
      savePage.mockResolvedValue({
        ok: true,
        value: { ...restricted, revision: 10 },
      });

      const user = userEvent.setup();
      renderScreen("page-2");
      await screen.findByDisplayValue("Styrelsen");
      const paragraph = await screen.findByLabelText("Stycke 1");
      await user.clear(paragraph);
      await user.type(paragraph, "Portkoden är 1234.");
      return user;
    }

    it.each([
      ["taken down", "DRAFT", /^Utkast/],
      ["closed to the members", "MEMBERS_ONLY", /^Endast medlemmar/],
    ] as const)(
      "keeps a page %s elsewhere where it is when the words are saved again",
      async (_name, closed, radio) => {
        const user = await editWhileClosed(closed);
        savePage.mockResolvedValueOnce(CONFLICT);
        await user.click(screen.getByRole("button", { name: "Spara" }));
        expect(
          await screen.findByText(
            /Någon annan sparade sidan medan den var öppen/,
          ),
        ).toBeTruthy();
        // The screen says what the page is now, not what it was.
        await waitFor(() => {
          expect(
            (screen.getByRole("radio", { name: radio }) as HTMLInputElement)
              .checked,
          ).toBe(true);
        });

        await user.click(screen.getByRole("button", { name: "Spara" }));
        await waitFor(() => {
          expect(savePage).toHaveBeenLastCalledWith(
            "page-2",
            expect.objectContaining({ expectedRevision: 9 }),
          );
        });
        expect(await screen.findByText("Sparad.")).toBeTruthy();
        // A content-only save: nothing asks for the audience to change.
        expect(setPageStatus).not.toHaveBeenCalled();
      },
    );

    it("keeps an audience the board chose here, read again or not", async () => {
      // The other editor took the page down; this one had decided it is for
      // the members. That decision was made on this screen and stands. Closing
      // the page, the status goes first, so it is the request refused.
      const user = await editWhileClosed("DRAFT");
      setPageStatus.mockResolvedValueOnce(CONFLICT).mockResolvedValue({
        ok: true,
        value: { ...PUBLIC_PAGE, status: "MEMBERS_ONLY", revision: 11 },
      });
      await user.click(
        screen.getByRole("radio", { name: /^Endast medlemmar/ }),
      );
      await user.click(screen.getByRole("button", { name: "Spara" }));
      expect(
        await screen.findByText(
          /Någon annan sparade sidan medan den var öppen/,
        ),
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("radio", {
            name: /^Endast medlemmar/,
          }) as HTMLInputElement
        ).checked,
      ).toBe(true);

      await user.click(screen.getByRole("button", { name: "Spara" }));
      await waitFor(() => {
        expect(setPageStatus).toHaveBeenCalledWith("page-2", {
          status: "MEMBERS_ONLY",
          expectedRevision: 10,
        });
      });
      expect(setPageStatus).not.toHaveBeenCalledWith(
        "page-2",
        expect.objectContaining({ status: "PUBLIC" }),
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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
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
    renderScreen("page-2");
    await screen.findByDisplayValue("Styrelsen");
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
      renderScreen("page-2");
      await screen.findByDisplayValue("Integritetspolicy");

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

describe("a button on an own page", () => {
  it("offers the website's pages, a built-in page by the title the board gave it, and not the account request form", async () => {
    const user = userEvent.setup();
    const requestAccount: AdminPage = {
      ...NEWS,
      id: "built-in-request-account",
      slug: "app/request-account",
      title: "Ansök om konto",
      builtIn: "REQUEST_ACCOUNT",
    };
    fetchPages.mockResolvedValue({
      ok: true,
      value: [HOME, { ...NEWS, title: "Aktuellt" }, requestAccount],
    });
    renderScreen();
    await screen.findByDisplayValue("Valkommen");

    await addBlock(user, "Knapp");

    const picker = await screen.findByRole("combobox", { name: "Sida" });
    const options = within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Välj en sida",
      "Valkommen",
      "Aktuellt (inbyggd sida)",
    ]);

    // Chosen like any page, by its id.
    await user.selectOptions(picker, NEWS.id);
    expect(picker).toHaveProperty("value", NEWS.id);
  });
});

describe("a built-in page", () => {
  async function openNews(): Promise<void> {
    fetchPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    renderScreen(NEWS.id);
    await screen.findByDisplayValue("Nyheter");
  }

  it("offers its title and nothing else to write", async () => {
    await openNews();

    // Said, not offered: no status to choose, no address to type, no
    // front page to make it, no blocks to add and no way to delete it.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ta bort sidan/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Lägg till ett block sist på sidan",
      }),
    ).toBeNull();
    expect(screen.getByText("Alltid öppen för alla.")).toBeDefined();
    // And the way to where the news is written.
    expect(screen.getByRole("link", { name: "Skriv nyheter" })).toHaveProperty(
      "href",
      expect.stringContaining("/board/news"),
    );
  });

  it("records the broker information page's facts on the page itself", async () => {
    // The page is made from the association facts, and this is where the
    // board records them: the page has no screen of its own elsewhere.
    fetchAssociationFacts.mockReturnValue(new Promise(() => undefined));
    const broker: AdminPage = {
      ...NEWS,
      id: "built-in-broker-information",
      slug: "maklarinfo",
      title: "Mäklarinfo",
      builtIn: "BROKER_INFORMATION",
    };
    fetchPages.mockResolvedValue({ ok: true, value: [HOME, broker] });
    renderScreen(broker.id);

    expect(
      await screen.findByRole("heading", { name: "Föreningens uppgifter" }),
    ).toBeDefined();
    expect(fetchAssociationFacts).toHaveBeenCalled();
  });

  it("saves a new title with the empty body it has", async () => {
    savePage.mockResolvedValue({
      ok: true,
      value: { ...NEWS, title: "Aktuellt", revision: 2 },
    });
    await openNews();

    const field = screen.getByDisplayValue("Nyheter");
    await userEvent.clear(field);
    await userEvent.type(field, "Aktuellt");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith(NEWS.id, {
        title: "Aktuellt",
        content: { blocks: [] },
        expectedRevision: 1,
      });
    });
    expect(await screen.findByText("Sparad.")).toBeDefined();
  });

  it("sends one save at a time, even when the title is edited while one is out", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    savePage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerFirst = resolve;
        }),
      )
      .mockResolvedValue({
        ok: true,
        value: { ...NEWS, title: "Aktuellt!", revision: 3 },
      });
    await openNews();

    const field = screen.getByDisplayValue("Nyheter");
    await userEvent.clear(field);
    await userEvent.type(field, "Aktuellt");
    const button = screen.getByRole("button", { name: "Spara" });

    // Two presses before the button is drawn again send one save.
    act(() => {
      button.click();
      button.click();
    });
    expect(savePage).toHaveBeenCalledTimes(1);

    // An edit while it is out clears the outcome, not the write: the next
    // save waits for this one's answer rather than claiming its revision.
    await userEvent.type(field, "!");
    expect(button).toHaveProperty("disabled", true);
    await userEvent.click(button);
    expect(savePage).toHaveBeenCalledTimes(1);

    await act(async () => {
      answerFirst({
        ok: true,
        value: { ...NEWS, title: "Aktuellt", revision: 2 },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(button).toHaveProperty("disabled", false);
    });
    // The answer is to a title no longer on the screen, so it is not called
    // saved, and the edit made since stays where it is.
    expect(screen.queryByText("Sparad.")).toBeNull();
    expect(screen.getByDisplayValue("Aktuellt!")).toBeDefined();

    // The next save claims the revision the first one produced.
    await userEvent.click(button);
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(NEWS.id, {
        title: "Aktuellt!",
        content: { blocks: [] },
        expectedRevision: 2,
      });
    });
    expect(savePage).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Sparad.")).toBeDefined();
  });

  it("reads the page again after somebody else saved it, so the next save can land", async () => {
    savePage
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 409, reason: "page-changed" },
      })
      .mockResolvedValue({
        ok: true,
        value: { ...NEWS, title: "Aktuellt", revision: 10 },
      });
    // Ordered deliberately: the newer revision comes only with the second read.
    fetchPages
      .mockResolvedValueOnce({ ok: true, value: [HOME, NEWS] })
      .mockResolvedValue({
        ok: true,
        value: [HOME, { ...NEWS, revision: 9 }],
      });
    renderScreen(NEWS.id);

    const field = await screen.findByDisplayValue("Nyheter");
    await userEvent.clear(field);
    await userEvent.type(field, "Aktuellt");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));
    expect(
      await screen.findByText(/Någon annan sparade sidan medan den var öppen/),
    ).toBeTruthy();

    // The title is kept, and the second save carries the revision just read.
    await waitFor(() => {
      expect(fetchPages).toHaveBeenCalledTimes(2);
    });
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(NEWS.id, {
        title: "Aktuellt",
        content: { blocks: [] },
        expectedRevision: 9,
      });
    });
  });

  it("drops a re-read a later one has overtaken", async () => {
    const conflict = {
      ok: false as const,
      failure: { status: 409, reason: "page-changed" },
    };
    savePage
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce(conflict)
      .mockResolvedValue({ ok: true, value: { ...NEWS, revision: 10 } });
    let answerFirst: (value: unknown) => void = () => undefined;
    fetchPages
      .mockResolvedValueOnce({ ok: true, value: [HOME, NEWS] })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerFirst = resolve;
        }),
      )
      .mockResolvedValue({ ok: true, value: [HOME, { ...NEWS, revision: 9 }] });
    renderScreen(NEWS.id);
    await screen.findByDisplayValue("Nyheter");

    // The first re-read hangs; the second one, sent after it, answers first.
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(fetchPages).toHaveBeenCalledTimes(2);
    });
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(fetchPages).toHaveBeenCalledTimes(3);
    });

    // The overtaken read lands last, with an older revision, and is dropped.
    await act(async () => {
      answerFirst({ ok: true, value: [HOME, { ...NEWS, revision: 8 }] });
      await Promise.resolve();
    });

    await userEvent.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(NEWS.id, {
        title: "Nyheter",
        content: { blocks: [] },
        expectedRevision: 9,
      });
    });
  });
});

describe("a support session", () => {
  it("is told the editor is read only and reads no page into it", async () => {
    render(
      <PageEditorScreen
        viewer={asSupportSession(viewerWith(["site:manage"]))}
        pageId="page-1"
      />,
    );

    expect(
      await screen.findByText(/Supportåtkomst är bara läsande/),
    ).toBeDefined();
    expect(screen.queryByDisplayValue("Valkommen")).toBeNull();
    expect(fetchPages).not.toHaveBeenCalled();
  });
});
