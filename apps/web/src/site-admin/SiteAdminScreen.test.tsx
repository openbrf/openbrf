import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { AdminPage } from "../api/site";
import { SiteAdminScreen } from "./SiteAdminScreen";

/**
 * What the board is shown and what pressing a button actually sends.
 *
 * The guardrails live on the server and are tested there. What is tested here
 * is the half the interface owns: that the capability decides whether the
 * screen has anything to offer, that a page is created unpublished, that the
 * warning about special-category free text stands on the editor whether or not
 * anything is wrong, and that the browser warns about a personal identity
 * number before the server has to refuse one.
 */

const fetchPages = vi.fn();
const createPage = vi.fn();
const publishPage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  createPage: (page: unknown) => createPage(page),
  publishPage: (id: string, input: unknown) => publishPage(id, input),
}));

/**
 * The text editor is replaced by a plain field.
 *
 * The mapping between the editor's document and the stored runs has its own
 * tests; what this file is about is the screen around it, and loading a whole
 * editing engine to assert a warning sentence would test the engine instead.
 */
vi.mock("./RichText", () => ({
  default: ({
    runs,
    onChange,
    label,
  }: {
    runs: { text: string }[];
    onChange: (paragraphs: { text: string }[][]) => void;
    label: string;
  }) => (
    <input
      aria-label={label}
      value={runs.map((run) => run.text).join("")}
      onChange={(event) => {
        onChange([[{ text: event.target.value }]]);
      }}
    />
  ),
}));

const HOME: AdminPage = {
  id: "page-1",
  slug: "hem",
  title: "Valkommen",
  content: {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
  },
  visibility: "PUBLIC",
  published: true,
  publishedAt: "2026-08-29T09:00:00.000Z",
  sortOrder: 0,
  updatedAt: "2026-08-29T09:00:00.000Z",
};

const DRAFT: AdminPage = {
  ...HOME,
  id: "page-2",
  slug: "styrelsen",
  title: "Styrelsen",
  visibility: "MEMBER",
  published: false,
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
  publishPage.mockResolvedValue({
    ok: true,
    value: { ...DRAFT, published: true },
  });
});

describe("who the screen is for", () => {
  it("offers nothing to an account that may not write the website", async () => {
    renderScreen([]);

    expect(await screen.findByText(/styrelsens/i)).toBeDefined();
    expect(fetchPages).not.toHaveBeenCalled();
  });
});

describe("the list of pages", () => {
  it("shows drafts beside published pages, in words", async () => {
    renderScreen();

    expect(await screen.findByText("Valkommen")).toBeDefined();
    expect(screen.getByText("Styrelsen")).toBeDefined();
    // Never colour alone: the state is written out for every page.
    expect(screen.getByText("Publicerad")).toBeDefined();
    expect(screen.getByText("Utkast")).toBeDefined();
    // The same words name the choice in the new-page panel, so this asks that
    // the page carries them rather than that they appear exactly once.
    expect(screen.getAllByText("Endast medlemmar").length).toBeGreaterThan(0);
  });
});

describe("writing a new page", () => {
  it("sends an empty body and the chosen visibility", async () => {
    const user = userEvent.setup();
    renderScreen();

    await screen.findByText("Valkommen");
    await user.type(screen.getByLabelText("Rubrik"), "Om foreningen");
    // The address field carries its hint inside the label, so the accessible
    // name is the label and the hint together.
    await user.type(screen.getByLabelText(/^Adress/), "om-foreningen");
    await user.click(screen.getByRole("button", { name: "Skapa sidan" }));

    await waitFor(() => {
      expect(createPage).toHaveBeenCalledWith({
        slug: "om-foreningen",
        title: "Om foreningen",
        content: { blocks: [] },
        visibility: "PUBLIC",
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

  it("publishes the page the board is looking at", async () => {
    const user = await openEditor();

    await user.click(
      await screen.findByRole("button", { name: "Avpublicera" }),
    );

    await waitFor(() => {
      expect(publishPage).toHaveBeenCalledWith("page-1", { published: false });
    });
  });
});
