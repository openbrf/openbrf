import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { Board } from "./Board";
import type {
  BoardRow,
  DirectoryRow,
  RegisterPage,
  RegisterFilter,
} from "./register-api";

/**
 * The board as the two audiences see it.
 *
 * The assertions that matter here are the ones a screenshot review would miss:
 * that a protected person's contact value is nowhere in the rendered output, that
 * a resident's board has no contact column at all, and that every state carries a
 * second signal beside its colour. A regression in the first two is a data
 * breach; in the third it is a register a colour blind board member cannot read.
 */

const PROTECTED_EMAIL = "sara.berg@exempel.se";
const PLAIN_EMAIL = "johan.berg@exempel.se";

function baseRow(
  overrides: Partial<DirectoryRow> & { key: string },
): DirectoryRow {
  return {
    personId: overrides.key,
    name: "Johan Berg",
    apartment: {
      id: "apartment-1103",
      addressId: "address-1",
      number: "1103",
      floor: 1,
    },
    signs: ["MEMBER"],
    movedInOn: "2022-11-15",
    movedOutOn: null,
    ...overrides,
  };
}

const ADDRESSES = [
  {
    id: "address-1",
    street: "Storgatan",
    number: "12",
    postalCode: "11122",
    city: "Stockholm",
    apartments: 28,
  },
];

const COUNTS: Record<RegisterFilter, number> = {
  all: 3,
  members: 2,
  residents: 1,
  board: 1,
  movedOut: 1,
};

function page<TRow extends DirectoryRow>(rows: TRow[]): RegisterPage<TRow> {
  return {
    rows,
    addresses: ADDRESSES,
    counts: COUNTS,
    total: rows.length,
    pageSize: 25,
    page: 1,
    stats: { apartments: 28, persons: 3, members: 2 },
    generatedOn: "2026-08-27",
  };
}

const BOARD_ROWS: BoardRow[] = [
  {
    ...baseRow({ key: "johan" }),
    contact: { state: "visible", email: PLAIN_EMAIL, phone: null },
    purgeOn: null,
    protectedPersonalData: false,
  },
  {
    ...baseRow({
      key: "sara",
      name: "Sara Berg",
      signs: ["RESIDENT", "PROTECTED"],
    }),
    // What the server sends for a protected person: the fact that data exists,
    // never the data.
    contact: { state: "masked", hasEmail: true, hasPhone: true },
    purgeOn: null,
    protectedPersonalData: true,
  },
  {
    ...baseRow({
      key: "karin",
      name: "Karin Ohman",
      signs: ["MEMBER", "MOVED_OUT"],
      movedOutOn: "2026-08-01",
      apartment: {
        id: "apartment-1201",
        addressId: "address-1",
        number: "1201",
        floor: 2,
      },
    }),
    contact: { state: "visible", email: null, phone: null },
    purgeOn: "2027-08-01",
    protectedPersonalData: false,
  },
];

const noop = (): void => {
  /* intentionally empty */
};

function renderBoard(
  overrides: Partial<Parameters<typeof Board<BoardRow>>[0]> = {},
) {
  return render(
    <Board
      page={page(BOARD_ROWS)}
      filter="all"
      onFilterChange={noop}
      addressId={undefined}
      onAddressChange={noop}
      onPageChange={noop}
      search=""
      onSearchChange={noop}
      stampKey="register.stamp.addressBook"
      contactOf={(row) => row.contact}
      purgeOf={(row) => row.purgeOn}
      loading={false}
      {...overrides}
    />,
  );
}

describe("the board's view", () => {
  it("shows contact data for a person who is not protected", () => {
    renderBoard();

    expect(screen.getAllByText(PLAIN_EMAIL).length).toBeGreaterThan(0);
  });

  it("renders no part of a protected person's contact data", () => {
    renderBoard();

    expect(screen.queryByText(PROTECTED_EMAIL)).toBeNull();
    // The word, not asterisks: a placeholder shaped like a value reads as "the
    // value is here but hidden".
    expect(screen.getAllByText("Maskerad").length).toBeGreaterThan(0);
  });

  it("marks a protected person with a lock as well as a colour", () => {
    const { container } = renderBoard();
    const sign = screen.getAllByText("Skyddad")[0]?.closest("span");

    expect(sign).not.toBeNull();
    // Colour is never the only signal: the sign carries the word and the lock.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("marks a moved-out row with a dashed sign and its purge date", () => {
    renderBoard();
    const sign = screen.getAllByText("Utflyttad")[0];

    expect(sign?.className).toContain("border-dashed");
    expect(screen.getAllByText(/Gallras 2027-08-01/).length).toBeGreaterThan(0);
  });
});

