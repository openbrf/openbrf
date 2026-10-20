import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { AdminPage } from "../api/site";
import { PageEditor } from "./PageEditor";

/**
 * The blocks that arrange a page, and arranging them, in the editor the way a
 * board member does it: the + to add one, the words written where they stand
 * on the page, the settings beside it, and the keyboard for all of it.
 *
 * What is under test is what pressing save sends. The website's rendering of
 * these blocks and the write path's refusals are tested in the API.
 */

const blocker = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useBlocker: (options: unknown) => {
    blocker(options);
  },
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

/** The words the editor last said where a screen reader hears them. */
function announced(): string | null | undefined {
  return document.querySelector("p.sr-only[role=status]")?.textContent;
}

/** Adds a block with a +: the one at the end of the page unless named. */
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

/** The settings beside the page. */
function settings(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inställningar" });
}

/** A paragraph's text editor is loaded on demand, which a busy machine can make slow. */
const LOADED = { timeout: 5000 };

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
  it("is saved with the words written on it, the page it leads to and its look", async () => {
    const user = renderEditor();

    await addBlock(user, "Knapp");
    // Written on the button itself, which has the focus once it is added.
    expect(document.activeElement).toBe(
      screen.getByLabelText("Text på knappen, block 1"),
    );
    await user.keyboard("Läs stadgarna");
    await user.selectOptions(
      within(settings()).getByLabelText("Sida"),
      "page-2",
    );
    await user.selectOptions(
      within(settings()).getByLabelText("Utseende"),
      "secondary",
    );
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

    await addBlock(user, "Knapp");
    await user.keyboard("Kalendern");
    const builtIn = within(settings()).getByRole("radio", {
      name: "En sida webbplatsen bygger själv",
    });
    builtIn.focus();
    await user.keyboard(" ");
    await user.selectOptions(
      within(settings()).getByLabelText("Sida"),
      "calendar",
    );
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

    await addBlock(user, "Knapp");
    await user.keyboard("Läs mer");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    const notice = await screen.findByText(
      /En knapp på sidan leder ingenstans/,
    );
    expect(notice.textContent).toMatch(/block 1/);
  });
});

