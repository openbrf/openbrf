import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { BinderBoardScreen } from "./BinderBoardScreen";
import type {
  BinderEntry,
  BoardBinder,
  BoardBinderEntry,
} from "./apartment-binder-api";

/**
 * The board's page for every apartment's binder.
 *
 * Opening one is a disclosure the server writes to the audit log, so what these
 * cases hold the page to is that nothing is opened until the board chooses an
 * apartment, that the two reads fail apart from each other, and that an
 * account the page is not offered to reads one sentence and asks for nothing.
 */

const fetchMyBinders = vi.fn();
const fetchBinders = vi.fn();
const fetchBinder = vi.fn();
const fileAsBoard = vi.fn();
const takeOutAsBoard = vi.fn();

vi.mock("./apartment-binder-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apartment-binder-api")>()),
  fetchMyBinders: () => fetchMyBinders(),
  fetchBinders: () => fetchBinders(),
  fetchBinder: (apartmentId: string) => fetchBinder(apartmentId),
  fileAsBoard: (apartmentId: string, fields: unknown, file: unknown) =>
    fileAsBoard(apartmentId, fields, file),
  takeOutAsBoard: (id: string) => takeOutAsBoard(id),
}));

const DRAWING: BinderEntry = {
  id: "entry-drawing",
  kind: "DRAWING",
  audience: "HOUSEHOLD",
  title: "Ritning badrum 2019",
  datedOn: "2019-05-04",
  filedAs: "BOARD",
  filedByYou: false,
  fileName: "ritning-badrum.pdf",
  contentType: "application/pdf",
  byteSize: 41_500,
  url: "/api/media/file-drawing",
  filedAt: "2026-09-01T09:00:00.000Z",
};

const PERMISSION: BinderEntry = {
  id: "entry-permission",
  kind: "ALTERATION_PERMISSION",
  audience: "TENANT_OWNERS",
  title: "Tillstand stambyte",
  datedOn: "2021-03-11",
  filedAs: "BOARD",
  filedByYou: false,
  fileName: "tillstand-stambyte.pdf",
  contentType: "application/pdf",
  byteSize: 12_000,
  url: "/api/media/file-permission",
  filedAt: "2026-09-02T09:00:00.000Z",
};

const MANUAL: BinderEntry = {
  id: "entry-manual",
  kind: "INSTRUCTIONS",
  audience: "HOUSEHOLD",
  title: "Bruksanvisning tvattmaskin",
  datedOn: null,
  filedAs: "TENANT_OWNER",
  filedByYou: true,
  fileName: "tvattmaskin.pdf",
  contentType: "application/pdf",
  byteSize: 3_000,
  url: "/api/media/file-manual",
  filedAt: "2026-09-03T09:00:00.000Z",
};

