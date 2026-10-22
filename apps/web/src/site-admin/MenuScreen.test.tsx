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
const arrangeMenu = vi.fn();
const removeMenuItem = vi.fn();
const saveMenuItem = vi.fn();

vi.mock("./menu-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./menu-api")>()),
  fetchMenu: () => fetchMenu(),
  fetchMenuPages: () => fetchMenuPages(),
  addMenuItem: (fields: unknown) => addMenuItem(fields),
  arrangeMenu: (items: unknown) => arrangeMenu(items),
  removeMenuItem: (id: unknown) => removeMenuItem(id),
  saveMenuItem: (id: unknown, fields: unknown) => saveMenuItem(id, fields),
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

/** The entry the server makes when the news index is added to the menu. */
const NEWS_ENTRY: MenuItem = {
  id: "item-5",
  label: NEWS.title,
  kind: "PAGE",
  parentId: null,
  sortOrder: 2,
  pageId: NEWS.id,
  url: null,
  membersOnly: false,
  page: {
    slug: NEWS.slug,
    title: NEWS.title,
    status: "PUBLIC",
    builtIn: "NEWS",
  },
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

describe("adding a page", () => {
  it("offers the pages the menu does not have yet, the built-in ones named as such", async () => {
    fetchMenu.mockResolvedValue({ ok: true, value: [HOME_ENTRY] });
    fetchMenuPages.mockResolvedValue({
      ok: true,
      value: [HOME, MINUTES, NEWS],
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    // Välkommen has an entry already; the other two are offered.
    expect(
      screen.queryByRole("button", { name: "Lägg till Välkommen i menyn" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Lägg till Protokoll i menyn" }),
    ).toBeTruthy();
    expect(screen.getByText("Nyheter (inbyggd sida)")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    ).toBeTruthy();
  });

  it("sends the page and lets the label default to its title", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith({
        kind: "PAGE",
        label: "",
        pageId: NEWS.id,
      });
    });
    expect(await screen.findByText("Nyheter ligger i menyn.")).toBeTruthy();
  });

  it("stops offering the page as soon as it is added, before the menu is read again", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem.mockResolvedValue({ ok: true, value: NEWS_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });
    // The read that follows the addition is slow to come back.
    fetchMenu.mockReturnValue(new Promise(() => undefined));

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );

    expect(
      await screen.findByRole("button", { name: "Ändra Nyheter" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Lägg till Nyheter i menyn" }),
    ).toBeNull();
    expect(addMenuItem).toHaveBeenCalledTimes(1);
  });

  it("stops offering pages once the menu could not be read again", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem.mockResolvedValue({ ok: true, value: NEWS_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });
    // The read that follows the addition fails, and the list keeps what it had.
    fetchMenu.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );

    expect(
      await screen.findByText(
        "Menyn kunde inte läsas just nu. Ladda om sidan.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ändra Hem" })).toBeTruthy();
    expect(screen.queryByText("Lägg till en sida")).toBeNull();
  });

  it("offers no link to add while the menu has not been read", async () => {
    fetchMenu.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unknown" },
    });
    render(<MenuScreen />);

    expect(
      await screen.findByText(
        "Menyn kunde inte läsas just nu. Ladda om sidan.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Lägg till en länk")).toBeNull();
    expect(screen.queryByText("Lägg till en sida")).toBeNull();
  });

  it("adds a page pressed while a move is being written once the move is answered, and keeps it", async () => {
    /*
     * The addition waits its turn behind the move, so the server hears the
     * two in the order the board made them. The move's answer is the menu
     * without the new entry, and it is not the last word: the entry is put on
     * the screen once it is added, and the menu is read again after that.
     */
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    let answer: (result: unknown) => void = () => undefined;
    arrangeMenu.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    addMenuItem.mockResolvedValue({ ok: true, value: NEWS_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen uppåt" }),
    );
    fetchMenu.mockClear();
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        { ...BOARD_ENTRY, sortOrder: 0 },
        { ...HOME_ENTRY, sortOrder: 1 },
        NEWS_ENTRY,
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );
    // Not sent, nor the menu read, while the move is still being written.
    expect(addMenuItem).not.toHaveBeenCalled();
    expect(fetchMenu).not.toHaveBeenCalled();

    answer({
      ok: true,
      value: [
        { ...BOARD_ENTRY, sortOrder: 0 },
        { ...HOME_ENTRY, sortOrder: 1 },
      ],
    });

    await screen.findByText("Nyheter ligger i menyn.");
    expect(addMenuItem).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(fetchMenu).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /^Ändra / })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Ändra Styrelsen", "Ändra Hem", "Ändra Nyheter"]);
    });
    expect(
      screen.queryByRole("button", { name: "Lägg till Nyheter i menyn" }),
    ).toBeNull();
  });

  it("says so when every page is already in the menu", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME] });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    expect(screen.getByText("Alla sidor ligger redan i menyn.")).toBeTruthy();
  });

  it("says in one sentence why the server refused", async () => {
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "page-not-found" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );

    expect(await screen.findByText("Sidan finns inte längre.")).toBeTruthy();
  });

  it("takes the success notice down when the next page is refused", async () => {
    const CONTACT: MenuPage = {
      ...HOME,
      id: "page-3",
      slug: "kontakt",
      title: "Kontakt",
    };
    fetchMenuPages.mockResolvedValue({
      ok: true,
      value: [HOME, NEWS, CONTACT],
    });
    addMenuItem.mockResolvedValueOnce({ ok: true, value: NEWS_ENTRY });
    addMenuItem.mockResolvedValueOnce({
      ok: false,
      failure: { status: 404, reason: "page-not-found" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );
    expect(await screen.findByText("Nyheter ligger i menyn.")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Kontakt i menyn" }),
    );

    expect(await screen.findByText("Sidan finns inte längre.")).toBeTruthy();
    expect(screen.queryByText("Nyheter ligger i menyn.")).toBeNull();
  });
});

