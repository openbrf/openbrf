import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { AssociationFactsPanel } from "./AssociationFactsPanel";
import type { AssociationFacts } from "./site-facts-api";

/**
 * The board's form for the facts a broker asks about.
 *
 * What matters here is the three-way answer. A fact the board has not recorded
 * is left off the public page altogether, and the form has to be able to say
 * that - so an unticked box is not good enough, and a field cleared back to
 * nothing has to travel to the server as a clearing rather than as no change at
 * all. The other half is the warning: everything typed here is published at an
 * address anybody can open, and the board is told so before it types rather
 * than refused afterwards.
 *
 * And the date the broker page prints: when the board last stood behind these
 * answers. A save moves it, and so does confirming them unchanged - which is
 * offered only over facts that exist and only while nothing is left unsaved.
 *
 * And how many months those answers count as current: the board's own setting,
 * saved on its own, because saving the facts confirms them and this must not.
 */

const fetchAssociationFacts = vi.fn();
const saveAssociationFacts = vi.fn();
const confirmAssociationFacts = vi.fn();
const saveStaleAfterMonths = vi.fn();

vi.mock("./site-facts-api", () => ({
  fetchAssociationFacts: () => fetchAssociationFacts(),
  saveAssociationFacts: (input: unknown) => saveAssociationFacts(input),
  confirmAssociationFacts: () => confirmAssociationFacts(),
  saveStaleAfterMonths: (months: unknown) => saveStaleAfterMonths(months),
}));

const NOTHING_RECORDED: AssociationFacts = {
  propertyDesignation: null,
  buildYear: null,
  siteLeasehold: null,
  siteLeaseholdNote: null,
  feePolicy: null,
  feeIncludes: null,
  transferFeePolicy: null,
  pledgeFeePolicy: null,
  legalPersonOwners: null,
  legalPersonOwnersNote: null,
  parking: null,
  storage: null,
  renovations: null,
  updatedAt: null,
  confirmedAt: null,
  staleAfterMonths: 3,
};

function recorded(overrides: Partial<AssociationFacts>): AssociationFacts {
  return { ...NOTHING_RECORDED, ...overrides };
}

const save = () => screen.getByRole("button", { name: "Spara" });

beforeEach(() => {
  fetchAssociationFacts.mockReset();
  saveAssociationFacts.mockReset();
  confirmAssociationFacts.mockReset();
  saveStaleAfterMonths.mockReset();
  fetchAssociationFacts.mockResolvedValue({
    ok: true,
    value: NOTHING_RECORDED,
  });
  saveAssociationFacts.mockResolvedValue({
    ok: true,
    value: NOTHING_RECORDED,
  });
});

describe("what the board is told before it types", () => {
  it("says the page is public and names what may not go on it", async () => {
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(fetchAssociationFacts).toHaveBeenCalled();
    });
    expect(screen.getByText(/Sidan är offentlig/)).toBeTruthy();
    expect(screen.getByText(/inget personnummer/)).toBeTruthy();
  });

  it("says what an unanswered question does to the page", async () => {
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(
        screen.getByText(/utelämnas helt från den offentliga sidan/),
      ).toBeTruthy();
    });
  });
});

describe("the three-way answer", () => {
  it("starts at not recorded, and is not a yes or a no", async () => {
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(fetchAssociationFacts).toHaveBeenCalled();
    });

    expect(screen.getByLabelText(/^Marken/)).toHaveProperty("value", "");
    // Both yes-or-no facts offer the third answer, which is the one a checkbox
    // could not express.
    expect(
      screen.getAllByRole("option", { name: "Inte angivet" }),
    ).toHaveLength(2);
  });

  it("sends a no as a no rather than as nothing", async () => {
    // "The association owns the land" is an answer a broker acts on. Collapsing
    // it into "not recorded" would take it off the page.
    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(save()).toHaveProperty("disabled", false);
    });
    await session.selectOptions(
      screen.getByLabelText(/^Marken/),
      "Föreningen äger den",
    );
    await session.click(save());

    await waitFor(() => {
      expect(saveAssociationFacts).toHaveBeenCalled();
    });
    // The other flag was not touched, so it is not sent at all.
    expect(saveAssociationFacts.mock.calls[0]?.[0]).toEqual({
      siteLeasehold: false,
    });
  });

  it("sends a field the board emptied, so the fact comes off the page", async () => {
    fetchAssociationFacts.mockResolvedValue({
      ok: true,
      value: recorded({ parking: "Tolv platser i garaget." }),
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    const parking = await screen.findByDisplayValue("Tolv platser i garaget.");
    await session.clear(parking);
    await session.click(save());

    await waitFor(() => {
      expect(saveAssociationFacts).toHaveBeenCalled();
    });
    expect(saveAssociationFacts.mock.calls[0]?.[0]).toMatchObject({
      parking: "",
    });
  });
});

