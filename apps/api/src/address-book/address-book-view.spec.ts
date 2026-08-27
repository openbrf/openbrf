import { describe, expect, it } from "vitest";

import {
  ALWAYS_MASKED_FIELDS,
  type AddressBookRecord,
  hasMovedOut,
  isMasked,
  isVisibleToResidents,
  MASKABLE_FIELDS,
  signsFor,
  toAddressBookRow,
  toIsoDate,
  toResidentDirectoryRow,
} from "./address-book-view";

/**
 * The masking matrix from plan section 4.4, as a test.
 *
 * These are not assertions about a mapper. They are the promises the product
 * makes to a person with protected personal data, whose address is withheld
 * because being found puts them at risk, and to every resident whose contact
 * details the cooperative holds. A regression here is a data breach, not a bug,
 * which is why each case names the rule it defends rather than the function it
 * calls.
 */

const TODAY = new Date("2026-08-27T10:00:00.000Z");

const VIEWER = "person-viewer";

function record(overrides: Partial<AddressBookRecord> = {}): AddressBookRecord {
  return {
    personId: "person-1",
    residencyId: "residency-1",
    firstName: "Anna",
    lastName: "Lindqvist",
    protectedPersonalData: false,
    apartment: {
      id: "apartment-1",
      addressId: "address-1",
      number: "1001",
      floor: 0,
    },
    role: "MEMBER",
    movedInOn: new Date("2019-06-01T00:00:00.000Z"),
    movedOutOn: null,
    boardPositions: [],
    email: "anna.lindqvist@exempel.se",
    phone: "070-123 45 67",
    hasEmail: true,
    hasPhone: true,
    ...overrides,
  };
}

/** Every value a leak would expose, so one search covers the whole payload. */
const SECRETS = ["anna.lindqvist@exempel.se", "070-123 45 67", "8112289874"];

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe("board and admin rows", () => {
  it("shows contact details for a person who is not protected", () => {
    const row = toAddressBookRow(record(), { today: TODAY, purgeOn: null });

    expect(row.contact).toEqual({
      state: "visible",
      email: "anna.lindqvist@exempel.se",
      phone: "070-123 45 67",
    });
  });

  it("masks contact details for a person with protected personal data", () => {
    const row = toAddressBookRow(
      record({
        protectedPersonalData: true,
        // What the service hands the mapper for a protected person: it does not
        // decrypt, so there is no plaintext to pass on. Asserted here so a
        // future caller that DOES decrypt cannot quietly leak through.
        email: null,
        phone: null,
      }),
      { today: TODAY, purgeOn: null },
    );

    expect(row.contact).toEqual({
      state: "masked",
      hasEmail: true,
      hasPhone: true,
    });
  });

  it("keeps a protected person's contact values out of the payload even if handed them", () => {
    // Defence in depth: the mapper is the last gate before serialisation, so it
    // must not pass a value through just because the record carried one.
    const row = toAddressBookRow(record({ protectedPersonalData: true }), {
      today: TODAY,
      purgeOn: null,
    });

    for (const secret of SECRETS) {
      expect(serialize(row)).not.toContain(secret);
    }
  });

  it("reports that data exists without disclosing it, so a reveal is worth asking for", () => {
    const row = toAddressBookRow(
      record({ protectedPersonalData: true, hasPhone: false, phone: null }),
      { today: TODAY, purgeOn: null },
    );

    expect(row.contact).toEqual({
      state: "masked",
      hasEmail: true,
      hasPhone: false,
    });
  });

  it("carries the purge date the caller computed from the retention policy", () => {
    const row = toAddressBookRow(
      record({ movedOutOn: new Date("2026-08-01T00:00:00.000Z") }),
      { today: TODAY, purgeOn: "2027-08-01" },
    );

    expect(row.purgeOn).toBe("2027-08-01");
    expect(row.signs).toContain("MOVED_OUT");
  });

  it("never carries a personal identity number, masked or not", () => {
    // DESIGN.md: a personal identity number does not belong outside the
    // register views, and a list row is the easiest place for one to end up in
    // a screenshot or an export. The only route to one is the audited reveal.
    const row = toAddressBookRow(record(), { today: TODAY, purgeOn: null });

    expect(Object.keys(row)).not.toContain("personalIdentityNumber");
    expect(serialize(row)).not.toContain("personalIdentityNumber");
  });
});

describe("resident-facing rows", () => {
  it("has no contact field at all, rather than an empty or masked one", () => {
    const row = toResidentDirectoryRow(record(), { today: TODAY });

    expect(Object.keys(row).sort()).toEqual([
      "apartment",
      "key",
      "movedInOn",
      "movedOutOn",
      "name",
      "personId",
      "signs",
    ]);
  });

  it("leaks no contact value even when the record carries one", () => {
    const row = toResidentDirectoryRow(record(), { today: TODAY });

    for (const secret of SECRETS) {
      expect(serialize(row)).not.toContain(secret);
    }
  });

  it("carries no purge date: retention is the board's housekeeping", () => {
    const row = toResidentDirectoryRow(
      record({ movedOutOn: new Date("2026-08-01T00:00:00.000Z") }),
      { today: TODAY },
    );

    expect(row).not.toHaveProperty("purgeOn");
  });

  it("still shows names, apartments, roles and dates", () => {
    const row = toResidentDirectoryRow(record(), { today: TODAY });

    expect(row.name).toBe("Anna Lindqvist");
    expect(row.apartment?.number).toBe("1001");
    expect(row.signs).toEqual(["MEMBER"]);
    expect(row.movedInOn).toBe("2019-06-01");
  });
});

