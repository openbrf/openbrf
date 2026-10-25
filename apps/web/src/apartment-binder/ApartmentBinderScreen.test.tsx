import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement, ReactNode } from "react";

import "../i18n";
import { ApartmentBinderScreen } from "./ApartmentBinderScreen";
import type { Binder, BinderEntry } from "./apartment-binder-api";

/**
 * What each reader is offered, and what filing an entry actually sends.
 *
 * The screen never decides who may read what: the server answers the binders
 * this account's residencies reach and the entries its role allows, and the
 * file behind each one is decided again by the media route. What these cases
 * hold the screen to is everything else - that a household is shown no name at
 * all, that the form is offered to whoever holds the apartment and offers them
 * only the kinds they may file, that "Ta ut" appears on their own filings and
 * on nothing else, and that a refusal says which of the two fields was wrong
 * and stands where the control that caused it is.
 *
 * Every apartment's binder is the board's page (BinderBoardScreen.test.tsx),
 * so nothing here depends on a capability.
 */

const fetchMyBinders = vi.fn();
const fetchBinders = vi.fn();
const fileInMyBinder = vi.fn();
const takeOutOfMyBinder = vi.fn();

vi.mock("./apartment-binder-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./apartment-binder-api")>()),
  fetchMyBinders: () => fetchMyBinders(),
  fetchBinders: () => fetchBinders(),
  fileInMyBinder: (apartmentId: string, fields: unknown, file: unknown) =>
    fileInMyBinder(apartmentId, fields, file),
  takeOutOfMyBinder: (id: string) => takeOutOfMyBinder(id),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    className,
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a
      href={search === undefined ? to : `${to}?${new URLSearchParams(search)}`}
      className={className}
    >
      {children}
    </a>
  ),
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
const HELD: Binder = {
  apartmentId: "apartment-1201",
  apartment: "Storgatan 12 1201",
  isTenantOwner: true,
  entries: [DRAWING, PERMISSION, MANUAL],
};

/**
 * The binder of somebody who lives there without holding it.
 *
 * The permission is not in it, and that is the server's answer rather than a
 * filter this screen applies: an entry for the tenant-owners of an apartment
 * where this person is a lodger is one the database never hands over.
 */
const LIVED_IN: Binder = {
  apartmentId: "apartment-1201",
  apartment: "Storgatan 12 1201",
  isTenantOwner: false,
  entries: [DRAWING, { ...MANUAL, filedByYou: false }],
};

function renderScreen() {
  return render(<ApartmentBinderScreen />);
}

const householdForm = () =>
  screen.queryByRole("heading", { name: "Lägg i pärmen" });

/** A PDF, as the file input hands one over. */
const pdf = (name: string): File =>
  new File(["%PDF-1.7"], name, { type: "application/pdf" });