/** The binder of whoever holds the apartment. */
const BOARD_VIEW: BoardBinder = {
  apartmentId: "apartment-1201",
  apartment: "Storgatan 12 1201",
  tenantOwners: 1,
  otherResidents: 2,
  entries: [
    {
      ...(DRAWING as Omit<BinderEntry, "filedByYou">),
      filedBy: { kind: "person", personId: "person-board", name: "Bo Ekstrom" },
    } as BoardBinderEntry,
    {
      ...(MANUAL as Omit<BinderEntry, "filedByYou">),
      filedBy: { kind: "person", personId: "person-elin", name: "Elin Hammar" },
    } as BoardBinderEntry,
  ],
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
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

function renderScreen(capabilities: string[] = ["apartmentBinder:manage"]) {
  return render(<BinderBoardScreen viewer={viewerWith(capabilities)} />);
}

beforeEach(() => {
  fetchMyBinders.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchBinders.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchBinder.mockReset().mockResolvedValue({ ok: true, value: BOARD_VIEW });
  fileAsBoard.mockReset().mockResolvedValue({ ok: true, value: PERMISSION });
  takeOutAsBoard.mockReset().mockResolvedValue({ ok: true, value: undefined });
});

describe("a board seat reading every binder", () => {
  beforeEach(() => {
    fetchBinders.mockResolvedValue({
      ok: true,
      value: [
        {
          apartmentId: "apartment-1201",
          apartment: "Storgatan 12 1201",
          entries: 2,
        },
      ],
    });
  });

  it("chooses an apartment before anybody's papers are read", async () => {
    // Choosing is what discloses a household's papers and what the server
    // writes to the audit log, so nothing is chosen for them.
    renderScreen();

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelsen Alla lägenheters pärmar",
      }),
    ).toBeTruthy();
    await screen.findByRole("combobox", { name: /^Lägenhet/ });
    expect(fetchBinder).not.toHaveBeenCalled();

    const session = userEvent.setup();
    await session.selectOptions(
      screen.getByRole("combobox", { name: /^Lägenhet/ }),
      "apartment-1201",
    );

    await waitFor(() => {
      expect(fetchBinder).toHaveBeenCalledWith("apartment-1201");
    });
  });

  it("says who sees the page in the binder's own sentence, not the standard note", async () => {
    // `apartmentBinder:manage` is held with a board seat alone, so the page's
    // default line ("styrelsen och administratören") would say too much about
    // who sees it, and leave out that every reading is written to the audit log.
    renderScreen();

    expect(
      screen.getByText(/^Ett styrelseuppdrag ger tillgång till varje pärm/),
    ).toBeTruthy();
    expect(
      screen.queryByText("Det här ser bara styrelsen och administratören."),
    ).toBeNull();
    await screen.findByRole("combobox", { name: /^Lägenhet/ });
  });

  it("names who filed each entry, and how many people read the binder", async () => {
    const session = userEvent.setup();
    renderScreen();

    await screen.findByRole("combobox", { name: /^Lägenhet/ });
    await session.selectOptions(
      screen.getByRole("combobox", { name: /^Lägenhet/ }),
      "apartment-1201",
    );

    expect(await screen.findByText(/Inlagd av Bo Ekstrom/)).toBeTruthy();
    expect(screen.getByText(/Inlagd av Elin Hammar/)).toBeTruthy();
    expect(
      screen.getByText(
        "Visas i dag för 1 bostadsrättshavare och 2 övriga boende.",
      ),
    ).toBeTruthy();
  });

  it("is offered the kind the board alone files", async () => {
    const session = userEvent.setup();
    renderScreen();

    await screen.findByRole("combobox", { name: /^Lägenhet/ });
    await session.selectOptions(
      screen.getByRole("combobox", { name: /^Lägenhet/ }),
      "apartment-1201",
    );

    const panel = await screen.findByText("Lägg i den här lägenhetens pärm");
    expect(panel).toBeTruthy();
    const kind = screen.getByRole("combobox", { name: /^Vad det är/ });
    expect(
      within(kind)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toContain("Tillstånd till ändring");
  });

  it("names a filer the register no longer names, rather than leaving a gap", async () => {
    fetchBinder.mockResolvedValue({
      ok: true,
      value: {
        ...BOARD_VIEW,
        entries: [
          {
            ...(DRAWING as Omit<BinderEntry, "filedByYou">),
            filedBy: { kind: "unknown" },
          } as BoardBinderEntry,
        ],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await screen.findByRole("combobox", { name: /^Lägenhet/ });
    await session.selectOptions(
      screen.getByRole("combobox", { name: /^Lägenhet/ }),
      "apartment-1201",
    );

    expect(
      await screen.findByText(/som registret inte längre namnger/),
    ).toBeTruthy();
  });

  it("says which of the two reads failed, and not the other one", async () => {
    /*
     * The chooser and a chosen binder are two requests. A board member told
     * that a binder could not be read, when it was the association's
     * apartments that could not be listed, goes looking at one apartment for a
     * fault that is not in any of them.
     */
    fetchBinders.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    renderScreen();

    expect(
      await screen.findByText(/Föreningens lägenheter kunde inte listas/),
    ).toBeTruthy();
    expect(screen.queryByText(/Pärmen kunde inte läsas just nu/)).toBeNull();
  });

  it("puts a binder's failure down when the board goes back to choosing", async () => {
    /*
     * The notice belongs to the apartment that was chosen. Left standing over
     * a chooser with nothing chosen it reads as the screen's own fault, and
     * nothing a board member can do on the screen would clear it.
     */
    fetchBinder.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const session = userEvent.setup();
    renderScreen();

    const chooser = await screen.findByRole("combobox", { name: /^Lägenhet/ });
    await session.selectOptions(chooser, "apartment-1201");
    expect(
      await screen.findByText(/Pärmen kunde inte läsas just nu/),
    ).toBeTruthy();

    await session.selectOptions(chooser, "");
    await waitFor(() => {
      expect(screen.queryByText(/Pärmen kunde inte läsas just nu/)).toBeNull();
    });
  });

  it("keeps a binder's failure when the chooser answers after it", async () => {
    /*
     * Taking an entry out reads the chooser and the binder again. The chooser
     * answering says nothing about the binder, so a failure that the other
     * request's success wipes off the screen would leave the board reading a
     * binder as though it had arrived.
     *
     * The chooser is made to answer second, and to answer with a different
     * count, so that the option's own text is the sign that its answer has
     * landed. Which of the two answers last is the network's to decide, and a
     * case that waited only for the notice passed either way.
     */
    let listReads = 0;
    fetchBinders.mockImplementation(
      () =>
        new Promise((resolve) => {
          listReads += 1;
          const entries = listReads === 1 ? 2 : 1;
          setTimeout(() => {
            resolve({
              ok: true,
              value: [
                {
                  apartmentId: "apartment-1201",
                  apartment: "Storgatan 12 1201",
                  entries,
                },
              ],
            });
          }, 20);
        }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const session = userEvent.setup();
    renderScreen();

    const chooser = await screen.findByRole("combobox", { name: /^Lägenhet/ });
    const options = () =>
      within(chooser)
        .getAllByRole("option")
        .map((option) => option.textContent);

    await waitFor(() => {
      expect(options()).toContain("Storgatan 12 1201 - 2 handlingar");
    });
    await session.selectOptions(chooser, "apartment-1201");

    const control = await screen.findByRole("button", {
      name: "Ta ut Ritning badrum 2019 ur pärmen",
    });
    fetchBinder.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await session.click(control);

    // The new count is the chooser's answer arriving, after the binder's.
    await waitFor(() => {
      expect(options()).toContain("Storgatan 12 1201 - 1 handling");
    });

    expect(screen.getByText(/Pärmen kunde inte läsas just nu/)).toBeTruthy();
    expect(
      screen.queryByText(/Föreningens lägenheter kunde inte listas/),
    ).toBeNull();
  });
});

describe("an account the page is not offered to", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    // The administrator's grant of every capability does not carry this one.
    renderScreen(["residentDirectory:read", "addressBook:read"]);

    expect(
      await screen.findByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(fetchBinders).not.toHaveBeenCalled();
    expect(fetchBinder).not.toHaveBeenCalled();
  });
});
