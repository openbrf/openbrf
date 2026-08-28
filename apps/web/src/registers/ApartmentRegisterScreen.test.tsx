import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ApartmentRegisterScreen } from "./ApartmentRegisterScreen";
import type { ApartmentRegisterExtract } from "./registers-api";

/**
 * The apartment register extract.
 *
 * Two things are pinned here. The screen a board opens carries no personal
 * identity numbers, so it is safe to show in a meeting; producing the copy that
 * does is a deliberate act, and the screen says the copy is written to the audit
 * log. And a tenant-owner who is refused the whole register gets their own entry
 * instead, which is what BRL 9 kap. entitles them to.
 */

const IDENTITY_NUMBER = "19811228-9874";

const fetchApartmentRegister = vi.fn();
const fetchOwnApartmentRegister = vi.fn();
const revealApartmentRegister = vi.fn();
const revealOwnApartmentRegister = vi.fn();
const noteLien = vi.fn();
const releaseLien = vi.fn();

vi.mock("./registers-api", () => ({
  fetchApartmentRegister: () => fetchApartmentRegister(),
  fetchOwnApartmentRegister: () => fetchOwnApartmentRegister(),
  revealApartmentRegister: () => revealApartmentRegister(),
  revealOwnApartmentRegister: () => revealOwnApartmentRegister(),
  noteLien: (input: unknown) => noteLien(input),
  releaseLien: (input: unknown) => releaseLien(input),
}));

const MASKED: ApartmentRegisterExtract = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
  },
  generatedOn: "2026-08-28",
  identityNumbersIncluded: false,
  audience: "board",
  rows: [
    {
      apartmentId: "apartment-1103",
      designation: "Storgatan 12 1103",
      number: "1103",
      addressLabel: "Storgatan 12",
      initialShareCapital: "125000.00",
      participationShare: "0.02380952",
      holders: [
        {
          personId: "person-anna",
          name: "Anna Lindqvist",
          protectedPersonalData: false,
          personalIdentityNumber: { state: "masked", hasValue: true },
          heldFrom: "2019-06-01",
          heldUntil: null,
        },
      ],
      liens: [
        {
          id: "lien-1",
          creditor: "Sparbanken",
          notedOn: "2019-06-15",
          releasedOn: null,
          amount: "1500000.00",
        },
      ],
      transfers: [
        {
          id: "transfer-1",
          transferredOn: "2019-06-01",
          fromName: "Karin Ohman",
          toName: "Anna Lindqvist",
          price: "3450000.00",
          agreementReference: "Overlatelseavtal 2019-42",
        },
      ],
    },
  ],
};

const REVEALED: ApartmentRegisterExtract = {
  ...MASKED,
  identityNumbersIncluded: true,
  rows: [
    {
      ...MASKED.rows[0]!,
      holders: [
        {
          ...MASKED.rows[0]!.holders[0]!,
          personalIdentityNumber: {
            state: "visible",
            value: IDENTITY_NUMBER,
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  fetchApartmentRegister.mockReset().mockResolvedValue({
    ok: true,
    value: MASKED,
  });
  fetchOwnApartmentRegister.mockReset();
  revealApartmentRegister
    .mockReset()
    .mockResolvedValue({ ok: true, value: REVEALED });
  revealOwnApartmentRegister.mockReset();
  noteLien.mockReset().mockResolvedValue({ ok: true, value: {} });
  releaseLien.mockReset().mockResolvedValue({ ok: true, value: {} });
});

describe("the board's copy", () => {
  it("carries the statutory fields", async () => {
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText("Storgatan 12 1103")).toBeTruthy();
    expect(screen.getByText("125000.00")).toBeTruthy();
    expect(screen.getByText("0.02380952")).toBeTruthy();
    expect(screen.getByText(/Overlatelseavtal 2019-42/)).toBeTruthy();
    expect(screen.getByText("Sparbanken")).toBeTruthy();
  });

  it("shows no personal identity number until one is asked for", async () => {
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText("Anna Lindqvist")).toBeTruthy();
    expect(screen.queryByText(IDENTITY_NUMBER)).toBeNull();
    expect(screen.getByText("Maskerat")).toBeTruthy();
  });

  it("says the full copy is written to the audit log before it is produced", async () => {
    render(<ApartmentRegisterScreen />);

    expect(
      await screen.findByText(/skrivs till granskningsloggen/i),
    ).toBeTruthy();
  });

  it("produces the full statutory extract on a deliberate click", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /fullständiga lagstadgade/i }),
    );

    expect(await screen.findByText(IDENTITY_NUMBER)).toBeTruthy();
    expect(revealApartmentRegister).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Den här kopian innehåller personnummer/),
    ).toBeTruthy();
  });

  it("takes the numbers off the screen again without a second request", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /fullständiga lagstadgade/i }),
    );
    await screen.findByText(IDENTITY_NUMBER);
    await session.click(screen.getByRole("button", { name: /Dölj dem igen/ }));

    expect(await screen.findByText("Maskerat")).toBeTruthy();
    expect(revealApartmentRegister).toHaveBeenCalledTimes(1);
  });
});

describe("a tenant-owner", () => {
  beforeEach(() => {
    fetchApartmentRegister.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });
    fetchOwnApartmentRegister.mockResolvedValue({
      ok: true,
      value: { ...MASKED, audience: "holder" },
    });
  });

  it("is given their own entry when the whole register is refused", async () => {
    render(<ApartmentRegisterScreen />);

    expect(
      await screen.findByRole("heading", {
        name: /Din post i lägenhetsförteckningen/,
      }),
    ).toBeTruthy();
    expect(fetchOwnApartmentRegister).toHaveBeenCalledTimes(1);
  });

  it("is offered no lien controls, which are the board's", async () => {
    render(<ApartmentRegisterScreen />);

    await screen.findByText("Storgatan 12 1103");
    expect(screen.queryByRole("button", { name: /Notera pant/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Avnotera/ })).toBeNull();
  });
});

describe("noting a lien", () => {
  it("records the creditor and the statutory date of record", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Notera pant/ }),
    );
    await session.type(screen.getByLabelText(/Panthavare/), "Handelsbanken");
    await session.type(screen.getByLabelText(/Anteckningsdag/), "2026-03-14");
    await session.click(screen.getByRole("button", { name: /Notera panten/ }));

    expect(noteLien).toHaveBeenCalledWith({
      apartmentId: "apartment-1103",
      creditor: "Handelsbanken",
      notedOn: "2026-03-14",
      amount: null,
    });
  });
});