describe("what the board is told afterwards", () => {
  it("names the field rule when the server refuses a personal identity number", async () => {
    saveAssociationFacts.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: { locations: [{ field: "renovations", offset: 12 }] },
      },
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(save()).toHaveProperty("disabled", false);
    });
    await session.click(save());

    await waitFor(() => {
      expect(screen.getByText(/innehåller ett personnummer/)).toBeTruthy();
    });
  });

  it("refuses a year that is not one, without asking the server", async () => {
    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(save()).toHaveProperty("disabled", false);
    });
    await session.type(screen.getByLabelText(/^Byggår/), "48");
    await session.click(save());

    expect(screen.getByText(/fyra siffror/)).toBeTruthy();
    expect(saveAssociationFacts).not.toHaveBeenCalled();
  });

  it("says so when the facts could not be read at all, and keeps saving off", async () => {
    // A save sent without the stored facts would clear every one of them.
    fetchAssociationFacts.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/kunde inte läsas just nu/)).toBeTruthy();
    });
    expect(save()).toHaveProperty("disabled", true);
  });
});

describe("what a save carries", () => {
  it("keeps saving off until the stored facts have been read", () => {
    fetchAssociationFacts.mockReturnValue(new Promise(() => undefined));

    render(<AssociationFactsPanel />);

    expect(save()).toHaveProperty("disabled", true);
  });

  it("sends only the fields the board changed", async () => {
    // An absent field is one the server leaves alone, so a fact nobody touched
    // cannot be cleared by a save it took no part in.
    fetchAssociationFacts.mockResolvedValue({
      ok: true,
      value: recorded({ parking: "Tolv platser i garaget.", buildYear: 1911 }),
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByDisplayValue("Tolv platser i garaget.");
    await session.type(screen.getByLabelText(/^Förråd/), "Ett per lägenhet.");
    await session.click(save());

    await waitFor(() => {
      expect(saveAssociationFacts).toHaveBeenCalled();
    });
    expect(saveAssociationFacts.mock.calls[0]?.[0]).toEqual({
      storage: "Ett per lägenhet.",
    });
  });
});

describe("a read that lands after the board has started typing", () => {
  it("keeps what was typed rather than replacing it with the stored facts", async () => {
    // The fields are interactive from the first render, so the read can land
    // second. What the board typed is the newer of the two and has to win: the
    // alternative is a form that quietly discards a sentence somebody wrote.
    let land: (result: unknown) => void = () => undefined;
    fetchAssociationFacts.mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      }),
    );

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);
    const buildYear = screen.getByLabelText(/^Byggår/);
    await session.type(buildYear, "1948");

    land({
      ok: true,
      value: recorded({ buildYear: 1911, parking: "Tolv platser i garaget." }),
    });

    // The read has reached the form once a field nobody typed in shows it.
    await screen.findByDisplayValue("Tolv platser i garaget.");
    expect(buildYear).toHaveProperty("value", "1948");

    await session.click(save());
    await waitFor(() => {
      expect(saveAssociationFacts).toHaveBeenCalled();
    });
    expect(saveAssociationFacts.mock.calls[0]?.[0]).toEqual({
      buildYear: 1948,
    });
  });
});