describe("adding a link", () => {
  it("sends an address for an entry that leaves the instance", async () => {
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    // The kind is not asked: this form only adds links.
    expect(screen.queryAllByRole("radio")).toEqual([]);
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
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    expect(
      await screen.findByText(/får bara leda till en https-adress/),
    ).toBeTruthy();
  });

  it("takes the success notice down when the next link is refused", async () => {
    addMenuItem.mockResolvedValueOnce({ ok: true, value: HOME_ENTRY });
    addMenuItem.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, reason: "invalid-url" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.type(
      screen.getByLabelText(/^Adress/),
      "https://example.org/ok",
    );
    await userEvent.type(screen.getByLabelText(/^Vad menyn säger/), "Ok länk");
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );
    expect(await screen.findByText("Posten ligger i menyn.")).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText(/^Adress/),
      "http://insecure.example/",
    );
    await userEvent.type(screen.getByLabelText(/^Vad menyn säger/), "Osäker");
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    expect(
      await screen.findByText(/får bara leda till en https-adress/),
    ).toBeTruthy();
    expect(screen.queryByText("Posten ligger i menyn.")).toBeNull();
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

  it("keeps a link half typed while a page is added, and empties the form once the link is", async () => {
    const LINK_ENTRY: MenuItem = {
      ...HOME_ENTRY,
      id: "item-6",
      label: "Boverket",
      kind: "EXTERNAL",
      sortOrder: 3,
      pageId: null,
      url: "https://boverket.invalid",
      page: null,
    };
    fetchMenuPages.mockResolvedValue({ ok: true, value: [HOME, NEWS] });
    addMenuItem
      .mockResolvedValueOnce({ ok: true, value: NEWS_ENTRY })
      .mockResolvedValueOnce({ ok: true, value: LINK_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    const address = screen.getByLabelText<HTMLInputElement>(/^Adress/);
    const label = screen.getByLabelText<HTMLInputElement>(/^Vad menyn säger/);
    await userEvent.type(address, "https://boverket.invalid");
    await userEvent.type(label, "Boverket");

    // A page added from the list, and the menu read again after it.
    fetchMenu.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till Nyheter i menyn" }),
    );
    await screen.findByText("Nyheter ligger i menyn.");
    await waitFor(() => {
      expect(fetchMenu).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByLabelText<HTMLInputElement>(/^Adress/).value).toBe(
      "https://boverket.invalid",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>(/^Vad menyn säger/).value,
    ).toBe("Boverket");

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await screen.findByText("Posten ligger i menyn.");
    expect(addMenuItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "EXTERNAL", label: "Boverket" }),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/^Adress/).value).toBe("");
    expect(
      screen.getByLabelText<HTMLInputElement>(/^Vad menyn säger/).value,
    ).toBe("");
  });

  it("offers the link as a child of a top-level entry", async () => {
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

describe("a link's parent that leaves the menu", () => {
  it("sends the top level once the entry chosen as parent is removed", async () => {
    removeMenuItem.mockResolvedValue({ ok: true, value: undefined });
    addMenuItem.mockResolvedValue({ ok: true, value: HOME_ENTRY });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    const parent = screen.getByLabelText(/^Ligger under/);
    await userEvent.selectOptions(parent, BOARD_ENTRY.id);
    fetchMenu.mockResolvedValue({ ok: true, value: [HOME_ENTRY] });
    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Styrelsen ur menyn" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Ändra Styrelsen" }),
      ).toBeNull();
    });
    expect((parent as HTMLSelectElement).value).toBe("");

    await userEvent.click(
      screen.getByRole("button", { name: "Lägg till posten" }),
    );

    await waitFor(() => {
      expect(addMenuItem).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: null }),
      );
    });
  });
});

