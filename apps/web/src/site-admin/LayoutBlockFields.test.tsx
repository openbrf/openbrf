import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { AdminPage } from "../api/site";
import { PageEditor } from "./PageEditor";

/**
 * The blocks that arrange a page, built in today's editor the way a board
 * member builds them: with fields, buttons and the keyboard.
 *
 * What is under test is what pressing save sends. The website's rendering of
 * these blocks and the write path's refusals are tested in the API.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const savePage = vi.fn();
const uploadSiteImage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  savePage: (id: string, edit: unknown) => savePage(id, edit),
  uploadSiteImage: (file: File, shows: boolean) => uploadSiteImage(file, shows),
}));

/**
 * The text editor as a plain field, one paragraph per "|", as in the screen's
 * own tests: the mapping to runs has tests of its own.
 */
vi.mock("./RichText", () => ({
  default: ({
    runs,
    onChange,
    label,
  }: {
    runs: { text: string }[];
    onChange: (
      paragraphs: { text: string }[][],
      caret: { paragraph: number; offset: number },
    ) => void;
    label: string;
  }) => (
    <input
      aria-label={label}
      value={runs.map((run) => run.text).join("")}
      onChange={(event) => {
        const pieces = event.target.value.split("|");
        onChange(
          pieces.map((text) => (text === "" ? [] : [{ text }])),
          { paragraph: pieces.length - 1, offset: 0 },
        );
      }}
    />
  ),
}));

const PAGE: AdminPage = {
  id: "page-1",
  slug: "hem",
  title: "Välkommen",
  content: { version: 1, blocks: [] },
  status: "DRAFT",
  frontPage: false,
  slugFollowsTitle: true,
  publishedAt: null,
  builtIn: null,
  sortOrder: 0,
  revision: 1,
  updatedAt: "2026-10-18T09:00:00.000Z",
};

const PAGES = [
  { id: "page-1", title: "Välkommen" },
  { id: "page-2", title: "Stadgar" },
];

function renderEditor() {
  const user = userEvent.setup();
  render(
    <PageEditor
      page={PAGE}
      pages={PAGES}
      onChanged={vi.fn()}
      onRemoved={vi.fn()}
    />,
  );
  return user;
}

/** The body the last save sent. */
function savedBlocks(): unknown {
  const [, edit] = savePage.mock.calls.at(-1) ?? [];
  return (edit as { content: { blocks: unknown[] } }).content.blocks;
}

/**
 * Typing through a whole block's fields takes a couple of seconds in jsdom,
 * and a busy machine can make it more, as in the page editor's own tests.
 */
const SLOW = { timeout: 15_000 };

beforeEach(() => {
  vi.clearAllMocks();
  savePage.mockResolvedValue({ ok: true, value: PAGE });
  uploadSiteImage.mockResolvedValue({
    ok: true,
    value: {
      id: "file-1",
      url: "/media/file-1",
      showsIdentifiablePersons: false,
    },
  });
});

describe("a button", SLOW, () => {
  it("is saved with the page it leads to and the look the board chose", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en knapp" }),
    );
    await user.type(screen.getByLabelText("Text på knappen"), "Läs stadgarna");
    await user.selectOptions(screen.getByLabelText("Sida"), "page-2");
    await user.selectOptions(screen.getByLabelText("Utseende"), "secondary");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "button",
          label: "Läs stadgarna",
          target: { kind: "page", pageId: "page-2" },
          style: "secondary",
        },
      ]);
    });
  });

  it("leads to a page the website builds, or an address, chosen with the keyboard", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en knapp" }),
    );
    await user.type(screen.getByLabelText("Text på knappen"), "Kalendern");
    const builtIn = screen.getByRole("radio", {
      name: "En sida webbplatsen bygger själv",
    });
    builtIn.focus();
    await user.keyboard(" ");
    await user.selectOptions(screen.getByLabelText("Sida"), "calendar");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "button",
          label: "Kalendern",
          target: { kind: "builtIn", page: "calendar" },
          style: "primary",
        },
      ]);
    });
  });

  it("is named when the API refuses it for leading nowhere", async () => {
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "content.blocks.0.target.pageId" }],
      },
    });
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en knapp" }),
    );
    await user.type(screen.getByLabelText("Text på knappen"), "Läs mer");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await screen.findByText(/En knapp på sidan leder ingenstans/),
    ).toBeDefined();
    expect(screen.getByText(/block 1/)).toBeDefined();
  });
});

describe("a banner", SLOW, () => {
  it("is saved with its picture, its description, its heading and its button", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en banner" }),
    );
    await user.upload(
      screen.getByLabelText(/^Bild(?!ens)/),
      new File(["x"], "garden.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(uploadSiteImage).toHaveBeenCalled();
    });
    await user.type(
      screen.getByLabelText(/^Beskrivning av bilden/),
      "Gården i maj",
    );
    await user.type(
      screen.getByLabelText("Rubrik", { selector: "input[required]" }),
      "Välkommen",
    );
    await user.type(screen.getByLabelText("Kort text"), "Ett hus på Söder.");
    await user.click(
      screen.getByRole("button", { name: "Lägg till en knapp i bannern" }),
    );
    const banner = screen.getByRole("listitem");
    await user.type(
      within(banner).getByLabelText("Text på knappen"),
      "Kontakta styrelsen",
    );
    await user.selectOptions(within(banner).getByLabelText("Sida"), "page-2");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "banner",
          mediaFileId: "file-1",
          alt: "Gården i maj",
          heading: "Välkommen",
          text: "Ett hus på Söder.",
          button: {
            label: "Kontakta styrelsen",
            target: { kind: "page", pageId: "page-2" },
          },
        },
      ]);
    });
  });

  it("says a description is missing when the API refuses one", async () => {
    savePage.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "content.blocks.0.alt" }],
      },
    });
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en banner" }),
    );
    // Required in words, and not only by a mark on the field.
    expect(
      screen.getByText(/Den här bilden måste ha en beskrivning/),
    ).toBeDefined();
    await user.upload(
      screen.getByLabelText(/^Bild(?!ens)/),
      new File(["x"], "garden.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(uploadSiteImage).toHaveBeenCalled();
    });
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await screen.findByText(/En bild på sidan saknar beskrivning/),
    ).toBeDefined();
  });
});

