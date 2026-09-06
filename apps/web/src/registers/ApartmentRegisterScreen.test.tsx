import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { ApartmentRegisterScreen } from "./ApartmentRegisterScreen";
import type {
  ApartmentRegisterExtract,
  ApartmentRegisterTransfer,
} from "./registers-api";

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
const recordTermination = vi.fn();
const recordReportBasis = vi.fn();
const recordTransferReversal = vi.fn();
const recordPropertyDesignation = vi.fn();
const recordLandTenure = vi.fn();

vi.mock("./registers-api", () => ({
  fetchApartmentRegister: () => fetchApartmentRegister(),
  fetchOwnApartmentRegister: () => fetchOwnApartmentRegister(),
  revealApartmentRegister: () => revealApartmentRegister(),
  revealOwnApartmentRegister: () => revealOwnApartmentRegister(),
  noteLien: (input: unknown) => noteLien(input),
  releaseLien: (input: unknown) => releaseLien(input),
  recordTermination: (input: unknown) => recordTermination(input),
  recordReportBasis: (input: unknown) => recordReportBasis(input),
  recordTransferReversal: (input: unknown) => recordTransferReversal(input),
  recordPropertyDesignation: (input: unknown) =>
    recordPropertyDesignation(input),
  recordLandTenure: (input: unknown) => recordLandTenure(input),
}));

/**
 * The association's calendar, stubbed so the assertion about it can discriminate.
 *
 * The day this returns is one no clock in the test process would read, which is
 * the point: a maximum built from the device's own year, month and day cannot
 * produce it, however the runner's zone happens to be set. Asserting against a
 * real instant instead would pass on a machine already running Stockholm time,
 * which is most of them here, and would prove nothing.
 */
const localDayNow = vi.fn(() => "2026-09-01");
vi.mock("../bookings/booking-calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bookings/booking-calendar")>()),
  localDayNow: () => localDayNow(),
}));

const MASKED: ApartmentRegisterExtract = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
    propertyDesignation: "Talgoxen 4",
    landTenure: null,
    taxAssessmentUnitNumber: null,
    propertyType: null,
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
          kind: "TRANSFER",
          reportBasis: "MEMBERSHIP_DECISION",
          transferredOn: "2019-06-01",
          membershipDecidedOn: "2019-05-14",
          fromName: "Karin Ohman",
          toName: "Anna Lindqvist",
          price: "3450000.00",
          agreementReference: "Overlatelseavtal 2019-42",
        },
        {
          // Recorded before a reference was required of every transfer. There
          // is none to be found for it and the row cannot be deleted, so the
          // extract has to say so. Its membership decision date is absent for
          // the same reason, which is what the screen offers to record.
          id: "transfer-0",
          // And before the register recorded which kind of event a row was, so
          // it says neither, which is a third thing from a grant.
          kind: null,
          // And before the board stated which case of Lag (2026:484) 3 kap. 3 §
          // the overgang falls in, which is what the screen offers to record.
          reportBasis: null,
          transferredOn: "2014-03-02",
          membershipDecidedOn: null,
          fromName: null,
          toName: "Karin Ohman",
          price: null,
          agreementReference: null,
        },
      ],
      transferReversals: [],
      terminations: [],
    },
  ],
};

/**
 * The same extract with a case recorded on the transfer that has none.
 *
 * Built from MASKED rather than written out, so a field added to the fixture
 * reaches both and the two cannot drift.
 */
function withBasis(
  basis: NonNullable<ApartmentRegisterTransfer["reportBasis"]>,
): ApartmentRegisterExtract {
  return {
    ...MASKED,
    rows: MASKED.rows.map((row) => ({
      ...row,
      transfers: row.transfers.map((transfer) =>
        transfer.id === "transfer-0"
          ? { ...transfer, reportBasis: basis }
          : transfer,
      ),
    })),
  };
}