describe("rearranging the menu from the buttons", () => {
  it("sends the whole new arrangement, and says where the entry went", async () => {
    arrangeMenu.mockResolvedValue({
      ok: true,
      value: [
        { ...BOARD_ENTRY, sortOrder: 0 },
        { ...HOME_ENTRY, sortOrder: 1 },
      ],
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen uppåt" }),
    );

    await waitFor(() => {
      expect(arrangeMenu).toHaveBeenCalledWith([
        { id: BOARD_ENTRY.id, parentId: null },
        { id: HOME_ENTRY.id, parentId: null },
      ]);
    });
    expect(
      await screen.findByText("Styrelsen ligger på toppnivån, nummer 1 av 2."),
    ).toBeTruthy();
  });

  it("makes an entry a dropdown item under the one above, and back", async () => {
    // The server answers with the arrangement it was given.
    arrangeMenu.mockImplementation(
      (items: { id: string; parentId: string | null }[]) =>
        Promise.resolve({
          ok: true,
          value: items.map((placement, order) => ({
            ...(placement.id === HOME_ENTRY.id ? HOME_ENTRY : BOARD_ENTRY),
            parentId: placement.parentId,
            sortOrder: order,
          })),
        }),
    );
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", {
        name: "Gör Styrelsen till en undermenypost under posten ovanför",
      }),
    );

    await waitFor(() => {
      expect(arrangeMenu).toHaveBeenLastCalledWith([
        { id: HOME_ENTRY.id, parentId: null },
        { id: BOARD_ENTRY.id, parentId: HOME_ENTRY.id },
      ]);
    });
    expect(
      await screen.findByText(
        "Styrelsen är en undermenypost under Hem, nummer 1 av 1.",
      ),
    ).toBeTruthy();

    // The same row, drawn in the dropdown now, with the way back out - and
    // the focus is on it, so the keyboard can go on.
    const out = await screen.findByRole("button", {
      name: "Flytta Styrelsen ut ur undermenyn, till toppnivån",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(out);
    });
  });

  it("gives the drag handle and every arrow the 44px touch target both ways", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [HOME_ENTRY, CHILD_ENTRY, BOARD_ENTRY],
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    const targets = [
      ...screen.getAllByRole("button", {
        name: /^Flytta .* (uppåt|nedåt)$|^Gör .* undermenypost|ut ur undermenyn/,
      }),
      ...screen.getAllByTitle(/^Dra för att flytta /),
    ];
    // Up and down on three rows, indent on two, outdent on one, three handles.
    expect(targets).toHaveLength(12);
    for (const target of targets) {
      expect(target.className).toContain("min-h-11");
      expect(target.className).toContain("min-w-11");
    }
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

  it("cannot put the first entry, or one with a dropdown, inside another", async () => {
    fetchMenu.mockResolvedValue({
      ok: true,
      value: [
        HOME_ENTRY,
        BOARD_ENTRY,
        { ...CHILD_ENTRY, parentId: BOARD_ENTRY.id },
      ],
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    for (const label of ["Hem", "Styrelsen"]) {
      expect(
        screen
          .getByRole("button", {
            name: `Gör ${label} till en undermenypost under posten ovanför`,
          })
          .hasAttribute("disabled"),
      ).toBe(true);
    }
  });

  it("writes one move after the other, each from the arrangement before it", async () => {
    /*
     * Two clicks on the same button are two moves. Each is applied on the
     * screen at once, so the second is calculated from the first's result and
     * the entry travels two places; the writes themselves go one at a time, so
     * the server hears them in the order they were made.
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
    arrangeMenu
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

    // Still one request: the second is written once the first is answered.
    expect(arrangeMenu).toHaveBeenCalledTimes(1);

    answers[0]?.({ ok: true, value: [BOARD_ENTRY, HOME_ENTRY, THIRD] });

    await waitFor(() => {
      expect(arrangeMenu).toHaveBeenNthCalledWith(2, [
        { id: BOARD_ENTRY.id, parentId: null },
        { id: THIRD.id, parentId: null },
        { id: HOME_ENTRY.id, parentId: null },
      ]);
    });
  });

  it("does not let an earlier answer put back an arrangement a later move replaced", async () => {
    const answers: ((result: unknown) => void)[] = [];
    arrangeMenu.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );

    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen uppåt" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen nedåt" }),
    );

    // The first answer is the order the second move has already undone.
    answers[0]?.({ ok: true, value: [BOARD_ENTRY, HOME_ENTRY] });
    await waitFor(() => {
      expect(arrangeMenu).toHaveBeenCalledTimes(2);
    });

    const rows = screen
      .getAllByRole("button", { name: /^Ändra / })
      .map((button) => button.getAttribute("aria-label"));
    expect(rows).toEqual(["Ändra Hem", "Ändra Styrelsen"]);
  });

  it("reads the menu again and says so when it has changed meanwhile", async () => {
    arrangeMenu.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "menu-changed" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });
    fetchMenu.mockClear();

    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Styrelsen uppåt" }),
    );

    expect(
      await screen.findByText(/Menyn har ändrats sedan den lästes här/),
    ).toBeTruthy();
    await waitFor(() => {
      expect(fetchMenu).toHaveBeenCalled();
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

  it("says why a removal was refused and reads the menu again", async () => {
    removeMenuItem.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });
    fetchMenu.mockClear();

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Styrelsen ur menyn" }),
    );

    expect(
      await screen.findByText("Posten finns inte längre i menyn."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(fetchMenu).toHaveBeenCalled();
    });
  });

  it("takes the removal notice down when the next removal is refused", async () => {
    removeMenuItem.mockResolvedValueOnce({ ok: true, value: undefined });
    removeMenuItem.mockResolvedValueOnce({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Styrelsen ur menyn" }),
    );
    expect(await screen.findByText("Posten är borta ur menyn.")).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("button", { name: "Ta bort Hem ur menyn" }),
    );

    expect(
      await screen.findByText("Posten finns inte längre i menyn."),
    ).toBeTruthy();
    expect(screen.queryByText("Posten är borta ur menyn.")).toBeNull();
  });

  it("queues one removal for an entry pressed twice while it waits its turn", async () => {
    let removed: (result: unknown) => void = () => undefined;
    removeMenuItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          removed = resolve;
        }),
    );
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    const button = screen.getByRole("button", {
      name: "Ta bort Styrelsen ur menyn",
    });
    await userEvent.click(button);
    await userEvent.click(button);
    removed({ ok: true, value: undefined });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Ändra Styrelsen" }),
      ).toBeNull();
    });
    expect(removeMenuItem).toHaveBeenCalledTimes(1);
  });

  it("sends a move made while an entry is being removed without that entry", async () => {
    /*
     * The move waits its turn behind the removal, and is sent as the screen
     * stands then: an arrangement naming the entry just removed would be
     * refused as a menu that has changed, and the move lost with it.
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
    let removed: (result: unknown) => void = () => undefined;
    removeMenuItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          removed = resolve;
        }),
    );
    arrangeMenu.mockImplementation(() => new Promise(() => undefined));
    render(<MenuScreen />);
    await screen.findByRole("button", { name: "Ändra Hem" });

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Styrelsen ur menyn" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Flytta Kontakt uppåt" }),
    );
    expect(arrangeMenu).not.toHaveBeenCalled();

    removed({ ok: true, value: undefined });

    await waitFor(() => {
      expect(arrangeMenu).toHaveBeenCalledWith([
        { id: HOME_ENTRY.id, parentId: null },
        { id: THIRD.id, parentId: null },
      ]);
    });
    expect(
      screen.queryByRole("button", { name: "Ändra Styrelsen" }),
    ).toBeNull();
  });
});

describe("editing an entry", () => {
  it("takes the success notice down when the next edit is refused", async () => {
    saveMenuItem.mockResolvedValueOnce({ ok: true, value: HOME_ENTRY });
    saveMenuItem.mockResolvedValueOnce({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    render(<MenuScreen />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Ändra Hem" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Spara ändringarna" }),
    );
    expect(await screen.findByText("Ändringarna är sparade.")).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("button", { name: "Ändra Styrelsen" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Spara ändringarna" }),
    );

    expect(
      await screen.findByText("Posten finns inte längre i menyn."),
    ).toBeTruthy();
    expect(screen.queryByText("Ändringarna är sparade.")).toBeNull();
  });
});

describe("a support session", () => {
  it("reads the menu and is offered nothing that changes it", async () => {
    render(<MenuScreen readOnly />);

    expect(await screen.findByText("Hem")).toBeTruthy();
    expect(screen.getByText("Styrelsen")).toBeTruthy();
    expect(screen.queryByText("Lägg till en sida")).toBeNull();
    expect(screen.queryByText("Lägg till en länk")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });
});
