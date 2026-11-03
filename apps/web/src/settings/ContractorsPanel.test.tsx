import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Contractor } from "../api/work-orders";
import { ContractorsPanel } from "./ContractorsPanel";

/**
 * The board's list of contractors: added with a name and a trade, an empty
 * telephone number or address sent as none, and removed whatever was sent
 * them, once the board has confirmed it.
 */

const fetchContractors = vi.fn();
const createContractor = vi.fn();
const removeContractor = vi.fn();

vi.mock("../api/work-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/work-orders")>()),
  fetchContractors: () => fetchContractors(),
  createContractor: (input: unknown) => createContractor(input),
  removeContractor: (id: string) => removeContractor(id),
}));

const PLUMBER: Contractor = {
  id: "c-ror",
  name: "Rörfirman",
  trade: "Rörmokare",
  phone: "08-123 45 67",
  email: "ror@firma.test",
  active: true,
  workOrderCount: 3,
};

beforeEach(() => {
  fetchContractors.mockReset().mockResolvedValue({ ok: true, value: [] });
  createContractor.mockReset();
  removeContractor.mockReset();
});

describe("ContractorsPanel", () => {
  it("adds a contractor, sending an empty address as none", async () => {
    createContractor.mockResolvedValue({ ok: true, value: PLUMBER });
    const user = userEvent.setup();
    render(<ContractorsPanel />);

    expect(
      await screen.findByText("Det finns inga entreprenörer på listan än."),
    ).toBeTruthy();
    const add = screen.getByRole("button", { name: "Lägg till entreprenör" });
    // Not offered without a name and a trade.
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Namn"), " Rörfirman ");
    await user.type(screen.getByLabelText("Yrke"), "Rörmokare");
    await user.type(screen.getByLabelText("Telefon"), "08-123 45 67");
    expect(
      screen.getByText("Utan adress kan ingen arbetsorder skickas till dem."),
    ).toBeTruthy();
    await user.click(add);

    await waitFor(() => {
      expect(createContractor).toHaveBeenCalledWith({
        name: "Rörfirman",
        trade: "Rörmokare",
        phone: "08-123 45 67",
        email: null,
        active: true,
      });
    });
    expect(fetchContractors).toHaveBeenCalledTimes(2);
  });

  it("removes a contractor who has received work orders only when asked twice, saying what it erases", async () => {
    fetchContractors.mockResolvedValue({ ok: true, value: [PLUMBER] });
    removeContractor.mockResolvedValue({ ok: true, value: undefined });
    const user = userEvent.setup();
    render(<ContractorsPanel />);

    expect(await screen.findByText("Skickade arbetsorder: 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ta bort Rörfirman" }));
    expect(removeContractor).not.toHaveBeenCalled();
    expect(
      screen.getByText(/raderar också namnet och adressen ur arbetsordrarna/),
    ).toBeTruthy();

    // Keeping closes the question and removes nothing.
    await user.click(screen.getByRole("button", { name: "Behåll" }));
    expect(removeContractor).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Ta bort Rörfirman" }));
    await user.click(screen.getByRole("button", { name: "Ta bort för gott" }));
    await waitFor(() => {
      expect(removeContractor).toHaveBeenCalledWith("c-ror");
    });
  });
});
