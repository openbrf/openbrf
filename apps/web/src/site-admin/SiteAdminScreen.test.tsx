import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
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
const publishPage = vi.fn();
const savePage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  createPage: (page: unknown) => createPage(page),
  publishPage: (id: string, input: unknown) => publishPage(id, input),
  savePage: (id: string, edit: unknown) => savePage(id, edit),
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
  revision: 2,
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
  savePage.mockResolvedValue({ ok: true, value: DRAFT });
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

  it("publishes the page the board is looking at", async () => {
    const user = await openEditor();

    await user.click(
      await screen.findByRole("button", { name: "Avpublicera" }),
    );

    await waitFor(() => {
      expect(publishPage).toHaveBeenCalledWith("page-1", { published: false });
    });
    // Taking a page down does not commit whatever edits were half-finished
    // beside it.
    expect(savePage).not.toHaveBeenCalled();
  });

  it("saves what is on the screen before publishing it", async () => {
    /*
     * The body lives in this screen until it is saved. Publishing without
     * saving first would put the previously stored version on the website -
     * for a page written and not yet saved, a blank one.
     */
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);

    const paragraph = await screen.findByLabelText("Stycke 1");
    await user.clear(paragraph);
    await user.type(paragraph, "Trapphuset stadas varje tisdag.");

    await user.click(screen.getByRole("button", { name: "Publicera" }));

    await waitFor(() => {
      expect(savePage).toHaveBeenCalledWith("page-2", {
        slug: "styrelsen",
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
    });
    expect(publishPage).toHaveBeenCalledWith("page-2", { published: true });
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
    publishPage.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Valkommen");
    const [, second] = screen.getAllByRole("button", { name: "Redigera" });
    await user.click(second as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Publicera" }));

    // Refused, and said as the refusal it is.
    expect(await screen.findByText(/personnummer/i)).toBeTruthy();

    // The next save carries what the first one produced, not what it spent.
    publishPage.mockResolvedValue({ ok: true, value: DRAFT });
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => {
      expect(savePage).toHaveBeenLastCalledWith(
        "page-2",
        expect.objectContaining({ expectedRevision: 3 }),
      );
    });
  });
});