describe("a banner", SLOW, () => {
  it("is saved with its picture, its description, its heading and its button", async () => {
    const user = renderEditor();

    await addBlock(user, "Banner");
    await user.upload(
      within(settings()).getByLabelText(/^Bild(?!ens)/),
      new File(["x"], "garden.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(uploadSiteImage).toHaveBeenCalled();
    });
    // The picture is shown where it stands, from this instance.
    expect(
      document.querySelector(".site-banner img")?.getAttribute("src"),
    ).toBe("/api/media/file-1");
    await user.type(
      within(settings()).getByLabelText(/^Beskrivning av bilden/),
      "Gården i maj",
    );
    await user.type(screen.getByLabelText("Rubrik, block 1"), "Välkommen");
    await user.type(
      screen.getByLabelText("Kort text, block 1"),
      "Ett hus på Söder.",
    );
    await user.click(
      within(settings()).getByRole("button", {
        name: "Lägg till en knapp i bannern",
      }),
    );
    await user.type(
      screen.getByLabelText("Text på knappen, block 1"),
      "Kontakta styrelsen",
    );
    await user.selectOptions(
      within(settings()).getByLabelText("Sida"),
      "page-2",
    );
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

    await addBlock(user, "Banner");
    // Required in words, and not only by a mark on the field.
    expect(
      within(settings()).getByText(/Den här bilden måste ha en beskrivning/),
    ).toBeDefined();
    await user.upload(
      within(settings()).getByLabelText(/^Bild(?!ens)/),
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

    await addBlock(user, "Bild bredvid text");
    await user.upload(
      within(settings()).getByLabelText(/^Bild(?!ens)/),
      new File(["x"], "tvatt.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(uploadSiteImage).toHaveBeenCalled();
    });
    await user.type(
      within(settings()).getByLabelText(/^Beskrivning av bilden/),
      "Tvättstugan",
    );
    await user.selectOptions(
      within(settings()).getByLabelText(/^Bildens plats/),
      "right",
    );
    // A return splits the paragraph, and the new one is written in next.
    await user.type(
      await screen.findByLabelText("Text, stycke 1", {}, LOADED),
      "Boka på tavlan.|",
    );
    await user.type(
      await screen.findByLabelText("Text, stycke 2", {}, LOADED),
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

    await addBlock(user, "Kolumner");
    await user.selectOptions(
      within(settings()).getByLabelText(/^Antal kolumner/),
      "3",
    );

    await addBlock(user, "Rubrik", "Lägg till i kolumn 2");
    await user.keyboard("Styrelsen");

    await addBlock(user, "Stycke", "Lägg till i kolumn 1");
    await user.type(
      await screen.findByLabelText("Kolumn 1, stycke 1", {}, LOADED),
      "Vi träffas varje månad.",
    );
    // A picture nobody chose a file for is left out of what is sent.
    await addBlock(
      user,
      "Bild",
      "Lägg till ett block efter Stycke 1 i kolumn 1",
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

  it("offer only the blocks that may sit in a column", async () => {
    const user = renderEditor();

    await addBlock(user, "Kolumner");
    await user.click(
      screen.getByRole("button", { name: "Lägg till i kolumn 1" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((name) => name !== "Avbryt")
        .sort(),
    ).toEqual(["Bild", "Knapp", "Rubrik", "Stycke"]);
  });

  it("keep the focus in the column and say so when a block in it is removed", async () => {
    const user = renderEditor();

    await addBlock(user, "Kolumner");
    await addBlock(user, "Rubrik", "Lägg till i kolumn 1");
    await addBlock(
      user,
      "Knapp",
      "Lägg till ett block efter Rubrik 1 i kolumn 1",
    );
    const remove = (name: string) => screen.getByRole("button", { name });

    // The first of two: the focus goes to the one that is now first.
    remove("Ta bort, Rubrik 1 i kolumn 1").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Flytta Knapp 1 i kolumn 1",
    );
    expect(announced()).toBe(
      "Rubrik 1 togs bort ur kolumn 1. Block kvar i kolumnen: 1. Ångra lägger tillbaka det.",
    );

    // The only one left: the focus goes to the column's +.
    remove("Ta bort, Knapp 1 i kolumn 1").focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Lägg till i kolumn 1" }),
    );
  });

  it("move a block within its column from the keyboard, and say where it went", async () => {
    const user = renderEditor();

    await addBlock(user, "Kolumner");
    await addBlock(user, "Rubrik", "Lägg till i kolumn 1");
    await addBlock(
      user,
      "Knapp",
      "Lägg till ett block efter Rubrik 1 i kolumn 1",
    );

    screen
      .getByRole("button", { name: "Flytta upp, Knapp 2 i kolumn 1" })
      .focus();
    await user.keyboard("{Enter}");

    expect(announced()).toBe("Knapp är nu block 1 av 2 i kolumn 1 i block 1.");
    // The focus comes back to the button that moved the block.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Flytta upp, Knapp 1 i kolumn 1",
    );
  });
});

describe("moving a block from its handle, with the keyboard", SLOW, () => {
  it("steps it through the page and into a column, saying each place", async () => {
    const user = renderEditor();

    await addBlock(user, "Rubrik");
    await user.keyboard("Om huset");
    await addBlock(user, "Kolumner");
    await addBlock(user, "Knapp", "Lägg till i kolumn 2");
    await user.keyboard("Boka");

    screen.getByRole("button", { name: "Flytta block 1, Rubrik" }).focus();
    await user.keyboard("{Enter}");
    expect(announced()).toMatch(/^Rubrik är lyft\./);

    // Through the gaps of each column in reading order, past the columns
    // block, and back into the first column.
    await user.keyboard("{ArrowDown}");
    expect(announced()).toBe("Rubrik är nu block 1 av 1 i kolumn 1 i block 1.");
    await user.keyboard("{ArrowDown}");
    expect(announced()).toBe("Rubrik är nu block 1 av 2 i kolumn 2 i block 1.");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(announced()).toBe("Rubrik är nu block 2 av 2.");
    // The handle keeps the focus as the block moves.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Flytta block 2, Rubrik",
    );
    await user.keyboard("{ArrowDown}");
    expect(announced()).toBe("Rubrik kan inte flyttas längre åt det hållet.");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(announced()).toBe("Rubrik är nu block 1 av 1 i kolumn 1 i block 1.");
    await user.keyboard("{Enter}");
    expect(announced()).toBe(
      "Rubrik är släppt. Rubrik är nu block 1 av 1 i kolumn 1 i block 1.",
    );

    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savedBlocks()).toEqual([
        {
          type: "columns",
          columns: [
            {
              blocks: [
                { type: "heading", level: 2, runs: [{ text: "Om huset" }] },
              ],
            },
            {
              blocks: [
                {
                  type: "button",
                  label: "Boka",
                  target: { kind: "page", pageId: "" },
                  style: "primary",
                },
              ],
            },
          ],
        },
      ]);
    });
  });

  it("puts a block back where it was on Escape", async () => {
    const user = renderEditor();

    await addBlock(user, "Rubrik");
    await addBlock(user, "Knapp");

    screen.getByRole("button", { name: "Flytta block 1, Rubrik" }).focus();
    await user.keyboard("{Enter}{ArrowDown}");
    expect(announced()).toBe("Rubrik är nu block 2 av 2.");
    await user.keyboard("{Escape}");

    expect(announced()).toBe("Flytten avbröts. Rubrik är nu block 1 av 2.");
    expect(
      screen.getByRole("button", { name: "Flytta block 1, Rubrik" }),
    ).toBeDefined();
    // Nothing moved, so the last thing to take back is still the button added.
    expect(
      screen.getByRole("button", { name: "Ångra: att Knapp lades till" }),
    ).toBeDefined();
  });

  it("keeps a block that may not sit in a column out of the columns", async () => {
    const user = renderEditor();

    await addBlock(user, "Kolumner");
    await addBlock(user, "Banner");

    screen.getByRole("button", { name: "Flytta block 2, Banner" }).focus();
    await user.keyboard("{Enter}{ArrowUp}");
    expect(announced()).toBe("Banner är nu block 1 av 2.");
    await user.keyboard("{ArrowUp}");
    expect(announced()).toBe("Banner kan inte flyttas längre åt det hållet.");
  });
});

