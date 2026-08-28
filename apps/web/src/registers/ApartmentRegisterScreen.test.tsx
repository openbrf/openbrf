import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { ApartmentRegisterScreen } from "./ApartmentRegisterScreen";
import type { ApartmentRegisterExtract } from "./registers-api";

/**
 * The apartment register extract.
 *
 * Two things are pinned here. The screen a board opens carries no personal
 * identity numbers, and says so without suggesting that the register has
 * therefore stopped being confidential; producing the copy that does carry them
 * is a deliberate act, and the screen says the copy is written to the audit log.
 * And a tenant-owner who is refused the whole register gets their own entry
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
        {
          // Recorded before a reference was required of every transfer. There
          // is none to be found for it and the row cannot be deleted, so the
          // extract has to say so.
          id: "transfer-0",
          transferredOn: "2014-03-02",
          fromName: null,
          toName: "Karin Ohman",
          price: null,
          agreementReference: null,
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

  it("names a transfer that carries no agreement reference", async () => {
    // A reference is required of every transfer recorded from now on, and the
    // row cannot be deleted, so one written before that requirement leaves a
    // gap in a statutory document. Rendering nothing where the reference would
    // be hides it; the extract says which transfer has none.
    render(<ApartmentRegisterScreen />);

    expect(
      await screen.findByText("Ingen avtalshänvisning registrerad"),
    ).toBeTruthy();
  });

  it("takes the words between two transfer parties from the locale", async () => {
    /*
     * The transfer line names who gave up the tenant-ownership and who took it
     * over. Written as one interpolated key rather than assembled in the
     * component, so a locale decides the order and what stands between the two
     * names; a connector written into the component would be the one part of a
     * statutory document that cannot be translated.
     *
     * Proven by changing the key rather than by matching the string it renders
     * today: an implementation that concatenated the names itself would still
     * match the current wording, and would not survive this.
     */
    const key = "registers.apartment.transfers.parties";
    const original = i18n.getResource("sv", "translation", key) as string;
    i18n.addResource(
      "sv",
      "translation",
      key,
      "{{to}} tog over efter {{from}}",
    );

    try {
      render(<ApartmentRegisterScreen />);

      expect(
        await screen.findByText("Anna Lindqvist tog over efter Karin Ohman"),
      ).toBeTruthy();
    } finally {
      i18n.addResource("sv", "translation", key, original);
    }
  });

  it("says a tenant-ownership with no end date is still held", async () => {
    /*
     * heldUntil is null while the tenant-ownership is still held. Sighted
     * readers get a dash, so a column of gaps is legible at a glance;
     * assistive technology gets the sentence, because an unannounced cell
     * cannot be told apart from one whose value failed to arrive.
     *
     * What the sentence says matters as much as that it exists. "Still held" is
     * the fact; "not recorded" would be false, because the register is not
     * missing an end date - there is not one yet.
     */
    render(<ApartmentRegisterScreen />);

    const holder = await screen.findByText("Anna Lindqvist");
    const row = holder.closest("tr");
    const cells = [...(row?.querySelectorAll("td") ?? [])];
    const heldUntil = cells.at(-1);

    expect(heldUntil?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "-",
    );
    expect(heldUntil?.textContent).toContain("Innehas fortfarande");
  });

  it("does not offer the masked screen as one that may be shown to others", async () => {
    // Masking the personal identity numbers does not make the apartment
    // register public. The holders, the initial share capital, the
    // participation share, the lien notes and the transfers are all still on
    // the screen, and BRL 9 kap. keeps the register to the board and to the
    // tenant-owner it concerns. A notice inviting a board to put it on a
    // projector would be the interface advising a disclosure the law forbids.
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText(/Det gör det inte offentligt/)).toBeTruthy();
    expect(screen.queryByText(/går att visa för andra/)).toBeNull();
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
