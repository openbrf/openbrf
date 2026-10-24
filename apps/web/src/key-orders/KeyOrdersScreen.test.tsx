import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnKeyOrder } from "../api/key-orders";
import { KeyOrdersScreen } from "./KeyOrdersScreen";

/**
 * The house's page for keys: ordering one, and following one's own orders.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's queue
 * names the resident and the apartment a key is for, and a screen that asked
 * for it on a household's behalf would be asking the server for other people's
 * data on a page with nowhere to put it. The queue is the board's page now
 * (ADR 0049), so this file asserts that the house's page never makes the
 * request, for a board member as much as for anybody.
 *
 * The split here is a product decision rather than a statute, and that is the
 * point of it. Nothing in BRL or EFL gives anybody a right to a key, so
 * `keyOrders:place` follows residency the way `bookings:book` does - a partner,
 * an adult child and a tenant order one exactly as a member does, which is the
 * opposite of the subletting screen beside it.
 *
 * Every assertion about what a row says is on the substituted text - "2 x Tagg"
 * and not a fragment that would still match with the count missing. The end-to-
 * end suite caught a `{{quantity}}` placeholder reaching a resident verbatim,
 * and it caught it because it asserted the whole rendered phrase; a matcher
 * loose enough to pass either way is how that defect gets back in.
 */

const fetchKeyOrderIntake = vi.fn();
const fetchKeyOrderQueue = vi.fn();
const withdrawKeyOrder = vi.fn();
const reviseKeyOrder = vi.fn();

vi.mock("../api/key-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/key-orders")>()),
  fetchKeyOrderIntake: () => fetchKeyOrderIntake(),
  fetchKeyOrderQueue: () => fetchKeyOrderQueue(),
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

beforeEach(() => {
  fetchKeyOrderIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { apartments: [APARTMENT], orders: [OPEN_ORDER] },
  });
  fetchKeyOrderQueue.mockReset();
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

  it("is told they withdrew an order, not that the board answered it", async () => {
    // The row is kept for years, so it must say who closed it.
    fetchKeyOrderIntake.mockResolvedValue({
      ok: true,
      value: {
        apartments: [APARTMENT],
        orders: [
          {
            ...OPEN_ORDER,
            status: "WITHDRAWN",
            closedAt: "2028-11-05T12:00:00.000Z",
          },
        ],
      },
    });

    render(<KeyOrdersScreen viewer={viewer(["keyOrders:place"])} />);

    await screen.findByText("Dina beställningar");
    expect(screen.getByText("Du återkallade den 2028-11-05.")).not.toBeNull();
    expect(screen.queryByText(/Styrelsen svarade/u)).toBeNull();
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
  it("is offered nothing, and nothing is read", async () => {
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

/**
 * One page, one audience: a board member who lives here orders a key from
 * here like anybody else, and works the queue on the board's own page
 * (ADR 0049).
 */
describe("a board member who lives here", () => {
  it("shows no board content to a board member", async () => {
    render(
      <KeyOrdersScreen
        viewer={viewer(["keyOrders:place", "keyOrders:handle"])}
      />,
    );

    await screen.findByText("Beställ en nyckel eller en tagg");
    expect(screen.getByText("Dina beställningar")).not.toBeNull();
    expect(screen.queryByText("Nyckelbeställningar")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(fetchKeyOrderQueue).not.toHaveBeenCalled();
  });
});
