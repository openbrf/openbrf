import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnKeyOrder } from "../api/key-orders";
import { KeyOrdersScreen } from "./KeyOrdersScreen";

/**
 * Which half of the key order screen a seat is given, and what the board is
 * offered here that the motion queue deliberately is not.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the queue names the
 * resident and the apartment a key is for, and a screen that asked for it on a
 * household's behalf would be asking the server for other people's data on a
 * page with nowhere to put it. So this file asserts the request as well as the
 * panel.
 *
 * The split here is a product decision rather than a statute, and that is the
 * point of it. Nothing in BRL or EFL gives anybody a right to a key, so
 * `keyOrders:place` follows residency the way `bookings:book` does - a partner,
 * an adult child and a tenant order one exactly as a member does, which is the
 * opposite of the subletting screen beside it. And the board may decline an
 * order, where refusing to take up a member's motion is not the board's to
 * decide under EFL 6 kap. 15 §.
 *
 * Every assertion about what a row says is on the substituted text - "2 x Tagg"
 * and not a fragment that would still match with the count missing. The end-to-
 * end suite caught a `{{quantity}}` placeholder reaching a resident verbatim,
 * and it caught it because it asserted the whole rendered phrase; a matcher
 * loose enough to pass either way is how that defect gets back in.
 */

const fetchKeyOrderIntake = vi.fn();
const fetchKeyOrderQueue = vi.fn();
const answerKeyOrder = vi.fn();
const withdrawKeyOrder = vi.fn();
const reviseKeyOrder = vi.fn();

vi.mock("../api/key-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/key-orders")>()),
  fetchKeyOrderIntake: () => fetchKeyOrderIntake(),
  fetchKeyOrderQueue: () => fetchKeyOrderQueue(),
  answerKeyOrder: (input: unknown) => answerKeyOrder(input),
  withdrawKeyOrder: (input: unknown) => withdrawKeyOrder(input),
  reviseKeyOrder: (input: unknown) => reviseKeyOrder(input),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-nils",
    firstName: "Nils",
    lastName: "Boende",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

const APARTMENT = {
  id: "apartment-1201",
  number: "1201",
  address: "Storgatan 12",
};

const OPEN_ORDER: OwnKeyOrder = {
  id: "key-1",
  apartment: APARTMENT,
  kind: "TAG",
  quantity: 2,
  note: "Två taggar till cykelrummet.",
  status: "SUBMITTED",
  submittedAt: "2028-11-02T09:00:00.000Z",
  closedAt: null,
  boardNote: null,
};

const ORDERER = {
  kind: "resident" as const,
  personId: "person-nils",
  name: "Nils Boende",
};

beforeEach(() => {
  fetchKeyOrderIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { apartments: [APARTMENT], orders: [OPEN_ORDER] },
  });
  fetchKeyOrderQueue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      orders: [{ ...OPEN_ORDER, orderer: ORDERER, closedByPersonId: null }],
    },
  });
  answerKeyOrder.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...OPEN_ORDER,
      status: "HANDED_OVER",
      closedAt: "2028-11-10T12:00:00.000Z",
      boardNote: "Hämtade i styrelserummet.",
      orderer: ORDERER,
      closedByPersonId: "person-bea",
    },
  });
  withdrawKeyOrder.mockReset();
  reviseKeyOrder.mockReset();
});

describe("a resident", () => {
  it("is offered the form and their own orders, and never the queue", async () => {
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(screen.getByText("Dina beställningar")).not.toBeNull();
    expect(screen.queryByText("Nyckelbeställningar")).toBeNull();

    /*
     * And the read behind the panel was never issued. The queue names the
     * resident and the apartment a key is for, and a page with nowhere to put
     * that must not ask for it - asserting only the missing heading would pass
     * while the request went out.
     */
    expect(fetchKeyOrderQueue).not.toHaveBeenCalled();
    expect(fetchKeyOrderIntake).toHaveBeenCalledTimes(1);
  });

  it("is offered it while holding nothing derived from membership", async () => {
    /*
     * The decision this module makes differently from the subletting one, as an
     * assertion. The viewer holds `keyOrders:place` and no capability derived
     * from a tenant-ownership, and the form is theirs all the same - because no
     * statute makes a key the tenant-owner's, and a way in through the front
     * door belongs to whoever lives behind it.
     */
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(
      screen.getByRole("button", { name: "Skicka beställningen" }),
    ).not.toBeNull();
  });

  it("reads back what was ordered with the count substituted", async () => {
    /*
     * The regression this file exists for. The row's phrase carries both the
     * quantity and the kind, and the whole phrase is asserted: a placeholder
     * left on the translator call renders as "{{quantity}} x Tagg", which still
     * contains "Tagg" and would sail past a matcher that only looked for the
     * kind.
     */
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(screen.getByText("2 x Tagg")).not.toBeNull();
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });

  it("is offered their own apartments and no other", async () => {
    // The only list of apartments this module discloses. A picker over the
    // register would enumerate the building to whoever loaded the form.
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    const apartments = screen
      .getAllByRole("option")
      .map((option) => option.textContent ?? "")
      .filter((label) => label.includes("Storgatan"));
    expect(apartments).toEqual(["Storgatan 12 1201"]);
  });

  it("is told the cost is settled elsewhere rather than shown a price", async () => {
    // A second place holding a sum would be a second answer to what the
    // household owes: the amount belongs to the charge and not to the order.
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(screen.getByText(/Ingenting debiteras här/)).not.toBeNull();
  });

  it("has no door to order to, and is told so rather than shown a form", async () => {
    fetchKeyOrderIntake.mockResolvedValue({
      ok: true,
      value: { apartments: [], orders: [] },
    });

    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(
      screen.getByText(/ingen dörr att beställa nyckel till/),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Skicka beställningen" }),
    ).toBeNull();
  });
});

