import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { AdminPage } from "../api/site";
import { asSupportSession } from "../support/support-fixtures";
import { SiteAdminScreen } from "./SiteAdminScreen";

/**
 * The website's pages, from the board's side: who is offered them, what the
 * list says about each, and that a new page is written by its title alone and
 * opened in the editor. The editor has its own tests, in
 * PageEditorScreen.test.tsx.
 */

/**
 * The router's Link needs a router context these tests have no use for, so it
 * is replaced with an anchor. What is under test here is the screen, not
 * routing.
 */
const navigate = vi.fn();

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
  useBlocker: () => undefined,
}));

const fetchPages = vi.fn();
const createPage = vi.fn();

vi.mock("../api/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/site")>()),
  fetchPages: () => fetchPages(),
  createPage: (page: unknown) => createPage(page),
}));

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

function renderScreen(capabilities: string[] = ["site:manage"]) {
  return render(<SiteAdminScreen viewer={viewerWith(capabilities)} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchPages.mockResolvedValue({ ok: true, value: [HOME, DRAFT] });
  createPage.mockResolvedValue({ ok: true, value: DRAFT });
});

describe("who the screen is for", () => {
  it("offers nothing to an account that may not write the website", async () => {
    renderScreen([]);

    expect(
      await screen.findByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it("offers the way to the menu, and only to whoever may arrange it", async () => {
    // The menu is a screen of its own, so this link is the way to it from the
    // pages: without it, a board would have to know the address.
    const offered = renderScreen();
    expect(
      await screen.findByRole("link", { name: "Ordna menyn" }),
    ).toHaveProperty("href", expect.stringContaining("/board/site/menu"));

    offered.unmount();
    renderScreen([]);
    expect(screen.queryByRole("link", { name: "Ordna menyn" })).toBeNull();
  });
});

describe("the list of pages", () => {
  it("shows drafts beside published pages, in words", async () => {
    renderScreen();

    expect(await screen.findByText("Valkommen")).toBeDefined();
    // In the list rather than anywhere: the page's own sign reads Styrelsen
    // too, in the heading.
    const list = screen.getByText("Valkommen").closest("ul") as HTMLElement;
    expect(within(list).getByText("Styrelsen")).toBeDefined();
    // Never colour alone: the status is written out for every page, and so
    // is which one is the front page.
    expect(screen.getByText("Öppen")).toBeDefined();
    expect(screen.getByText("Utkast")).toBeDefined();
    expect(screen.getByText("Startsida")).toBeDefined();
  });

  it("lists the built-in pages beside the association's own, marked as built in", async () => {
    fetchPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    renderScreen();

    expect(await screen.findByText("Nyheter")).toBeDefined();
    expect(screen.getByText("/nyheter")).toBeDefined();
    expect(screen.getByText("Inbyggd")).toBeDefined();
  });

  it("leads to each page's own editor, named for the page", async () => {
    renderScreen();

    expect(
      await screen.findByRole("link", { name: "Redigera Styrelsen" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/board/site/pages/page-2"),
    );
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
    // And the page it made is opened in the editor, to be written.
    expect(navigate).toHaveBeenCalledWith({
      to: "/board/site/pages/$pageId",
      params: { pageId: "page-2" },
    });
  });
});

describe("a support session", () => {
  it("reads every page with its state and is offered nothing that changes one", async () => {
    render(
      <SiteAdminScreen
        viewer={asSupportSession(viewerWith(["site:manage"]))}
      />,
    );

    expect(await screen.findByText("Valkommen")).toBeDefined();
    expect(screen.getByText("Utkast")).toBeDefined();
    // Reading the menu is still offered; it is a way to another screen.
    expect(screen.getByRole("link", { name: "Ordna menyn" })).toBeDefined();
    expect(screen.queryByRole("link", { name: /^Redigera/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ny sida" })).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