describe("duplicating, removing and taking it back", SLOW, () => {
  it("copies a block straight after it, and Undo takes the copy out", async () => {
    const user = renderEditor();

    await addBlock(user, "Rubrik");
    await user.keyboard("Öppettider");
    await user.click(
      screen.getByRole("button", { name: "Duplicera block 1, Rubrik" }),
    );
    expect(announced()).toBe(
      "En kopia av Rubrik lades till direkt efter. Rubrik är nu block 2 av 2.",
    );
    expect(screen.getByLabelText("Rubriktext, block 2")).toHaveProperty(
      "value",
      "Öppettider",
    );

    await user.click(
      screen.getByRole("button", { name: "Ångra: att Rubrik duplicerades" }),
    );
    expect(screen.queryByLabelText("Rubriktext, block 2")).toBeNull();
    expect(announced()).toBe("Ångrat: att Rubrik duplicerades.");
  });

  it("puts a removed block back where it stood, with what it held", async () => {
    const user = renderEditor();

    await addBlock(user, "Rubrik");
    await user.keyboard("Först");
    await addBlock(user, "Rubrik");
    await user.keyboard("Sist");

    await user.click(
      screen.getByRole("button", { name: "Ta bort, block 1, Rubrik" }),
    );
    expect(screen.getByLabelText("Rubriktext, block 1")).toHaveProperty(
      "value",
      "Sist",
    );

    await user.click(
      screen.getByRole("button", { name: "Ångra: att Rubrik togs bort" }),
    );
    expect(screen.getByLabelText("Rubriktext, block 1")).toHaveProperty(
      "value",
      "Först",
    );
    expect(screen.getByLabelText("Rubriktext, block 2")).toHaveProperty(
      "value",
      "Sist",
    );
  });
});

describe("the +", SLOW, () => {
  it("files the blocks under their categories and finds one by its name", async () => {
    const user = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Lägg till ett block sist på sidan" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Lägg till ett block",
    });
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Text", "Bilder", "Layout", "Föreningen"]);

    await user.type(
      within(dialog).getByLabelText("Sök efter ett block"),
      "kol",
    );
    expect(within(dialog).getByText("1 block att välja bland.")).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Kolumner" }),
    ).toBeDefined();

    await user.clear(within(dialog).getByLabelText("Sök efter ett block"));
    await user.type(
      within(dialog).getByLabelText("Sök efter ett block"),
      "zzz",
    );
    expect(within(dialog).getByText("Inget block heter så.")).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("leaving the page", () => {
  it("is asked about while there are changes that are not saved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderEditor();

    const latest = () =>
      blocker.mock.calls.at(-1)?.[0] as {
        shouldBlockFn: () => boolean;
        enableBeforeUnload: () => boolean;
      };
    // Nothing written yet: nothing to lose, nothing asked.
    expect(latest().shouldBlockFn()).toBe(false);
    expect(latest().enableBeforeUnload()).toBe(false);

    await user.type(screen.getByLabelText("Rubrik"), " igen");
    expect(screen.getByText("Ändringar som inte är sparade")).toBeDefined();
    expect(latest().enableBeforeUnload()).toBe(true);
    // Staying is the answer to "leave anyway?", so the leaving is blocked.
    expect(latest().shouldBlockFn()).toBe(true);
    expect(confirm).toHaveBeenCalled();

    // Saved, there is nothing to lose again.
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(screen.queryByText("Ändringar som inte är sparade")).toBeNull();
    });
    expect(latest().shouldBlockFn()).toBe(false);
  });
});
