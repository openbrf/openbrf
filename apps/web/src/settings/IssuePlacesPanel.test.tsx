import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ConfiguredIssuePlace } from "../api/issues";
import { IssuePlacesPanel } from "./IssuePlacesPanel";

/**
 * The association's common areas (decision 30), as the board keeps them: added,
 * renamed and switched off, removed only while no issue names one, and a
 * refusal said in words.
 */

const fetchConfiguredPlaces = vi.fn();
const createIssuePlace = vi.fn();
const updateIssuePlace = vi.fn();
const removeIssuePlace = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchConfiguredPlaces: () => fetchConfiguredPlaces(),
  createIssuePlace: (input: unknown) => createIssuePlace(input),
  updateIssuePlace: (input: unknown) => updateIssuePlace(input),
  removeIssuePlace: (id: string) => removeIssuePlace(id),
}));

const LIFT: ConfiguredIssuePlace = {
  id: "p-lift",
  name: "Hiss",
  active: true,
  sortOrder: 1,
  issueCount: 3,
};
const YARD: ConfiguredIssuePlace = {
  id: "p-yard",
  name: "Gård",
  active: true,
  sortOrder: 2,
  issueCount: 0,
};

beforeEach(() => {
  fetchConfiguredPlaces
    .mockReset()
    .mockResolvedValue({ ok: true, value: [LIFT, YARD] });
  createIssuePlace.mockReset().mockResolvedValue({ ok: true, value: YARD });
  updateIssuePlace.mockReset().mockResolvedValue({ ok: true, value: LIFT });
  removeIssuePlace
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("the common areas", () => {
  it("adds one and reads the list again", async () => {
    const session = userEvent.setup();
    render(<IssuePlacesPanel />);
    await screen.findByDisplayValue("Hiss");

    await session.type(
      screen.getByLabelText("Nytt gemensamt utrymme"),
      "Bastu",
    );
    await session.click(screen.getByRole("button", { name: "Lägg till" }));

    await waitFor(() => {
      expect(createIssuePlace).toHaveBeenCalledWith({ name: "Bastu" });
    });
    await waitFor(() => {
      expect(fetchConfiguredPlaces).toHaveBeenCalledTimes(2);
    });
  });

  it("switches one off, and offers the save only for a change", async () => {
    const session = userEvent.setup();
    render(<IssuePlacesPanel />);
    await screen.findByDisplayValue("Hiss");

    const [save] = screen.getAllByRole("button", { name: "Spara" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await session.click(
      screen.getByLabelText("Hiss: erbjuds för nya anmälningar"),
    );
    await session.click(save as HTMLElement);

    await waitFor(() => {
      expect(updateIssuePlace).toHaveBeenCalledWith({
        id: "p-lift",
        values: { name: "Hiss", active: false, sortOrder: 1 },
      });
    });
  });

  it("removes only a place nothing names", async () => {
    const session = userEvent.setup();
    render(<IssuePlacesPanel />);
    await screen.findByDisplayValue("Hiss");

    // The lift is named by three issues: it can be switched off, not removed.
    expect(screen.queryByRole("button", { name: "Ta bort Hiss" })).toBeNull();
    expect(screen.getByText("3 ärenden")).toBeTruthy();

    await session.click(screen.getByRole("button", { name: "Ta bort Gård" }));
    await waitFor(() => {
      expect(removeIssuePlace).toHaveBeenCalledWith("p-yard");
    });
  });

  it("says in words that a name is taken or an apartment", async () => {
    const session = userEvent.setup();
    createIssuePlace.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "place-name-taken" },
    });
    render(<IssuePlacesPanel />);
    await screen.findByDisplayValue("Hiss");

    await session.type(screen.getByLabelText("Nytt gemensamt utrymme"), "hiss");
    await session.click(screen.getByRole("button", { name: "Lägg till" }));
    expect(
      await screen.findByText(/finns redan ett gemensamt utrymme/i),
    ).toBeTruthy();

    createIssuePlace.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "place-name-apartment" },
    });
    await session.click(screen.getByRole("button", { name: "Lägg till" }));
    expect(await screen.findByText(/aldrig en lägenhet/i)).toBeTruthy();
  });
});
