import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { MenuScreen } from "./MenuScreen";
import type { MenuItem, MenuPage } from "./menu-api";

/**
 * What the menu editor lets a board arrange, and what it sends when they do.
 *
 * The screen decides nothing about who sees an entry - that follows from what
 * the entry points at and is settled on the server. What it owes the board is
 * a true account of why an entry is not on the website yet, which is why a
 * draft and a members-only page are said out loud on the row rather than left
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
  published: true,
  visibility: "PUBLIC",
};

const MINUTES: MenuPage = {
  id: "page-2",
  slug: "protokoll",
  title: "Protokoll",
  published: true,
  visibility: "MEMBER",
};

const HOME_ENTRY: MenuItem = {
  id: "item-1",
  label: "Hem",
  kind: "PAGE",
  parentId: null,
  sortOrder: 0,
  pageId: HOME.id,
  generatedKey: null,
  url: null,
  page: {
    slug: HOME.slug,
    title: HOME.title,
    published: true,
    visibility: "PUBLIC",
  },
};

const BOARD_ENTRY: MenuItem = {
  id: "item-2",
  label: "Styrelsen",
  kind: "PAGE",
  parentId: null,
  sortOrder: 1,
  pageId: MINUTES.id,
  generatedKey: null,
  url: null,
  page: {
    slug: MINUTES.slug,
    title: MINUTES.title,
    published: true,
    visibility: "MEMBER",
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

  it("says when a page is still a draft", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        {
          ...HOME_ENTRY,
          page: {
            slug: HOME.slug,
            title: HOME.title,
            published: false,
            visibility: "PUBLIC" as const,
          },
        },
      ],
    });

    render(<MenuScreen />);

    expect(
      await screen.findByText(/Utkast, så posten syns ännu inte/),
    ).toBeTruthy();
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
