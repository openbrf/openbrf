import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import "../i18n";
import { MoveInPanel } from "./MoveInPanel";

/**
 * Which register event a move-in records, and why the panel asks.
 *
 * An upplatelse (BRL 4 kap.) and an overgang (6 kap.) both reach this form with
 * no seller: the first because the right comes into being and has nobody to
 * pass from, the second because the register began part way through the
 * building's life and does not hold whoever sold. They are reported to the
 * cooperative housing register under different paragraphs and from different
 * days - Lag (2026:484) 3 kap. 2 § from the grant itself, 3 kap. 3 § from a
 * membership decision recorded later - so the board states which it is, and the
 * form does not guess from an empty picker.
 */

/** The stand-in picker's label, in a constant so no-literal-string stays strict. */
const CHOOSE_PERSON = "Valj person";

const moveIn = vi.fn();

vi.mock("./moves-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./moves-api")>()),
  moveIn: (input: unknown) => moveIn(input),
}));

const fetchAddresses = vi.fn();
const fetchApartments = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchAddresses: () => fetchAddresses(),
  fetchApartments: (addressId: string) => fetchApartments(addressId),
}));

const fetchApartment = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchApartment: (apartmentId: string) => fetchApartment(apartmentId),
}));

const fetchBoardRegister = vi.fn();

vi.mock("./PersonSearch", () => ({
  PersonSearch: ({
    onSelect,
  }: {
    onSelect: (person: { personId: string; name: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onSelect({ personId: "person-gunilla", name: "Gunilla Ek" });
      }}
    >
      {CHOOSE_PERSON}
    </button>
  ),
}));

const noop = (): void => {
  /* intentionally empty */
};

beforeEach(() => {
  fetchAddresses.mockReset().mockResolvedValue({
    ok: true,
    value: [{ id: "address-1", street: "Storgatan 12" }],
  });
  fetchApartments.mockReset().mockResolvedValue({
    ok: true,
    value: [{ id: "apartment-1", number: "1201", floor: 1 }],
  });
  fetchApartment.mockReset().mockResolvedValue({
    ok: true,
    value: { holders: [{ personId: "person-karin", name: "Karin Ohman" }] },
  });
  fetchBoardRegister.mockReset();
  moveIn.mockReset().mockResolvedValue({
    ok: true,
    value: {
      residencyId: "residency-1",
      memberRegisterEntryRecorded: true,
      transferId: "transfer-1",
      welcomeEmailSent: true,
    },
  });
});

async function openTransferFields(session: ReturnType<typeof userEvent.setup>) {
  render(<MoveInPanel onClose={noop} onMoved={noop} />);
  await session.click(
    await screen.findByRole("button", { name: CHOOSE_PERSON }),
  );
  await session.click(screen.getByLabelText(/Registrera överlåtelse/));
}

it("offers the previous holder for a transfer and not for a grant", async () => {
  const session = userEvent.setup();
  await openTransferFields(session);

  // The default is the common event, and it asks who sold.
  expect(screen.getByLabelText(/Tidigare innehavare/)).toBeTruthy();

  await session.selectOptions(
    screen.getByLabelText(/Vad registreras/),
    "GRANT",
  );

  /*
   * A grant has no seller, so the field is gone rather than emptied. Its blank
   * option used to read "Upplatelse - ingen tidigare innehavare", which is what
   * made a grant and a sale out of an unknown hand the same row.
   */
  expect(screen.queryByLabelText(/Tidigare innehavare/)).toBeNull();
});

it("sends the kind the board chose", async () => {
  const session = userEvent.setup();
  await openTransferFields(session);

  await session.selectOptions(
    screen.getByLabelText(/Vad registreras/),
    "GRANT",
  );
  await session.selectOptions(screen.getByLabelText(/Lägenhet/), "apartment-1");
  await session.type(screen.getByLabelText(/Inflyttningsdatum/), "2026-04-07");
  await session.type(screen.getByLabelText(/Avtalsdatum/), "2026-04-07");
  await session.type(
    screen.getByLabelText(/Avtalshänvisning/),
    "UPL-2026-1201",
  );
  await session.click(screen.getByRole("button", { name: /Flytta in/ }));

  expect(moveIn).toHaveBeenCalledWith(
    expect.objectContaining({
      transfer: expect.objectContaining({
        kind: "GRANT",
        // Never a seller on a grant: the server refuses one, and the form must
        // not send what a stale selection left behind.
        fromPersonId: null,
      }),
    }),
  );
});