describe("a picture beside text", SLOW, () => {
  it("is saved with its side and its paragraphs", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till en bild bredvid text" }),
    );
    await user.upload(
      screen.getByLabelText(/^Bild(?!ens)/),
      new File(["x"], "tvatt.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(uploadSiteImage).toHaveBeenCalled();
    });
    await user.type(
      screen.getByLabelText(/^Beskrivning av bilden/),
      "Tvättstugan",
    );
    await user.selectOptions(screen.getByLabelText(/^Bildens plats/), "right");
    // A return splits the paragraph, and the new one is written in next.
    await user.type(
      await screen.findByLabelText("Text, stycke 1"),
      "Boka på tavlan.|",
    );
    await user.type(
      await screen.findByLabelText("Text, stycke 2"),
      "Nyckeln finns hos styrelsen.",
    );
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "imageText",
          mediaFileId: "file-1",
          alt: "Tvättstugan",
          side: "right",
          paragraphs: [
            [{ text: "Boka på tavlan." }],
            [{ text: "Nyckeln finns hos styrelsen." }],
          ],
        },
      ]);
    });
  });
});

describe("columns", SLOW, () => {
  it("are built column by column, and saved without what is not finished", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till kolumner" }),
    );
    await user.selectOptions(screen.getByLabelText(/^Antal kolumner/), "3");

    const second = screen.getByRole("group", { name: "Kolumn 2" });
    await user.click(
      within(second).getByRole("button", { name: "Lägg till en rubrik" }),
    );
    await user.type(within(second).getByLabelText("Rubriktext"), "Styrelsen");

    const first = screen.getByRole("group", { name: "Kolumn 1" });
    await user.click(
      within(first).getByRole("button", { name: "Lägg till ett stycke" }),
    );
    await user.type(
      await within(first).findByLabelText("Kolumn 1, stycke 1"),
      "Vi träffas varje månad.",
    );
    // A picture nobody chose a file for is left out of what is sent.
    await user.click(
      within(first).getByRole("button", { name: "Lägg till en bild" }),
    );
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "columns",
          columns: [
            {
              blocks: [
                {
                  type: "paragraph",
                  runs: [{ text: "Vi träffas varje månad." }],
                },
              ],
            },
            {
              blocks: [
                { type: "heading", level: 2, runs: [{ text: "Styrelsen" }] },
              ],
            },
            { blocks: [] },
          ],
        },
      ]);
    });
  });

  it("keeps the focus in the column and says so when a block in it is removed", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till kolumner" }),
    );
    const first = screen.getByRole("group", { name: "Kolumn 1" });
    await user.click(
      within(first).getByRole("button", { name: "Lägg till en rubrik" }),
    );
    await user.click(
      within(first).getByRole("button", { name: "Lägg till en knapp" }),
    );
    const remove = (name: string) =>
      within(first).getByRole("button", { name });

    // The first of two: the focus goes to the one that is now first.
    remove("Ta bort, Rubrik 1 i kolumn 1").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Flytta upp, Knapp 1 i kolumn 1",
    );
    expect(
      await screen.findByText(
        "Rubrik 1 togs bort ur kolumn 1. Block kvar i kolumnen: 1.",
      ),
    ).toBeDefined();

    // The only one left: the focus goes to the column's first add button.
    remove("Ta bort, Knapp 1 i kolumn 1").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      within(first).getAllByRole("button", { name: /^Lägg till/ })[0],
    );
    expect(
      await screen.findByText(
        "Knapp 1 togs bort ur kolumn 1. Block kvar i kolumnen: 0.",
      ),
    ).toBeDefined();
  });

  it("move a block within its column from the keyboard, and say where it went", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till kolumner" }),
    );
    const first = screen.getByRole("group", { name: "Kolumn 1" });
    await user.click(
      within(first).getByRole("button", { name: "Lägg till en rubrik" }),
    );
    await user.click(
      within(first).getByRole("button", { name: "Lägg till en knapp" }),
    );

    const moveUp = within(first).getByRole("button", {
      name: "Flytta upp, Knapp 2 i kolumn 1",
    });
    moveUp.focus();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByText("Knapp är nu block 1 av 2 i kolumn 1."),
    ).toBeDefined();
    // The focus comes back to the button that moved the block.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Flytta upp, Knapp 1 i kolumn 1",
    );
    expect(
      within(first)
        .getAllByText(/i kolumn 1$/)
        .map((label) => label.textContent),
    ).toEqual(["Knapp 1 i kolumn 1", "Rubrik 2 i kolumn 1"]);
  });
});
