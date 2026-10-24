import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { ApartmentRegisterExtract } from "../registers/registers-api";
import {
  ApartmentRegisterRoute,
  validateApartmentRegisterSearch,
} from "./ApartmentRegisterRoute";

/**
 * The apartment register's two views, moved between by the address.
 *
 * `view=own` and the board's register are one route, so going from one to the
 * other changes only the search. A board member who holds an apartment does
 * exactly that: opens their own entry from the household, the full register
 * from the board's navigation, and goes Back. What the own entry's address
 * shows must then be the own entry or nothing - never the board's register
 * left over from the view before, nor a full extract the board asked for that
 * arrives after the own entry was opened.
 */

const IDENTITY_NUMBER = "19811228-9874";

const fetchApartmentRegister = vi.fn();
const fetchOwnApartmentRegister = vi.fn();
const revealApartmentRegister = vi.fn();
const revealOwnApartmentRegister = vi.fn();

vi.mock("../registers/registers-api", () => ({
  fetchApartmentRegister: () => fetchApartmentRegister(),
  fetchOwnApartmentRegister: () => fetchOwnApartmentRegister(),
  revealApartmentRegister: () => revealApartmentRegister(),
  revealOwnApartmentRegister: () => revealOwnApartmentRegister(),
}));

// The frame reads the viewer for the band, which is its own test; here it is
// only the room around the screen.
vi.mock("./SignedInFrame", () => ({
  SignedInFrame: ({ children }: { children: ReactNode }): ReactElement => (
    <main>{children}</main>
  ),
}));

const BOARD: ApartmentRegisterExtract = {
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
      roomCount: 3,
      otherSpaces: null,
      livingArea: "74.5",
      economicPlanRegisteredOn: null,
      initialShareCapital: null,
      participationShare: null,
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
      liens: [],
      transfers: [],
      transferReversals: [],
      terminations: [],
    },
  ],
};

const REVEALED: ApartmentRegisterExtract = {
  ...BOARD,
  identityNumbersIncluded: true,
  rows: BOARD.rows.map((row) => ({
    ...row,
    holders: row.holders.map((holder) => ({
      ...holder,
      personalIdentityNumber: { state: "visible", value: IDENTITY_NUMBER },
    })),
  })),
};

// The viewer's own entry is another apartment, so the board's row on screen
// under the own entry's address can be told from it.
const OWN: ApartmentRegisterExtract = {
  ...BOARD,
  audience: "holder",
  rows: BOARD.rows.map((row) => ({
    ...row,
    apartmentId: "apartment-1201",
    designation: "Storgatan 12 1201",
    number: "1201",
    holders: row.holders.map((holder) => ({
      ...holder,
      personId: "person-maja",
      name: "Maja Lind",
    })),
  })),
};

const BOARD_SIGN = "Det här ser bara styrelsen och administratören.";
const OWN_HEADING = /Din post i lägenhetsförteckningen/;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The register's route under /board, as the application mounts it. */
function renderRegister(href: string) {
  const rootRoute = createRootRoute();
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "board",
  });
  const apartmentRegisterRoute = createRoute({
    getParentRoute: () => boardRoute,
    path: "registers/apartments",
    validateSearch: validateApartmentRegisterSearch,
    component: ApartmentRegisterRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      boardRoute.addChildren([apartmentRegisterRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  fetchApartmentRegister
    .mockReset()
    .mockResolvedValue({ ok: true, value: BOARD });
  fetchOwnApartmentRegister
    .mockReset()
    .mockResolvedValue({ ok: true, value: OWN });
  revealApartmentRegister
    .mockReset()
    .mockResolvedValue({ ok: true, value: REVEALED });
  revealOwnApartmentRegister.mockReset();
});

describe("a board member who holds an apartment", () => {
  it("opens their own entry from its address without asking for the board's register", async () => {
    renderRegister("/board/registers/apartments?view=own");

    expect(
      await screen.findByRole("heading", { name: OWN_HEADING }),
    ).toBeTruthy();
    expect(screen.getByText("Storgatan 12 1201")).toBeTruthy();
    expect(fetchOwnApartmentRegister).toHaveBeenCalledTimes(1);
    expect(fetchApartmentRegister).not.toHaveBeenCalled();
  });

  it("is not left with the board's register when going back to an own entry that cannot be read", async () => {
    const router = renderRegister("/board/registers/apartments?view=own");
    await screen.findByText("Storgatan 12 1201");

    await act(() => router.navigate({ to: "/board/registers/apartments" }));
    expect(await screen.findByText(BOARD_SIGN)).toBeTruthy();
    expect(screen.getByText("Storgatan 12 1103")).toBeTruthy();

    fetchOwnApartmentRegister.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    act(() => {
      router.history.back();
    });

    expect(
      await screen.findByText("Förteckningen kunde inte läsas just nu."),
    ).toBeTruthy();
    expect(router.state.location.search).toEqual({ view: "own" });
    expect(screen.queryByText(BOARD_SIGN)).toBeNull();
    expect(screen.queryByText("Storgatan 12 1103")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /fullständiga lagstadgade/i }),
    ).toBeNull();
    expect(fetchOwnApartmentRegister).toHaveBeenCalledTimes(2);
    expect(fetchApartmentRegister).toHaveBeenCalledTimes(1);
  });

  it("is not shown a full extract the board asked for after going back to their own entry", async () => {
    const session = userEvent.setup();
    const reveal = deferred<{ ok: true; value: ApartmentRegisterExtract }>();
    revealApartmentRegister.mockReturnValue(reveal.promise);
    const router = renderRegister("/board/registers/apartments?view=own");
    await screen.findByText("Storgatan 12 1201");

    await act(() => router.navigate({ to: "/board/registers/apartments" }));
    await session.click(
      await screen.findByRole("button", { name: /fullständiga lagstadgade/i }),
    );
    expect(revealApartmentRegister).toHaveBeenCalledTimes(1);

    act(() => {
      router.history.back();
    });
    expect(
      await screen.findByRole("heading", { name: OWN_HEADING }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(fetchOwnApartmentRegister).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      reveal.resolve({ ok: true, value: REVEALED });
      await reveal.promise;
    });

    expect(screen.queryByText(IDENTITY_NUMBER)).toBeNull();
    expect(screen.queryByText("Storgatan 12 1103")).toBeNull();
    expect(screen.queryByText(BOARD_SIGN)).toBeNull();
    expect(screen.getByText("Storgatan 12 1201")).toBeTruthy();
  });
});
