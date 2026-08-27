import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { AddressView } from "../api/instance";
import { ApartmentsPanel } from "./ApartmentsPanel";

/**
 * The apartment table.
 *
 * The generator is a starting point, not a commitment: the board edits the
 * table and only then is anything written. That is what makes a generator
 * acceptable for the backbone of a statutory register, so the tests below check
 * that the edited rows are what gets sent, not the formula.
 *
 * Numbers are rendered in the mono face everywhere, which is a DESIGN.md rule
 * rather than a preference: a register column only aligns character for
 * character if every entry is set in the data face.
 */

const fetchApartments = vi.fn();
const addApartments = vi.fn();
const removeApartment = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchApartments: (id: string) => fetchApartments(id),
  addApartments: (id: string, rows: unknown) => addApartments(id, rows),
  removeApartment: (id: string) => removeApartment(id),
}));

const ADDRESSES: readonly AddressView[] = [
  {
    id: "address-1",
    street: "Storgatan",
    number: "12",
    postalCode: "123 45",
    city: "Stockholm",
    sortOrder: 0,
    apartmentCount: 0,
  },
  {
    id: "address-2",
    street: "Storgatan",
    number: "14",
    postalCode: "123 45",
    city: "Stockholm",
    sortOrder: 1,
    apartmentCount: 0,
  },
];

function renderPanel(addresses: readonly AddressView[] = ADDRESSES) {
  return render(<ApartmentsPanel addresses={addresses} onChanged={vi.fn()} />);
}

/** Fills the generator and produces the table. */
async function generate(
  session: ReturnType<typeof userEvent.setup>,
  input: { lowestFloor?: string; floors: string; perFloor: string },
) {
  const lowest = screen.getByLabelText(/lägsta våning/i);
  await session.clear(lowest);
  await session.type(lowest, input.lowestFloor ?? "0");

  const floors = screen.getByLabelText(/antal våningar/i);
  await session.clear(floors);
  await session.type(floors, input.floors);

  const perFloor = screen.getByLabelText(/lägenheter per våning/i);
  await session.clear(perFloor);
  await session.type(perFloor, input.perFloor);

  await session.click(screen.getByRole("button", { name: /^generera$/i }));
}

const numberFields = () => screen.getAllByLabelText(/lägenhetsnummer/i);

beforeEach(() => {
  fetchApartments.mockReset().mockResolvedValue({ ok: true, value: [] });
  addApartments
    .mockReset()
    .mockResolvedValue({ ok: true, value: { created: 2, skipped: 0 } });
  removeApartment.mockReset().mockResolvedValue({ ok: true, value: undefined });
});

describe("the generator", () => {
  it("produces Lantmateriet numbers, entrance floor first", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "2", perFloor: "2" });

    expect(
      numberFields().map((field) => (field as HTMLInputElement).value),
    ).toEqual(["1001", "1002", "1101", "1102"]);
  });

  it("keeps the leading zero for a floor below the entrance", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { lowestFloor: "-1", floors: "1", perFloor: "1" });

    expect((numberFields()[0] as HTMLInputElement).value).toBe("0901");
  });

  it("names the floor in words beside the number", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "2", perFloor: "1" });

    // A four-digit code is not a sentence: the board grouping reads "Entreplan".
    // Scoped to the table, since the panel's own help text uses the word too.
    const cells = screen
      .getAllByRole("cell")
      .map((cell) => cell.textContent ?? "");
    expect(cells).toContain("Entréplan");
    expect(cells).toContain("Plan 1");
  });

  it("sets the numbers in the data face", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "1" });

    expect(numberFields()[0]?.className).toContain("font-data");
  });
});

describe("editing before committing", () => {
  it("sends the edited rows rather than the generated ones", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "2" });

    const [first] = numberFields();
    if (first === undefined) {
      throw new Error("the generator produced no rows");
    }
    await session.clear(first);
    await session.type(first, "1011");

    await session.click(
      screen.getByRole("button", { name: /spara lägenheterna/i }),
    );

    await waitFor(() => {
      expect(addApartments).toHaveBeenCalledWith("address-1", [
        { number: "1011" },
        { number: "1002" },
      ]);
    });
  });

  it("drops a row the board emptied", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "2" });

    const [, second] = numberFields();
    if (second === undefined) {
      throw new Error("the generator produced too few rows");
    }
    await session.clear(second);

    await session.click(
      screen.getByRole("button", { name: /spara lägenheterna/i }),
    );

    await waitFor(() => {
      expect(addApartments).toHaveBeenCalledWith("address-1", [
        { number: "1001" },
      ]);
    });
  });

  it("reports how many landed and how many were already there", async () => {
    // The API adds each number once, so a table committed twice has to say what
    // actually happened rather than claiming to have added everything again.
    addApartments.mockResolvedValue({
      ok: true,
      value: { created: 1, skipped: 1 },
    });
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "2" });
    await session.click(
      screen.getByRole("button", { name: /spara lägenheterna/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/lade till 1/i)).toBeTruthy();
    });
    expect(screen.getByText(/redan registrerade: 1/i)).toBeTruthy();
  });

  it("refuses to commit two rows with the same number", async () => {
    // The API skips duplicates silently, so two identical rows would produce one
    // apartment and no complaint - leaving the board believing both were added.
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "2" });

    const [, second] = numberFields();
    if (second === undefined) {
      throw new Error("the generator produced too few rows");
    }
    await session.clear(second);
    await session.type(second, "1001");

    expect(
      screen.getByText(/1001.*mer än en gång|mer än en gång/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /spara lägenheterna/i }),
    ).toHaveProperty("disabled", true);
  });

  it("removes a row without touching the others", async () => {
    const session = userEvent.setup();
    renderPanel();

    await generate(session, { floors: "1", perFloor: "3" });
    await session.click(
      screen.getAllByRole("button", { name: /ta bort rad/i })[1] as HTMLElement,
    );

    expect(
      numberFields().map((field) => (field as HTMLInputElement).value),
    ).toEqual(["1001", "1003"]);
  });
});

describe("the selected address", () => {
  it("loads the apartments of the first address by default", async () => {
    renderPanel();

    await waitFor(() => {
      expect(fetchApartments).toHaveBeenCalledWith("address-1");
    });
  });

  it("loads the apartments of an address the board picks", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.selectOptions(
      screen.getByLabelText(/^adress$/i),
      "address-2",
    );

    await waitFor(() => {
      expect(fetchApartments).toHaveBeenCalledWith("address-2");
    });
  });

  it("asks for nothing when the housing cooperative has no addresses", async () => {
    renderPanel([]);

    await waitFor(() => {
      expect(screen.getByText(/inga adresser än/i)).toBeTruthy();
    });
    expect(fetchApartments).not.toHaveBeenCalled();
  });
});

describe("apartments already in the register", () => {
  it("says so when an apartment cannot be removed", async () => {
    fetchApartments.mockResolvedValue({
      ok: true,
      value: [{ id: "apartment-1", number: "1101", floor: 1 }],
    });
    removeApartment.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "apartment-in-use" },
    });

    const session = userEvent.setup();
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("1101")).toBeTruthy();
    });
    await session.click(
      screen.getAllByRole("button", { name: /ta bort rad/i })[0] as HTMLElement,
    );

    // The register is append-only where it matters, so the refusal has to be
    // legible rather than a silent no-op.
    await waitFor(() => {
      expect(screen.getByText(/finns i registret/i)).toBeTruthy();
    });
  });
});
