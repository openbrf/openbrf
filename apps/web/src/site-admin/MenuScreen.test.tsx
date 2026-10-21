import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { MenuScreen } from "./MenuScreen";
import type { MenuItem, MenuPage } from "./menu-api";

/**
 * What the menu editor lets a board arrange, and what it sends when they do.
 *
 * The screen decides nothing about who sees an entry - that follows from what
 * the entry points at, and from whether the board keeps it for members, and is
 * settled on the server. What it owes the board is a true account of why an
 * entry is not on the website yet, which is why a draft, a members-only page
 * and an entry kept for members are said out loud on the row rather than left
 * to be discovered by looking at the site.
 */

const fetchMenu = vi.fn();
const fetchMenuPages = vi.fn();
const addMenuItem = vi.fn();
const orderMenu = vi.fn();
const removeMenuItem = vi.fn();

vi.mock("./menu-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./menu-api")>()),
  fetchMenu: () => fetchMenu(),
  fetchMenuPages: () => fetchMenuPages(),
  addMenuItem: (fields: unknown) => addMenuItem(fields),
  orderMenu: (parentId: unknown, ids: unknown) => orderMenu(parentId, ids),
  removeMenuItem: (id: unknown) => removeMenuItem(id),
}));

const HOME: MenuPage = {
  id: "page-1",
  slug: "hem",
  title: "Välkommen",
  status: "PUBLIC",
  builtIn: null,
};

const MINUTES: MenuPage = {
  id: "page-2",
  slug: "protokoll",
  title: "Protokoll",
  status: "MEMBERS_ONLY",
  builtIn: null,
};

/** The news index, which every instance has as a built-in page. */
const NEWS: MenuPage = {
  id: "built-in-news",
  slug: "nyheter",
  title: "Nyheter",
  status: "PUBLIC",
  builtIn: "NEWS",
};

const HOME_ENTRY: MenuItem = {
  id: "item-1",
  label: "Hem",
  kind: "PAGE",
  parentId: null,
  sortOrder: 0,
  pageId: HOME.id,
  url: null,
  membersOnly: false,
  page: {
    slug: HOME.slug,
    title: HOME.title,
    status: "PUBLIC",
    builtIn: null,
  },
};

const BOARD_ENTRY: MenuItem = {
  id: "item-2",
  label: "Styrelsen",
  kind: "PAGE",
  parentId: null,
  sortOrder: 1,
  pageId: MINUTES.id,
  url: null,
  membersOnly: false,
  page: {
    slug: MINUTES.slug,
    title: MINUTES.title,
    status: "MEMBERS_ONLY",
    builtIn: null,
  },
};

const CHILD_ENTRY: MenuItem = {
  ...HOME_ENTRY,
  id: "item-3",
  label: "Stadgar",
  parentId: HOME_ENTRY.id,
  sortOrder: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  fetchMenu.mockResolvedValue({ ok: true, value: [HOME_ENTRY, BOARD_ENTRY] });
  fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, MINUTES] });
});

describe("the menu the board is shown", () => {
  it("lists the entries it was given", async () => {
    render(<MenuScreen />);

    expect(
      await screen.findByRole("button", { name: "Ändra Hem" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ändra Styrelsen" }),
    ).toBeTruthy();
  });

  it("says when an entry leads somewhere a visitor cannot go", async () => {
    // The board has to be able to tell why an entry is not on the website
    // without going to look at the website.
    render(<MenuScreen />);

    expect(
      await screen.findByText(/Endast medlemmar, så posten döljs/),
    ).toBeTruthy();
  });

  it("names an entry for a built-in page as one, and says when the account request form is offered", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        {
          ...HOME_ENTRY,
          id: "item-9",
          label: "Bli medlem",
          pageId: "built-in-request-account",
          page: {
            slug: "app/request-account",
            title: "Ansök om konto",
            status: "PUBLIC" as const,
            builtIn: "REQUEST_ACCOUNT" as const,
          },
        },
      ],
    });

    render(<MenuScreen />);

    expect(
      await screen.findByText("Ansök om konto, en inbyggd sida"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Visas bara medan föreningen tar emot ansökningar/),
    ).toBeTruthy();
  });

  it("says when a page is still a draft", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        {
          ...HOME_ENTRY,
          page: {
            slug: HOME.slug,
            title: HOME.title,
            status: "DRAFT" as const,
            builtIn: null,
          },
        },
      ],
    });

    render(<MenuScreen />);

    expect(
      await screen.findByText(/Utkast, så posten syns ännu inte/),
    ).toBeTruthy();
  });

  it("says when the board keeps an entry for a public page for members", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        {
          ...HOME_ENTRY,
          label: "Kalender",
          membersOnly: true,
          pageId: "built-in-calendar",
          page: {
            slug: "kalender",
            title: "Kalender",
            status: "PUBLIC" as const,
            builtIn: "CALENDAR" as const,
          },
        },
        // Said once, by the page: it already keeps the entry from the street.
        { ...BOARD_ENTRY, membersOnly: true },
      ],
    });

    render(<MenuScreen />);

    expect(
      await screen.findAllByText(
        /Bara för inloggade medlemmar, så posten döljs/,
      ),
    ).toHaveLength(1);
  });

  it("shows an empty menu as an empty menu", async () => {
    fetchMenu.mockResolvedValue({ ok: true, value: [] });

    render(<MenuScreen />);

    expect(await screen.findByText(/Menyn är ännu tom/)).toBeTruthy();
  });

  it("hangs a second level under the entry it belongs to", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [HOME_ENTRY, CHILD_ENTRY],
    });

    render(<MenuScreen />);

    const child = await screen.findByText("Stadgar");
    // Inside its parent's row, which is what the two levels mean here.
    expect(
      child.closest("li")?.parentElement?.closest("li")?.textContent,
    ).toContain("Hem");
  });
});