describe("who appears in the resident-facing directory", () => {
  it("excludes a person with protected personal data entirely", () => {
    // Not masked, not dimmed: absent. A masked row still says "somebody
    // protected lives in 1103", which is the fact protection withholds.
    expect(
      isVisibleToResidents(
        { personId: "person-1", protectedPersonalData: true },
        VIEWER,
      ),
    ).toBe(false);
  });

  it("includes a protected person's own entry for themselves", () => {
    expect(
      isVisibleToResidents(
        { personId: VIEWER, protectedPersonalData: true },
        VIEWER,
      ),
    ).toBe(true);
  });

  it("includes everyone else", () => {
    expect(
      isVisibleToResidents(
        { personId: "person-1", protectedPersonalData: false },
        VIEWER,
      ),
    ).toBe(true);
  });
});

describe("which fields are masked", () => {
  it("masks the personal identity number for everyone, protected or not", () => {
    expect(
      isMasked("personalIdentityNumber", { protectedPersonalData: false }),
    ).toBe(true);
    expect(
      isMasked("personalIdentityNumber", { protectedPersonalData: true }),
    ).toBe(true);
    expect(ALWAYS_MASKED_FIELDS).toContain("personalIdentityNumber");
  });

  it.each(["email", "phone", "postalAddress"] as const)(
    "masks %s only for a protected person",
    (field) => {
      expect(isMasked(field, { protectedPersonalData: false })).toBe(false);
      expect(isMasked(field, { protectedPersonalData: true })).toBe(true);
    },
  );

  it("masks the postal address of a protected person", () => {
    // The postal address is the field protection exists for: skyddade
    // personuppgifter is about not being findable.
    expect(MASKABLE_FIELDS).toContain("postalAddress");
    expect(isMasked("postalAddress", { protectedPersonalData: true })).toBe(
      true,
    );
  });
});

describe("signs", () => {
  it("puts trust roles first, in order of seniority", () => {
    const signs = signsFor(
      {
        boardPositions: ["BOARD_MEMBER", "CHAIR"],
        role: "MEMBER",
        protectedPersonalData: false,
        movedOutOn: null,
      },
      TODAY,
    );

    expect(signs).toEqual(["CHAIR", "BOARD_MEMBER", "MEMBER"]);
  });

  it("marks a protected person, so the row can carry a lock and masked fields", () => {
    const signs = signsFor(
      {
        boardPositions: [],
        role: "RESIDENT",
        protectedPersonalData: true,
        movedOutOn: null,
      },
      TODAY,
    );

    expect(signs).toEqual(["RESIDENT", "PROTECTED"]);
  });

  it("marks a residency that has ended", () => {
    const signs = signsFor(
      {
        boardPositions: [],
        role: "MEMBER",
        protectedPersonalData: false,
        movedOutOn: new Date("2026-08-01T00:00:00.000Z"),
      },
      TODAY,
    );

    expect(signs).toEqual(["MEMBER", "MOVED_OUT"]);
  });

  it("does not mark a scheduled future move-out as moved out", () => {
    // The authorization layer still grants this person resident access until
    // the date arrives, and a row that disagreed with it would mislead whoever
    // trusted it.
    const signs = signsFor(
      {
        boardPositions: [],
        role: "MEMBER",
        protectedPersonalData: false,
        movedOutOn: new Date("2026-12-01T00:00:00.000Z"),
      },
      TODAY,
    );

    expect(signs).toEqual(["MEMBER"]);
  });

  it("gives a person with no residency only their trust sign", () => {
    // An external board member holds no apartment and no register role.
    const signs = signsFor(
      {
        boardPositions: ["DEPUTY_BOARD_MEMBER"],
        role: null,
        protectedPersonalData: false,
        movedOutOn: null,
      },
      TODAY,
    );

    expect(signs).toEqual(["DEPUTY_BOARD_MEMBER"]);
  });
});

describe("moved-out state", () => {
  it("counts a move-out date of today as moved out", () => {
    expect(hasMovedOut(new Date("2026-08-27T00:00:00.000Z"), TODAY)).toBe(true);
  });

  it("counts a future date as still resident", () => {
    expect(hasMovedOut(new Date("2026-08-28T00:00:00.000Z"), TODAY)).toBe(
      false,
    );
  });

  it("counts no date as still resident", () => {
    expect(hasMovedOut(null, TODAY)).toBe(false);
  });
});

describe("row keys", () => {
  it("keys a row by its residency, so one person can hold two", () => {
    const first = toAddressBookRow(record({ residencyId: "residency-a" }), {
      today: TODAY,
      purgeOn: null,
    });
    const second = toAddressBookRow(record({ residencyId: "residency-b" }), {
      today: TODAY,
      purgeOn: null,
    });

    expect(first.key).not.toBe(second.key);
  });

  it("keys a person with no residency by the person", () => {
    const row = toAddressBookRow(
      record({ residencyId: null, apartment: null, role: null }),
      { today: TODAY, purgeOn: null },
    );

    expect(row.key).toBe("person:person-1");
  });
});

describe("dates on the mono grid", () => {
  it("renders a calendar date, not an instant", () => {
    expect(toIsoDate(new Date("2019-06-01T00:00:00.000Z"))).toBe("2019-06-01");
  });

  it("passes null through", () => {
    expect(toIsoDate(null)).toBeNull();
  });
});