describe("when the board last confirmed the facts", () => {
  const CONFIRMED = recorded({
    parking: "Tolv platser i garaget.",
    updatedAt: "2026-03-14T10:00:00.000Z",
    confirmedAt: "2026-03-14T10:00:00.000Z",
  });
  const confirm = () =>
    screen.getByRole("button", { name: "Bekräfta att uppgifterna stämmer" });

  it("says when, beside a way to confirm them unchanged", async () => {
    fetchAssociationFacts.mockResolvedValue({ ok: true, value: CONFIRMED });

    render(<AssociationFactsPanel />);

    expect(
      await screen.findByText("Senast bekräftade av styrelsen: 14 mars 2026"),
    ).toBeTruthy();
    expect(confirm()).toHaveProperty("disabled", false);
  });

  it("offers no confirmation while nothing is recorded", async () => {
    // The server would refuse it, and the public page carries no date either.
    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(save()).toHaveProperty("disabled", false);
    });
    expect(
      screen.queryByRole("button", {
        name: "Bekräfta att uppgifterna stämmer",
      }),
    ).toBeNull();
    expect(screen.queryByText(/Senast bekräftade/)).toBeNull();
  });

  it("confirms without sending a fact, and shows the new date", async () => {
    fetchAssociationFacts.mockResolvedValue({ ok: true, value: CONFIRMED });
    confirmAssociationFacts.mockResolvedValue({
      ok: true,
      value: { ...CONFIRMED, confirmedAt: "2026-10-19T08:00:00.000Z" },
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByText(/14 mars 2026/);
    await session.click(confirm());

    expect(
      await screen.findByText(
        "Senast bekräftade av styrelsen: 19 oktober 2026",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Uppgifterna är bekräftade.")).toBeTruthy();
    expect(confirmAssociationFacts).toHaveBeenCalledTimes(1);
    expect(saveAssociationFacts).not.toHaveBeenCalled();
  });

  it("is held back while the form has changes nobody saved", async () => {
    // It confirms what the server holds. Offering it over an unsaved edit would
    // have the board confirm text that is not on the page.
    fetchAssociationFacts.mockResolvedValue({ ok: true, value: CONFIRMED });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    const parking = await screen.findByDisplayValue("Tolv platser i garaget.");
    await session.type(parking, " Och en laddplats.");

    expect(confirm()).toHaveProperty("disabled", true);
  });

  it("moves when a save does", async () => {
    fetchAssociationFacts.mockResolvedValue({ ok: true, value: CONFIRMED });
    saveAssociationFacts.mockResolvedValue({
      ok: true,
      value: {
        ...CONFIRMED,
        storage: "Ett per lägenhet.",
        confirmedAt: "2026-10-19T08:00:00.000Z",
      },
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByText(/14 mars 2026/);
    await session.type(screen.getByLabelText(/^Förråd/), "Ett per lägenhet.");
    await session.click(save());

    expect(
      await screen.findByText(
        "Senast bekräftade av styrelsen: 19 oktober 2026",
      ),
    ).toBeTruthy();
    // Saved, so there is nothing left that would make a confirmation a lie.
    expect(confirm()).toHaveProperty("disabled", false);
  });

  it("says why when the server finds nothing to confirm", async () => {
    fetchAssociationFacts.mockResolvedValue({ ok: true, value: CONFIRMED });
    confirmAssociationFacts.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "nothing-recorded" },
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByText(/14 mars 2026/);
    await session.click(confirm());

    expect(
      await screen.findByText(/inga uppgifter att bekräfta ännu/),
    ).toBeTruthy();
  });
});

describe("how many months the facts count as current", () => {
  const months = () =>
    screen.getByLabelText(/^Antal månader uppgifterna räknas som aktuella/);
  const saveMonths = () =>
    screen.getByRole("button", { name: "Spara antal månader" });

  it("shows the board's setting once it has been read", async () => {
    fetchAssociationFacts.mockResolvedValue({
      ok: true,
      value: recorded({ staleAfterMonths: 6 }),
    });

    render(<AssociationFactsPanel />);

    expect(await screen.findByDisplayValue("6")).toBe(months());
    expect(saveMonths()).toHaveProperty("disabled", false);
  });

  it("is saved on its own, without sending or confirming a fact", async () => {
    saveStaleAfterMonths.mockResolvedValue({
      ok: true,
      value: recorded({ staleAfterMonths: 5 }),
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByDisplayValue("3");
    await session.clear(months());
    await session.type(months(), "5");
    await session.click(saveMonths());

    await waitFor(() => {
      expect(saveStaleAfterMonths).toHaveBeenCalledWith(5);
    });
    expect(await screen.findByDisplayValue("5")).toBe(months());
    expect(screen.getByText("Sparat")).toBeTruthy();
    expect(saveAssociationFacts).not.toHaveBeenCalled();
    expect(confirmAssociationFacts).not.toHaveBeenCalled();
  });

  it("refuses a number outside 1 to 12, without asking the server", async () => {
    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByDisplayValue("3");
    await session.clear(months());
    await session.type(months(), "13");

    expect(
      screen.getByText("Ange ett helt antal månader, mellan 1 och 12."),
    ).toBeTruthy();
    expect(saveMonths()).toHaveProperty("disabled", true);
    expect(saveStaleAfterMonths).not.toHaveBeenCalled();
  });

  it("says so when the server refuses it", async () => {
    saveStaleAfterMonths.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "stale-after-months-out-of-range" },
    });

    const session = userEvent.setup();
    render(<AssociationFactsPanel />);

    await screen.findByDisplayValue("3");
    await session.clear(months());
    await session.type(months(), "4");
    await session.click(saveMonths());

    expect(
      await screen.findByText("Ange ett helt antal månader, mellan 1 och 12."),
    ).toBeTruthy();
  });
});