beforeEach(() => {
  fetchMyBinders.mockReset().mockResolvedValue({ ok: true, value: [HELD] });
  fetchBinders.mockReset().mockResolvedValue({ ok: true, value: [] });
  fileInMyBinder.mockReset().mockResolvedValue({ ok: true, value: MANUAL });
  takeOutOfMyBinder
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("a tenant-owner reading their own binder", () => {
  it("sees the entries the server sent, grouped by kind", async () => {
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Storgatan 12 1201" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ritning" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Tillstånd till ändring" }),
    ).toBeTruthy();

    const link = screen.getByRole("link", {
      name: "Öppna Ritning badrum 2019",
    });
    // Straight at the media route: the file's own audience is what decides
    // whether it comes back, and this screen has no other way to open one.
    expect(link.getAttribute("href")).toBe("/api/media/file-drawing");
    expect(screen.getByText("ritning-badrum.pdf, 41 kB")).toBeTruthy();
    expect(screen.getByText("Daterad 2019-05-04")).toBeTruthy();
  });

  it("is never told who filed an entry", async () => {
    /*
     * The rule a binder keeps for every household, with no exception for people
     * who live together: what a household reads says the board or a
     * tenant-owner, and never a person. It is also what protects a tenant-owner
     * with protected personal data without a branch for them.
     */
    renderScreen();

    // Two of the three entries came from the board, and each says so on its
    // own row: the sign is the whole of what a household is told about who.
    await screen.findByRole("link", { name: "Öppna Ritning badrum 2019" });
    expect(screen.getAllByText("Styrelsen")).toHaveLength(2);
    expect(screen.getByText("Du")).toBeTruthy();
    expect(screen.queryByText(/Inlagd av/)).toBeNull();
    expect(screen.queryByText("Bo Ekstrom")).toBeNull();
    expect(screen.queryByText("Elin Hammar")).toBeNull();
  });

  it("is offered the form, without the kind the board files", async () => {
    renderScreen();

    expect(await screen.findByText("Lägg i pärmen")).toBeTruthy();
    const kind = screen.getByRole("combobox", { name: /^Vad det är/ });
    const offered = within(kind)
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(offered).toContain("Ritning");
    expect(offered).not.toContain("Tillstånd till ändring");
  });

  it("is led to their own entry in the apartment register", async () => {
    renderScreen();

    const link = await screen.findByRole("link", {
      name: "Min lägenhetsförteckning",
    });
    // Asks for the own view outright, so a board member who also lives here is
    // not handed the board's register by it.
    expect(link.getAttribute("href")).toBe(
      "/board/registers/apartments?view=own",
    );
    // A 44px target, not an unpadded inline anchor in 13px text.
    expect(link.className).toContain("min-h-11");
  });

  it("is offered to take out what it filed itself, and nothing else", async () => {
    renderScreen();

    expect(
      await screen.findByRole("button", {
        name: "Ta ut Bruksanvisning tvattmaskin ur pärmen",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Ta ut Ritning badrum 2019 ur pärmen",
      }),
    ).toBeNull();
  });
});

describe("somebody who lives here without holding the apartment", () => {
  beforeEach(() => {
    fetchMyBinders.mockResolvedValue({ ok: true, value: [LIVED_IN] });
  });

  it("reads the binder and is offered no form at all", async () => {
    renderScreen();

    expect(
      await screen.findByRole("link", { name: "Öppna Ritning badrum 2019" }),
    ).toBeTruthy();
    expect(householdForm()).toBeNull();
    expect(screen.queryByText(/följer lägenheten och läses av/)).toBeNull();
  });

  it("is not led to an entry in the apartment register they do not hold", async () => {
    renderScreen();

    await screen.findByRole("link", { name: "Öppna Ritning badrum 2019" });
    expect(
      screen.queryByRole("link", { name: "Min lägenhetsförteckning" }),
    ).toBeNull();
  });

  it("is shown nothing addressed to the tenant-owners", async () => {
    // The server does not send it, and the screen shows exactly what it was
    // sent: an entry filtered in the browser would be one request away from
    // being read anyway.
    renderScreen();

    await screen.findByRole("link", { name: "Öppna Ritning badrum 2019" });
    expect(screen.queryByText("Tillstand stambyte")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Tillstånd till ändring" }),
    ).toBeNull();
  });
});

describe("an account with no apartment today", () => {
  it("is told who a binder is read by", async () => {
    fetchMyBinders.mockResolvedValue({ ok: true, value: [] });
    renderScreen();

    expect(
      await screen.findByText(
        /Registret har ingen lägenhet för det här kontot/,
      ),
    ).toBeTruthy();
  });

  it("says so rather than showing an empty binder when the read fails", async () => {
    fetchMyBinders.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    renderScreen();

    expect(
      await screen.findByText(/Pärmen kunde inte läsas just nu/),
    ).toBeTruthy();
  });
});

describe("filing an entry", () => {
  it("sends the kind, the audience and the day the form shows", async () => {
    const session = userEvent.setup();
    renderScreen();

    await screen.findByText("Lägg i pärmen");
    await session.type(
      screen.getByLabelText(/^Titel/),
      "Bruksanvisning tvattmaskin",
    );
    await session.upload(
      screen.getByLabelText("Fil", { exact: true }),
      pdf("tvattmaskin.pdf"),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in handlingen" }),
    );

    await waitFor(() => {
      expect(fileInMyBinder).toHaveBeenCalled();
    });
    expect(fileInMyBinder.mock.calls[0]?.[0]).toBe("apartment-1201");
    expect(fileInMyBinder.mock.calls[0]?.[1]).toEqual({
      kind: "DRAWING",
      audience: "HOUSEHOLD",
      title: "Bruksanvisning tvattmaskin",
      datedOn: "",
    });
  });

  it("names the file name when that is what carried a personal identity number", async () => {
    /*
     * The refusal carries the field and an offset and never the value. Which of
     * the two it was is the one part of it somebody can act on: a title is
     * retyped in the field above, and a file name is changed on their own
     * computer and the file chosen again. A screen that said only "the filing"
     * would send them to retype a title that holds nothing.
     */
    fileInMyBinder.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [{ part: "fileName", offset: 0 }],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await screen.findByText("Lägg i pärmen");
    await session.type(screen.getByLabelText(/^Titel/), "Besiktning");
    await session.upload(
      screen.getByLabelText("Fil", { exact: true }),
      pdf("19811218-9876-besiktning.pdf"),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in handlingen" }),
    );

    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toContain("innehåller ett personnummer");
    expect(refusal.textContent).toContain("Det står i filnamnet");
    expect(refusal.textContent).not.toContain("Det står i titeln");
    // Never the value the scan caught: that is exactly what must not travel
    // back into a response, a log or a screen.
    expect(refusal.textContent).not.toContain("19811218");
  });

  it("names the title when that is what carried one", async () => {
    fileInMyBinder.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [{ part: "title", offset: 12 }],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await screen.findByText("Lägg i pärmen");
    await session.type(screen.getByLabelText(/^Titel/), "Besiktning");
    await session.upload(
      screen.getByLabelText("Fil", { exact: true }),
      pdf("besiktning.pdf"),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in handlingen" }),
    );

    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toContain("Det står i titeln");
    expect(refusal.textContent).not.toContain("Det står i filnamnet");
  });

  it("puts the refusal in the panel the filing was made from", async () => {
    // Round 7's finding, kept from happening again: a refusal rendered
    // anywhere but at the control that caused it leaves somebody looking for
    // what went wrong on a screen that may be showing three binders.
    fileInMyBinder.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "binder-full" },
    });

    const session = userEvent.setup();
    renderScreen();

    await screen.findByText("Lägg i pärmen");
    await session.type(screen.getByLabelText(/^Titel/), "Ritning");
    await session.upload(
      screen.getByLabelText("Fil", { exact: true }),
      pdf("ritning.pdf"),
    );
    await session.click(
      screen.getByRole("button", { name: "Lägg in handlingen" }),
    );

    const panel = screen
      .getByRole("heading", { name: "Lägg i pärmen" })
      .closest("section");
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByRole("alert").textContent,
    ).toContain("pärm är full");
  });
});

describe("taking an entry out", () => {
  it("says so on the row whose control was pressed", async () => {
    takeOutOfMyBinder.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "not-found" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const session = userEvent.setup();
    renderScreen();

    const control = await screen.findByRole("button", {
      name: "Ta ut Bruksanvisning tvattmaskin ur pärmen",
    });
    await session.click(control);

    const row = control.closest("div.rounded-panel");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("alert").textContent).toContain(
      "Någon sådan pärm finns inte",
    );
  });
});

describe("whoever is reading, a board member included", () => {
  it("reads their household's binder and nothing of every apartment's", async () => {
    // The screen takes no capability: every apartment's binder is the board's
    // page, so a board member reads here what their neighbours do.
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Storgatan 12 1201" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /Alla lägenheters pärmar/ }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: /^Lägenhet/ })).toBeNull();
    expect(fetchBinders).not.toHaveBeenCalled();
  });
});
