import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { MoveOutPanel } from "./MoveOutPanel";

/**
 * What a move-out tells the board afterwards.
 *
 * A move-out is three things at once and only the first is reversible: the
 * residency ends, the service data gets an erasure date derived from the
 * retention policy, and the membership is closed in a statutory register nobody
 * can edit. A panel that reported only the first would leave a board member
 * believing the register can be corrected later, which it cannot.
 */

const moveOut = vi.fn();

vi.mock("./moves-api", () => ({
  moveOut: (input: unknown) => moveOut(input),
}));

/** The register behind the new-holder picker. */
const fetchBoardRegister = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: AbortSignal) =>
    fetchBoardRegister(query, signal),
}));

const NEW_HOLDER = { personId: "person-nils", name: "Nils Ek" };

const TARGET = {
  residencyId: "residency-1",
  personName: "Karin Ohman",
  apartmentNumber: "Storgatan 12 1201",
};

const noop = (): void => {
  /* intentionally empty */
};

beforeEach(() => {
  fetchBoardRegister.mockReset().mockResolvedValue({
    rows: [
      {
        personId: NEW_HOLDER.personId,
        name: NEW_HOLDER.name,
      },
    ],
    stats: { apartments: 1, persons: 1, members: 1 },
    page: 1,
    pageCount: 1,
    total: 1,
    addresses: [],
  });
  moveOut.mockReset().mockResolvedValue({
    ok: true,
    value: {
      residencyId: "residency-1",
      movedOutOn: "2026-06-30",
      purgeOn: "2027-06-30",
      memberRegisterExitRecorded: true,
      transferId: null,
      boardReminderOn: "2026-06-30",
    },
  });
});

async function moveSomeoneOut(session: ReturnType<typeof userEvent.setup>) {
  render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

  await session.type(screen.getByLabelText(/Utflyttningsdatum/), "2026-06-30");
  await session.click(screen.getByRole("button", { name: /^Flytta ut$/ }));
  await screen.findByRole("status");
}

describe("after the move-out", () => {
  it("states the date the service data is erased", async () => {
    const session = userEvent.setup();
    await moveSomeoneOut(session);

    expect(screen.getByText(/Servicedata gallras 2027-06-30/)).toBeTruthy();
  });

  it("says the membership was closed in the member register", async () => {
    const session = userEvent.setup();
    await moveSomeoneOut(session);

    expect(screen.getByText(/avslutades i medlemsförteckningen/)).toBeTruthy();
  });

  it("says the register entry itself is retained whatever the policy says", async () => {
    // The two-tier rule, stated where a board member acts on it: the purge date
    // above governs service data, and no retention setting reaches the archive.
    const session = userEvent.setup();
    await moveSomeoneOut(session);

    expect(screen.getByText(/Ingen gallringsinställning når den/)).toBeTruthy();
  });

  it("says when the board will be reminded", async () => {
    const session = userEvent.setup();
    await moveSomeoneOut(session);

    expect(screen.getByText(/påminns 2026-06-30/)).toBeTruthy();
  });
});

describe("when the move-out is refused", () => {
  it("names the reason in the interface's own words", async () => {
    moveOut.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-moved-out" },
    });
    const session = userEvent.setup();
    render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

    await session.type(
      screen.getByLabelText(/Utflyttningsdatum/),
      "2026-06-30",
    );
    await session.click(screen.getByRole("button", { name: /^Flytta ut$/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/har redan ett utflyttningsdatum/)).toBeTruthy();
  });
});

describe("recording a transfer", () => {
  it("is off until the board asks for it", async () => {
    render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

    expect(screen.queryByLabelText(/Avtalsdatum/)).toBeNull();
  });

  it("asks for the new holder and the agreement once it is on", async () => {
    const session = userEvent.setup();
    render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

    await session.click(
      screen.getByRole("checkbox", { name: /Registrera överlåtelse/ }),
    );

    expect(screen.getByLabelText(/Ny innehavare/)).toBeTruthy();
    expect(screen.getByLabelText(/Avtalsdatum/)).toBeTruthy();
    expect(screen.getByLabelText(/Avtalshänvisning/)).toBeTruthy();
  });

  it("sends the agreement the board entered, and nothing it did not", async () => {
    // A transfer written into the apartment register is not something a later
    // correction tidies away, so what leaves this panel is worth pinning: an
    // optional field left blank travels as null rather than as an empty string.
    const session = userEvent.setup();
    render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

    await session.type(
      screen.getByLabelText(/Utflyttningsdatum/),
      "2026-06-30",
    );
    await session.click(
      screen.getByRole("checkbox", { name: /Registrera överlåtelse/ }),
    );
    await session.type(screen.getByLabelText(/Ny innehavare/), "Nils");
    await session.click(
      await screen.findByRole("button", { name: NEW_HOLDER.name }),
    );
    await session.type(screen.getByLabelText(/Avtalsdatum/), "2026-06-15");
    await session.type(screen.getByLabelText(/Pris/), "3450000");
    await session.click(screen.getByRole("button", { name: /^Flytta ut$/ }));
    await screen.findByRole("status");

    expect(moveOut.mock.calls[0]?.[0]).toEqual({
      residencyId: TARGET.residencyId,
      movedOutOn: "2026-06-30",
      transfer: {
        toPersonId: NEW_HOLDER.personId,
        transferredOn: "2026-06-15",
        price: "3450000",
        // Left blank, and sent as absent rather than as "".
        agreementReference: null,
      },
    });
  });

  it("says so rather than doing nothing when no new holder was chosen", async () => {
    // The picker is not a native control, so the browser cannot refuse this
    // submission. Returning in silence would leave the button looking broken.
    const session = userEvent.setup();
    render(<MoveOutPanel target={TARGET} onClose={noop} onMoved={noop} />);

    await session.type(
      screen.getByLabelText(/Utflyttningsdatum/),
      "2026-06-30",
    );
    await session.click(
      screen.getByRole("checkbox", { name: /Registrera överlåtelse/ }),
    );
    await session.type(screen.getByLabelText(/Avtalsdatum/), "2026-06-15");
    await session.click(screen.getByRole("button", { name: /^Flytta ut$/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Välj den nya innehavaren/)).toBeTruthy();
    expect(moveOut).not.toHaveBeenCalled();
  });
});