describe("the resident-facing view", () => {
  /**
   * Rows as a resident receives them: no contact field at all. Built from the
   * resident row type on purpose - the type has nowhere to put contact data, so
   * this call site cannot accidentally supply any.
   */
  const RESIDENT_ROWS: DirectoryRow[] = [
    baseRow({ key: "johan" }),
    baseRow({ key: "karin", name: "Karin Ohman", signs: ["MEMBER"] }),
  ];

  function renderDirectory() {
    return render(
      <Board
        page={page(RESIDENT_ROWS)}
        filter="all"
        onFilterChange={noop}
        addressId={undefined}
        onAddressChange={noop}
        onPageChange={noop}
        search=""
        onSearchChange={noop}
        stampKey="register.stamp.addressBook"
        loading={false}
      />,
    );
  }

  it("has no contact column at all", () => {
    renderDirectory();

    expect(screen.queryByRole("columnheader", { name: "Kontakt" })).toBeNull();
  });

  it("shows names, apartments and roles", () => {
    renderDirectory();

    expect(screen.getByText("Johan Berg")).not.toBeNull();
    expect(screen.getAllByText("1103").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Medlem").length).toBeGreaterThan(0);
  });

  it("does not make a row openable, since there is no resident detail view", () => {
    renderDirectory();

    expect(screen.queryByRole("button", { name: /Oppna|Öppna/ })).toBeNull();
  });
});

describe("the board's furniture", () => {
  it("groups rows by floor, naming the number range", () => {
    renderBoard();

    expect(screen.getByText(/Plan 1 11XX/)).not.toBeNull();
    expect(screen.getByText(/Plan 2 12XX/)).not.toBeNull();
  });

  it("carries the always-visible colour-as-law legend", () => {
    renderBoard();

    expect(screen.getByText(/Färg som lag/)).not.toBeNull();
  });

  it("stamps the address book, not the member register", () => {
    // The address book holds members and non-member residents together, so
    // stamping it as an extract from the member register would misdescribe it.
    // The statutory extracts carry that stamp in their own views.
    renderBoard();

    expect(
      screen.getByText(/Adressbok - Alla adresser - 2026-08-27/),
    ).not.toBeNull();
    expect(screen.queryByText(/medlemsförteckningen/)).toBeNull();
  });

  it("shows each filter with its count and marks the active one", () => {
    renderBoard({ filter: "members" });
    const active = screen.getByRole("button", { name: /Medlemmar/ });

    expect(active.getAttribute("aria-current")).toBe("true");
    // The brass is paired with an underline, which is the second signal.
    expect(active.className).toContain("border-trust-register");
  });

  it("hides the house tabs when there is only one address", () => {
    renderBoard();

    expect(screen.queryByRole("button", { name: "Storgatan 12" })).toBeNull();
  });

  it("shows the house tabs when there is more than one address", () => {
    renderBoard({
      page: {
        ...page(BOARD_ROWS),
        addresses: [
          ...ADDRESSES,
          {
            id: "address-2",
            street: "Storgatan",
            number: "14",
            postalCode: "11122",
            city: "Stockholm",
            apartments: 14,
          },
        ],
      },
    });

    expect(screen.getByRole("button", { name: "Storgatan 14" })).not.toBeNull();
  });

  it("says so when nothing matches, rather than showing an empty grid", () => {
    renderBoard({ page: page([]) });

    expect(screen.getByText("Inget matchar")).not.toBeNull();
  });

  it("calls back with the filter the reader chose", () => {
    const onFilterChange = vi.fn();
    renderBoard({ onFilterChange });

    screen.getByRole("button", { name: /Utflyttade/ }).click();

    expect(onFilterChange).toHaveBeenCalledWith("movedOut");
  });

  it("explains that an encrypted field is searchable only in full", () => {
    // The blind index answers equality only, so a fragment of an email address
    // finds nothing. The field says so rather than looking broken.
    renderBoard();

    expect(screen.getByText(/krypterade/)).not.toBeNull();
  });
});