/** The same extract with the registered transfer recorded as having gone back. */
const REVERSED: ApartmentRegisterExtract = {
  ...MASKED,
  rows: MASKED.rows.map((row) => ({
    ...row,
    transferReversals: [
      {
        id: "reversal-1",
        transferId: "transfer-1",
        kind: "RETURNED_TO_SELLER",
        reversedOn: "2019-08-01",
        reference: "Hävningsförklaring 2019-7",
      },
    ],
  })),
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
  recordTermination.mockReset().mockResolvedValue({ ok: true, value: {} });
  recordReportBasis.mockReset().mockResolvedValue({ ok: true, value: {} });
  recordTransferReversal.mockReset().mockResolvedValue({ ok: true, value: {} });
  recordPropertyDesignation
    .mockReset()
    .mockResolvedValue({ ok: true, value: { propertyDesignation: null } });
  recordLandTenure.mockReset().mockResolvedValue({
    ok: true,
    value: {
      landTenure: null,
      taxAssessmentUnitNumber: null,
      propertyType: null,
    },
  });
  localDayNow.mockReturnValue("2026-09-01");
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

  it("is offered none of the register-completeness controls either", async () => {
    // Recording a termination, the case an overgang falls in, a reversal, the
    // designation or how the land is held is the board's, exactly as noting a
    // lien is. The server refuses a holder either way; this is what keeps the
    // screen from offering an act that would be.
    render(<ApartmentRegisterScreen />);

    await screen.findByText("Storgatan 12 1103");
    expect(
      screen.queryByRole("button", { name: /Registrera upphörande/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Registrera fallet/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Registrera hävning eller återgång/,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /fastighetsbeteckning/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /hur marken innehas/i }),
    ).toBeNull();
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

/**
 * What the register has to state for the cooperative housing register to be
 * reportable from it.
 *
 * The dates here are the ones Lag (2026:484) 3 kap. runs its two-week windows
 * from, on rows the database will not let anyone correct. A screen that showed
 * them but could not record them, or recorded them without stating them, would
 * leave the board with a register it cannot report from.
 */
describe("register completeness", () => {
  it("states the property designation on the document", async () => {
    // The association's own authoritative record of it, not the prose it
    // publishes to a broker.
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText(/Talgoxen 4/)).toBeTruthy();
  });

  it("states a transfer's membership decision date where there is one", async () => {
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText(/2019-05-14/)).toBeTruthy();
  });

  it("offers all five cases of 3 kap. 3 § on a transfer that states none", async () => {
    // Offered rather than called a gap: three of that section's four rules have
    // no membership decision at all and a fourth is not the association's report
    // to make, so a register must not describe an absent date as missing.
    render(<ApartmentRegisterScreen />);

    const control = await screen.findByRole("button", {
      name: /Registrera fallet/,
    });
    // Disabled until a case is chosen, so an empty submission cannot reach a
    // route that would refuse it.
    expect(control.hasAttribute("disabled")).toBe(true);

    const cases = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(cases).toContain(
      i18n.t("registers.apartment.transfers.basisUnchosen"),
    );
    for (const basis of [
      "MEMBERSHIP_DECISION",
      "ALREADY_MEMBER",
      "OUTSIDE_MEMBERSHIP_REQUIREMENT",
      "TO_THE_ASSOCIATION",
      "LIENHOLDING_JURIDICAL_PERSON",
    ] as const) {
      expect(cases).toContain(
        i18n.t(`registers.apartment.transfers.basis.${basis}`),
      );
    }
  });

  it("names the transfer in every per-transfer control", async () => {
    /*
     * A row lists several transfers and each carries its own controls, so the
     * visible text of one is the visible text of all of them. Both of these
     * write a value that cannot be corrected afterwards - the reversal goes into
     * an append-only table, and a transfer that states its case is not
     * overwritten - so somebody reading the screen through its accessible names
     * has to be able to tell which transfer a control acts on.
     */
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const reversals = await screen.findAllByRole("button", {
      name: /Registrera hävning eller återgång/,
    });
    expect(
      reversals.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      i18n.t("registers.apartment.reversals.addLabel", {
        transferredOn: "2019-06-01",
        to: "Anna Lindqvist",
      }),
      i18n.t("registers.apartment.reversals.addLabel", {
        transferredOn: "2014-03-02",
        to: "Karin Ohman",
      }),
    ]);

    // The transfer that states no case yet, which is the one the case control
    // is offered on.
    const named = { transferredOn: "2014-03-02", to: "Karin Ohman" };
    const select = screen.getByLabelText(
      i18n.t("registers.apartment.transfers.basisLabelFor", named),
    );
    expect(
      screen.getByRole("button", {
        name: i18n.t("registers.apartment.transfers.basisSubmitLabel", named),
      }),
    ).toBeTruthy();

    // And the date the first case takes, which appears only once it is chosen.
    await session.selectOptions(select, "MEMBERSHIP_DECISION");
    expect(
      screen.getByLabelText(
        i18n.t(
          "registers.apartment.transfers.membershipDecidedLabelFor",
          named,
        ),
      ),
    ).toBeTruthy();
  });

  it("records the ordinary case with the day the board decided", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const select = await screen.findByLabelText(/Fall enligt 3 kap. 3/);
    await session.selectOptions(select, "MEMBERSHIP_DECISION");

    const [input] = screen.getAllByLabelText(/Medlemskap beslutat/);
    await session.type(input as HTMLElement, "2014-02-20");
    await session.click(
      screen.getByRole("button", { name: /Registrera fallet/ }),
    );

    expect(recordReportBasis).toHaveBeenCalledWith({
      // The transfer with no case, and not the one beside it that has one.
      transferId: "transfer-0",
      basis: "MEMBERSHIP_DECISION",
      membershipDecidedOn: "2014-02-20",
    });
  });

  it("offers no decision date in a case that has none, and sends none", async () => {
    // The window for these runs "fran overgangen", so there is no decision to
    // date and the server refuses one. A screen offers no control the server
    // would refuse - and a date typed into a field that is then dropped is a
    // statutory value the board believes it recorded.
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const select = await screen.findByLabelText(/Fall enligt 3 kap. 3/);
    await session.selectOptions(select, "ALREADY_MEMBER");

    expect(screen.queryByLabelText(/Medlemskap beslutat/)).toBeNull();
    await session.click(
      screen.getByRole("button", { name: /Registrera fallet/ }),
    );

    expect(recordReportBasis).toHaveBeenCalledWith({
      transferId: "transfer-0",
      basis: "ALREADY_MEMBER",
      membershipDecidedOn: null,
    });
  });

  it("states which case a transfer falls in once it is recorded", async () => {
    // The one case that raises no duty at all has to be readable on the entry.
    // A board that recorded it and then saw nothing could not tell that from
    // having forgotten to record anything.
    fetchApartmentRegister.mockResolvedValue({
      ok: true,
      value: withBasis("LIENHOLDING_JURIDICAL_PERSON"),
    });
    render(<ApartmentRegisterScreen />);

    expect(
      await screen.findByText(
        i18n.t(
          "registers.apartment.transfers.basis.LIENHOLDING_JURIDICAL_PERSON",
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Registrera fallet/ }),
    ).toBeNull();
  });

  it("says the case was refused, and not the termination", async () => {
    // Two different register acts are recorded from this screen. A board told
    // that a termination failed would go looking for a termination that was
    // never attempted, and the repair for a termination it thought had gone
    // wrong is to record it again.
    recordReportBasis.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "report-basis-already-recorded" },
    });
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const select = await screen.findByLabelText(/Fall enligt 3 kap. 3/);
    await session.selectOptions(select, "ALREADY_MEMBER");
    await session.click(
      screen.getByRole("button", { name: /Registrera fallet/ }),
    );

    expect(
      await screen.findByText(/Fallet kunde inte registreras/),
    ).toBeTruthy();
    // The assertion the state was wrong on: this is the notice the screen used
    // to show for this failure.
    expect(screen.queryByText(/Upphörandet kunde inte registreras/)).toBeNull();
  });

  it("sends the case once however often the control is clicked", async () => {
    // The route refuses a transfer that already states its case, so a second
    // request sent while the first is in flight comes back refused and raises
    // the failure notice for the request that succeeded. The board would then be
    // told the recording failed by the very act that proves it did not, on a
    // value that cannot be recorded again.
    let settle = (): void => {};
    recordReportBasis.mockImplementation(
      async () =>
        new Promise((resolve) => {
          settle = () => {
            resolve({ ok: true, value: {} });
          };
        }),
    );
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const select = await screen.findByLabelText(/Fall enligt 3 kap. 3/);
    await session.selectOptions(select, "ALREADY_MEMBER");
    const control = screen.getByRole("button", { name: /Registrera fallet/ });
    await session.click(control);
    await session.click(control);

    expect(recordReportBasis).toHaveBeenCalledTimes(1);

    settle();
    await screen.findAllByLabelText(/Fall enligt 3 kap. 3/);
  });

  it("records a registered transfer as having gone back to the seller", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    const [open] = await screen.findAllByRole("button", {
      name: /Registrera hävning eller återgång/,
    });
    await session.click(open as HTMLElement);

    await session.selectOptions(
      screen.getByLabelText(/Vad som hände/),
      "RETURNED_TO_SELLER",
    );
    await session.type(
      screen.getByLabelText(/Hävd eller återgången/),
      "2019-08-01",
    );
    await session.type(
      screen.getByLabelText(/^Referens/),
      "Hävningsförklaring 2019-7",
    );
    await session.click(
      screen.getByRole("button", {
        name: /Registrera hävningen eller återgången/,
      }),
    );

    expect(recordTransferReversal).toHaveBeenCalledWith({
      transferId: "transfer-1",
      kind: "RETURNED_TO_SELLER",
      reversedOn: "2019-08-01",
      reference: "Hävningsförklaring 2019-7",
    });
  });

  it("offers no reversal on an upplatelse, which has nobody to go back to", async () => {
    // At a grant the right comes into being, so there is no earlier holder for
    // the bostadsratt to go back to, and Lag (2026:484) 3 kap. 3 § tredje
    // stycket is about an overlatelse. The server refuses it and the database
    // refuses it, so the screen does not offer it.
    fetchApartmentRegister.mockResolvedValue({
      ok: true,
      value: {
        ...MASKED,
        rows: MASKED.rows.map((row) => ({
          ...row,
          transfers: [
            {
              id: "transfer-grant",
              kind: "GRANT" as const,
              reportBasis: null,
              transferredOn: "2013-01-10",
              membershipDecidedOn: null,
              fromName: null,
              toName: "Karin Ohman",
              price: null,
              agreementReference: "Upplatelseavtal 2013-1",
            },
          ],
        })),
      },
    });
    render(<ApartmentRegisterScreen />);

    await screen.findByText(/Upplatelseavtal 2013-1/);
    expect(
      screen.queryByRole("button", {
        name: /Registrera hävning eller återgång/,
      }),
    ).toBeNull();
  });

  it("offers no second reversal on a transfer that already carries one", async () => {
    // The row is unique per transfer and append-only, so a second attempt is
    // refused by the database, and a control that could only fail is one this
    // screen does not carry.
    fetchApartmentRegister.mockResolvedValue({ ok: true, value: REVERSED });
    render(<ApartmentRegisterScreen />);

    await screen.findByText(/Hävningsförklaring 2019-7/);
    const remaining = screen.queryAllByRole("button", {
      name: /Registrera hävning eller återgång/,
    });
    // Only the legacy transfer beside it, which carries no reversal.
    expect(remaining).toHaveLength(1);
  });

  it("offers exactly the two grounds a termination can rest on", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Registrera upphörande/ }),
    );

    // Scoped to the termination's own select. The transfer above it offers the
    // five cases of Lag (2026:484) 3 kap. 3 §, and a query over every option on
    // the screen would count those too.
    const grounds = within(screen.getByLabelText(/^Grund/))
      .getAllByRole("option")
      .map((option) => option.textContent);
    // Two and no more: bostadsrättslagen distinguishes two grounds, and a
    // third offered here would be a claim about the law.
    expect(grounds).toHaveLength(2);
    expect(grounds[0]).toMatch(/föreningsstämma/i);
    expect(grounds[1]).toMatch(/exekutivt/i);
  });

  it("records the ground, the day it took effect and the reference", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Registrera upphörande/ }),
    );
    await session.type(screen.getByLabelText(/Upphörde/), "2026-02-18");
    await session.type(
      screen.getByLabelText(/Hänvisning/),
      "Stammoprotokoll 2026-1",
    );
    await session.click(
      screen.getByRole("button", { name: /Registrera upphörandet/ }),
    );

    expect(recordTermination).toHaveBeenCalledWith({
      apartmentId: "apartment-1103",
      kind: "GENERAL_MEETING_DECISION",
      tookEffectOn: "2026-02-18",
      reference: "Stammoprotokoll 2026-1",
    });
  });

  it("records the termination once however often the form is submitted", async () => {
    // The route inserts rather than refusing a second one, and the table is
    // append-only with UPDATE and DELETE revoked, so a resubmitted form writes a
    // duplicate statutory record that nobody can take back out. A register
    // saying one tenant-ownership ceased twice has to be explained to
    // Lantmateriet by hand.
    let settle = (): void => {};
    recordTermination.mockImplementation(
      async () =>
        new Promise((resolve) => {
          settle = () => {
            resolve({ ok: true, value: {} });
          };
        }),
    );
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Registrera upphörande/ }),
    );
    await session.type(screen.getByLabelText(/Upphörde/), "2026-02-18");
    await session.type(
      screen.getByLabelText(/Hänvisning/),
      "Stammoprotokoll 2026-1",
    );
    const submit = screen.getByRole("button", {
      name: /Registrera upphörandet/,
    });
    await session.click(submit);
    await session.click(submit);

    expect(recordTermination).toHaveBeenCalledTimes(1);

    settle();
    await screen.findAllByLabelText(/Fall enligt 3 kap. 3/);
  });

  it("bounds both statutory dates by the association's calendar", async () => {
    // The server refuses a date after the Stockholm calendar day
    // (statutoryDate), so an input bounded by the device's day disagrees with it
    // for part of every day, in both directions: west of Stockholm the form
    // would refuse the very day a termination took effect, and east of it the
    // form would offer tomorrow for the API to refuse. Either way a board is
    // stopped from recording the legally correct date on a row that cannot be
    // corrected afterwards, at the start of a statutory two-week window.
    localDayNow.mockReturnValue("2026-07-04");
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    // The membership decision, which is on the register document itself and is
    // offered once the board says the overgang is the case that has one.
    await session.selectOptions(
      await screen.findByLabelText(/Fall enligt 3 kap. 3/),
      "MEMBERSHIP_DECISION",
    );
    const [decided] = screen.getAllByLabelText(/Medlemskap beslutat/);
    expect((decided as HTMLInputElement).max).toBe("2026-07-04");

    // And the termination, on the form the board opens.
    await session.click(
      screen.getByRole("button", { name: /Registrera upphörande/ }),
    );
    expect((screen.getByLabelText(/Upphörde/) as HTMLInputElement).max).toBe(
      "2026-07-04",
    );
  });

  it("says the record cannot be changed afterwards, before it is made", async () => {
    // The one warning that has to be on this form. The row is append-only in
    // the database and beyond the application role's reach, so a mis-keyed
    // date is answered by a note in the audit log and nothing else.
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Registrera upphörande/ }),
    );

    expect(screen.getByText(/kan inte ändras eller tas bort/i)).toBeTruthy();
  });

  it("clears the designation rather than storing an empty one", async () => {
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Ändra fastighetsbeteckning/ }),
    );
    await session.clear(screen.getByLabelText(/Fastighetsbeteckning/));
    await session.click(screen.getByRole("button", { name: /^Registrera$/ }));

    // Null and not "": the register states a designation or says none is
    // recorded, and an empty string would print as a blank on a document.
    expect(recordPropertyDesignation).toHaveBeenCalledWith({
      propertyDesignation: null,
    });
  });

  it("offers the two conditional fields only where the förordning reports them", async () => {
    // Förordning (2026:898) 2 kap. 4 § andra stycket reports a
    // taxeringsenhetsnummer and a fastighetstyp in place of the lagfarts- och
    // tomträttsinnehav, and only where the buildings stand on land the
    // association neither owns nor holds with tomträtt. The server refuses them
    // beside any other answer and the database will not hold them there.
    const session = userEvent.setup();
    render(<ApartmentRegisterScreen />);

    await session.click(
      await screen.findByRole("button", {
        name: /Registrera hur marken innehas/,
      }),
    );

    const select = screen.getByLabelText(/^Marken/);
    await session.selectOptions(select, "OWNERSHIP");
    expect(screen.queryByLabelText(/Taxeringsenhetsnummer/)).toBeNull();
    expect(screen.queryByLabelText(/Fastighetstyp/)).toBeNull();

    await session.selectOptions(select, "OTHER");
    await session.type(
      screen.getByLabelText(/Taxeringsenhetsnummer/),
      "12345678",
    );
    await session.type(screen.getByLabelText(/Fastighetstyp/), "Hyreshusenhet");
    await session.click(screen.getByRole("button", { name: /^Registrera$/ }));

    expect(recordLandTenure).toHaveBeenCalledWith({
      landTenure: "OTHER",
      taxAssessmentUnitNumber: "12345678",
      propertyType: "Hyreshusenhet",
    });
  });

  it("states the land and the two conditional fields on the document", async () => {
    fetchApartmentRegister.mockResolvedValue({
      ok: true,
      value: {
        ...MASKED,
        housingCooperative: {
          ...MASKED.housingCooperative,
          landTenure: "OTHER",
          taxAssessmentUnitNumber: "12345678",
          propertyType: "Hyreshusenhet",
        },
      },
    });
    render(<ApartmentRegisterScreen />);

    expect(
      await screen.findByText(
        new RegExp(i18n.t("registers.apartment.landTenure.value.OTHER")),
      ),
    ).toBeTruthy();
    expect(screen.getByText(/12345678/)).toBeTruthy();
    expect(screen.getByText(/Hyreshusenhet/)).toBeTruthy();
  });

  it("tells a grant from a transfer whose seller the register never held", async () => {
    /*
     * Both arrive with no seller and they are different events. An upplatelse
     * is the association's own act (BRL 4 kap.) and is reported to the
     * cooperative housing register two weeks from the grant itself; an overgang
     * out of a hand the register does not hold is reported from a membership
     * decision the board records separately.
     *
     * The screen printed "Upplatelse" for every seller-less row, which said the
     * association had granted a bostadsratt it may only have registered a sale
     * of - and offered to record a decision date on a grant, which the server
     * refuses.
     */
    fetchApartmentRegister.mockResolvedValue({
      ok: true,
      value: {
        ...MASKED,
        rows: [
          {
            ...MASKED.rows[0],
            transfers: [
              {
                id: "transfer-grant",
                kind: "GRANT",
                reportBasis: null,
                transferredOn: "2013-01-10",
                membershipDecidedOn: null,
                fromName: null,
                toName: "Karin Ohman",
                price: null,
                agreementReference: "Upplatelseavtal 2013-1",
              },
              {
                id: "transfer-unknown-seller",
                kind: "TRANSFER",
                reportBasis: null,
                transferredOn: "2016-04-01",
                membershipDecidedOn: null,
                fromName: null,
                toName: "Anna Lindqvist",
                price: null,
                agreementReference: "Overlatelseavtal 2016-9",
              },
            ],
          },
        ],
      },
    });
    render(<ApartmentRegisterScreen />);

    expect(await screen.findByText(/Upplåtelse →/)).toBeTruthy();
    expect(screen.getByText(/Säljaren finns inte i registret →/)).toBeTruthy();

    // One control asking which case of 3 kap. 3 § applies, on the overgang, and
    // none on the grant: 3 kap. 2 § reports an upplatelse and has no cases.
    expect(screen.getAllByLabelText(/Fall enligt 3 kap. 3/)).toHaveLength(1);
    expect(
      screen.getByText(/anmäls inom två veckor från upplåtelsen/),
    ).toBeTruthy();
  });
});
