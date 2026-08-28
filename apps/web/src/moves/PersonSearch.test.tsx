import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PersonSearch } from "./PersonSearch";

/**
 * Picking a person already in the register.
 *
 * What is pinned here is the difference between two answers that look alike on
 * screen and are not: "nobody by that name" and "we could not ask". A board
 * member who believes the person is absent adds a second record for someone
 * already in the register, and the move-in then writes a member register entry
 * against the duplicate - a row nobody can update or delete afterwards.
 */

const fetchBoardRegister = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: AbortSignal) =>
    fetchBoardRegister(query, signal),
}));

const noop = (): void => {
  /* intentionally empty */
};

function page(rows: { personId: string; name: string }[]) {
  return {
    rows,
    stats: { apartments: 1, persons: rows.length, members: rows.length },
    page: 1,
    pageCount: 1,
    total: rows.length,
    addresses: [],
  };
}

beforeEach(() => {
  fetchBoardRegister.mockReset().mockResolvedValue(page([]));
});

describe("searching for a person", () => {
  it("says the register holds nobody by that name when it holds nobody", async () => {
    const session = userEvent.setup();
    render(
      <PersonSearch
        id="person"
        label="Ny innehavare"
        selected={null}
        onSelect={noop}
      />,
    );

    await session.type(screen.getByLabelText(/Ny innehavare/), "Nils");

    expect(await screen.findByText(/Ingen matchar det namnet/)).toBeTruthy();
  });

  it("does not say that when the register could not be asked", async () => {
    fetchBoardRegister.mockRejectedValue(new Error("network is down"));
    const session = userEvent.setup();
    render(
      <PersonSearch
        id="person"
        label="Ny innehavare"
        selected={null}
        onSelect={noop}
      />,
    );

    await session.type(screen.getByLabelText(/Ny innehavare/), "Nils");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/gick inte att söka i just nu/)).toBeTruthy();
    expect(screen.queryByText(/Ingen matchar det namnet/)).toBeNull();
  });
});

describe("the button beside a chosen person", () => {
  it("is named for changing the person, not for cancelling the form", async () => {
    // The panels label the button that closes the whole form "Avbryt". Two
    // buttons reading the same word and doing different things is a lost form
    // for anyone who hits the wrong one, and one name twice for a screen
    // reader.
    render(
      <PersonSearch
        id="person"
        label="Ny innehavare"
        selected={{ personId: "person-nils", name: "Nils Ek" }}
        onSelect={noop}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Välj någon annan/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Avbryt$/ })).toBeNull();
  });
});