describe("somebody with an account and no residency", () => {
  it("is offered neither half", async () => {
    // An external board member, or a person mid-onboarding. The capability
    // follows living here, so the screen offers nothing and asks for nothing.
    render(<KeyOrdersScreen viewer={viewer(["self:manage"])} />);

    await screen.findByRole("heading", { name: "Nycklar och taggar" });
    expect(screen.queryByText("Beställ en nyckel eller en tagg")).toBeNull();
    expect(screen.queryByText("Nyckelbeställningar")).toBeNull();
    expect(fetchKeyOrderIntake).not.toHaveBeenCalled();
    expect(fetchKeyOrderQueue).not.toHaveBeenCalled();
  });
});

describe("the board", () => {
  it("is offered the queue, and may decline an order", async () => {
    /*
     * The control the motion queue has no equivalent of, and the reason it is
     * here: refusing to take up a member's item is not the board's to decide
     * under EFL 6 kap. 15 §, and refusing a household a fourth tag to the bike
     * room plainly is.
     */
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    expect(screen.queryByText("Beställ en nyckel eller en tagg")).toBeNull();
    expect(fetchKeyOrderIntake).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Neka beställningen på 2 x Tagg" }),
    ).not.toBeNull();
  });

  it("names the order in the control, with the count substituted", async () => {
    /*
     * Every row offers the same two acts, so the accessible name is what tells
     * a screen reader which order a button belongs to - and it is built from
     * the same phrase the row's text is. Asserted exactly, for the reason the
     * resident's own row is: a placeholder here is invisible to anyone reading
     * the screen with their eyes.
     */
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    expect(
      screen.getByRole("button", { name: "Anteckna utlämning av 2 x Tagg" }),
    ).not.toBeNull();
  });

  it("is told who ordered, which the household's own list never has to say", async () => {
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    expect(screen.getByText("Nils Boende")).not.toBeNull();
  });

  it("is not told who ordered where the register protects their name", async () => {
    /*
     * Skyddade personuppgifter. The board's own address book prints the name and
     * this queue deliberately does not: the queue is a working list rather than
     * a register, and a board member who has to reach the person goes through
     * the register that has a reason to name them. The apartment stays, because
     * the key is for a door and the board has to know which one.
     *
     * Asserted on the absence of the name as well as on the substitute. The
     * projection is the server's, so a client that had started printing
     * `orderer.name` for every kind would still pass a test that only looked
     * for the substitute sentence somewhere on the page.
     */
    fetchKeyOrderQueue.mockResolvedValue({
      ok: true,
      value: {
        orders: [
          {
            ...OPEN_ORDER,
            orderer: { kind: "protected", personId: "person-nils" },
            closedByPersonId: null,
          },
        ],
      },
    });

    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    expect(screen.queryByText("Nils Boende")).toBeNull();
    expect(
      screen.getByText("Skyddade personuppgifter: fråga registret."),
    ).not.toBeNull();
    expect(screen.getByText("Storgatan 12 1201")).not.toBeNull();
  });

  it("is shown no queue at all where the queue could not be read", async () => {
    /*
     * An empty list and a list that failed to arrive are different answers, and
     * the panel has words for only one of them: handed no orders it says nobody
     * has ordered a key. That is a statement about the association made from a
     * request that never answered, and the notice above it does not undo a
     * sentence somebody has already read.
     */
    fetchKeyOrderQueue.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(
      <KeyOrdersScreen
        viewer={viewer(["keyOrders:place", "keyOrders:handle"])}
      />,
    );

    await screen.findByText("Nyckelbeställningarna kunde inte läsas just nu.");
    expect(screen.queryByText("Nyckelbeställningar")).toBeNull();
    expect(
      screen.queryByText("Ingen har beställt nyckel eller tagg."),
    ).toBeNull();

    // And the half that did answer is untouched by the other's failure.
    expect(screen.getByText("Beställ en nyckel eller en tagg")).not.toBeNull();
  });

  it("records the handover with what it wrote", async () => {
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    await userEvent.type(
      screen.getByLabelText("Vad ni vill anteckna med svaret"),
      "Hämtade i styrelserummet.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Anteckna utlämning/ }),
    );

    expect(answerKeyOrder).toHaveBeenCalledWith({
      orderId: "key-1",
      handedOver: true,
      note: "Hämtade i styrelserummet.",
    });
  });

  it("sends no note where the board wrote none", async () => {
    // An empty box is no note rather than an empty one: the server's schema
    // takes a non-empty string or null, and a field nobody typed in is null.
    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    await userEvent.click(
      screen.getByRole("button", { name: /^Neka beställningen/ }),
    );

    expect(answerKeyOrder).toHaveBeenCalledWith({
      orderId: "key-1",
      handedOver: false,
      note: null,
    });
  });

  it("offers no answer on an order it has already answered", async () => {
    // A key that has been handed over is in somebody's pocket, and a record that
    // could be edited back would be a record of nothing.
    fetchKeyOrderQueue.mockResolvedValue({
      ok: true,
      value: {
        orders: [
          {
            ...OPEN_ORDER,
            status: "HANDED_OVER",
            closedAt: "2028-11-10T12:00:00.000Z",
            boardNote: "Hämtade i styrelserummet.",
            orderer: ORDERER,
            closedByPersonId: "person-bea",
          },
        ],
      },
    });

    render(<KeyOrdersScreen viewer={viewer(["keyOrders:handle"])} />);

    await screen.findByText("Nyckelbeställningar");
    expect(screen.getByText("Utlämnad")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Anteckna utlämning/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Neka beställningen/ }),
    ).toBeNull();
  });
});