describe("adding an entry", () => {
  it("does not offer to save a page entry before there is a page", async () => {
    // The form says the instance has no pages yet. Offering to save one anyway
    // would answer the board with a refusal they had no way to avoid.
    fetchMenuPages.mockResolvedValue({ ok: true, value: [] });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    expect(
      screen
        .getByRole("button", { name: "Lägg till posten" })
        .hasAttribute("disabled"),
    ).toBe(true);

    // And the way out is the one the form already shows: the other two kinds
    // need no page of the association's own.
    await userEvent.click(
      screen.getByRole("radio", { name: "En adress någon annanstans" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Lägg till posten" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("sends the page and lets the label default to its title", async () => {
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith({
        kind: "PAGE",
        label: "",
        parentId: null,
        membersOnly: false,
        pageId: HOME.id,
      });
    });
  });

  it("sends an address for an entry that leaves the instance", async () => {
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("radio", { name: "En adress någon annanstans" }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Adress/),
      "https://boverket.invalid",
    );
    await userEvent.type(screen.getByLabelText(/^Vad menyn säger/), "Boverket");
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith({
        kind: "EXTERNAL",
        label: "Boverket",
        parentId: null,
        membersOnly: false,
        url: "https://boverket.invalid",
      });
    });
  });

  it("says in one sentence why the server refused", async () => {
    addMenuItem.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "invalid-url" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("radio", { name: "En adress någon annanstans" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    expect(
      await screen.findByText(/får bara leda till en https-adress/),
    ).toBeTruthy();
  });

  it("offers a built-in page among the pages, named as one, and sends it as a page", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    // No separate choice for it: the two kinds are a page and an address.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /^Sida/ }),
      screen.getByRole("option", { name: "Nyheter (inbyggd sida)" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith({
        kind: "PAGE",
        label: "",
        parentId: null,
        membersOnly: false,
        pageId: NEWS.id,
      });
    });
  });

  it("sends an entry the board keeps for signed-in members as one", async () => {
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Bara för inloggade medlemmar" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith(
        expect.objectContaining({ membersOnly: true }),
      );
    });
  });

  it("offers the entry as a child of a top-level one", async () => {
    addMenuItem.mockResolvedValue({ ok: true, value: CHILD_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.selectOptions(
      screen.getByLabelText(/^Ligger under/),
      HOME_ENTRY.id,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: HOME_ENTRY.id }),
      );
    });
  });
});

describe("rearranging the menu", () => {
  it("sends the new order for the entry's own level", async () => {
    orderMenu.mockResolvedValue({
      ok: true,
      value: [BOARD_ENTRY, HOME_ENTRY],
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen uppåt" }),
    );

    await waitFor(() => {
      expect(orderMenu).toHaveBeenCalledWith(null, [
        BOARD_ENTRY.id,
        HOME_ENTRY.id,
      ]);
    });
  });

  it("cannot move the first entry up or the last one down", async () => {
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    expect(
      screen
        .getByRole("button", { name: "Flytta Hem uppåt" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Flytta Styrelsen nedåt" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("waits for one move to be answered before calculating the next", async () => {
    /*
     * Two clicks on the same button are two moves. The server answers a move
     * with the whole menu, so the second one has to be calculated from that
     * answer - calculated from the arrangement it replaced, it would send the
     * same order again and the entry would travel one place instead of two.
     */
    const THIRD: MenuItem = {
      ...HOME_ENTRY,
      id: "item-4",
      label: "Kontakt",
      sortOrder: 2,
    };
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [HOME_ENTRY, BOARD_ENTRY, THIRD],
    });

    const answers: ((result: unknown) => void)[] = [];
    orderMenu
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answers.push(resolve);
          }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, value: [BOARD_ENTRY, THIRD, HOME_ENTRY] }),
      );

    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    const down = screen.getByRole("button", { name: "Flytta Hem nedåt" });
    await userEvent.click(down);
    await userEvent.click(down);

    // Still one request: the second move has nothing to calculate from until
    // the first is answered.
    expect(orderMenu).toHaveBeenCalledTimes(1);

    answers[0]?.({ ok: true, value: [BOARD_ENTRY, HOME_ENTRY, THIRD] });

    await waitFor(() => {
      expect(orderMenu).toHaveBeenNthCalledWith(2, null, [
        BOARD_ENTRY.id,
        THIRD.id,
        HOME_ENTRY.id,
      ]);
    });
  });

  it("removes the entry it was asked about", async () => {
    removeMenuItem.mockResolvedValue({ ok: true, value: undefined });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Styrelsen ur menyn" }),
    );

    await waitFor(() => {
      expect(removeMenuItem).toHaveBeenCalledWith(BOARD_ENTRY.id);
    });
  });
});

describe("a support session", () => {
  it("reads the menu and is offered nothing that changes it", async () => {
    render(<MenuScreen readOnly />);

    expect(await screen.findByText("Hem")).toBeTruthy();
    // The page's own sign says Styrelsen too; the entry is the one in the list.
    expect(
      screen
        .getAllByRole("listitem")
        .some((item) => item.textContent?.includes("Styrelsen")),
    ).toBe(true);
    expect(screen.queryByText("Lägg till en post")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });
});
