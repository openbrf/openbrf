import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
 */

const fetchAssociationFacts = vi.fn();
const saveAssociationFacts = vi.fn();

vi.mock("./site-facts-api", () => ({
  fetchAssociationFacts: () => fetchAssociationFacts(),
  saveAssociationFacts: (input: unknown) => saveAssociationFacts(input),
}));

const NOTHING_RECORDED: AssociationFacts = {
  propertyDesignation: null,
  buildYear: null,
  landLeasehold: null,
  landLeaseholdNote: null,
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
};

function recorded(overrides: Partial<AssociationFacts>): AssociationFacts {
  return { ...NOTHING_RECORDED, ...overrides };
}

const save = () => screen.getByRole("button", { name: "Spara" });

beforeEach(() => {
  fetchAssociationFacts.mockReset();
  saveAssociationFacts.mockReset();
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
      expect(fetchAssociationFacts).toHaveBeenCalled();
    });
    await session.selectOptions(
      screen.getByLabelText(/^Marken/),
      "Föreningen äger den",
    );
    await session.click(save());

    await waitFor(() => {
      expect(saveAssociationFacts).toHaveBeenCalled();
    });
    expect(saveAssociationFacts.mock.calls[0]?.[0]).toMatchObject({
      landLeasehold: false,
      legalPersonOwners: null,
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
      expect(fetchAssociationFacts).toHaveBeenCalled();
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
      expect(fetchAssociationFacts).toHaveBeenCalled();
    });
    await session.type(screen.getByLabelText(/^Byggår/), "48");
    await session.click(save());

    expect(screen.getByText(/fyra siffror/)).toBeTruthy();
    expect(saveAssociationFacts).not.toHaveBeenCalled();
  });

  it("says so when the facts could not be read at all", async () => {
    fetchAssociationFacts.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<AssociationFactsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/kunde inte läsas just nu/)).toBeTruthy();
    });
  });
});
