import { describe, expect, it } from "vitest";

import type { ImportField, ImportMapping } from "./import-columns";
import {
  apartmentNameKey,
  type ImportDefaults,
  planImport,
  type PreparedRow,
  readRow,
  type RegisterSnapshot,
} from "./import-plan";

/**
 * What an import would do, decided without a database.
 *
 * The match-key precedence is the part worth pinning hardest: it decides
 * whether a row updates the person it is about or creates a second copy of
 * them, and either mistake is visible to every resident afterwards.
 */

const APARTMENTS = [
  {
    id: "apartment-1101",
    number: "1101",
    addressId: "address-12",
    addressLabel: "Storgatan 12",
  },
  {
    id: "apartment-1102",
    number: "1102",
    addressId: "address-12",
    addressLabel: "Storgatan 12",
  },
  {
    // The same apartment number at the cooperative's other entrance, which is
    // what makes an address column necessary.
    id: "apartment-1101-b",
    number: "1101",
    addressId: "address-14",
    addressLabel: "Storgatan 14",
  },
];

function snapshot(overrides: Partial<RegisterSnapshot> = {}): RegisterSnapshot {
  return {
    apartments: APARTMENTS,
    personsByIdentityNumber: new Map(),
    personsByEmail: new Map(),
    personsByApartmentAndName: new Map(),
    personNames: new Map(),
    ...overrides,
  };
}

const DEFAULTS: ImportDefaults = {
  defaultRole: null,
  defaultMovedInOn: null,
};

function prepared(
  values: Partial<Record<ImportField, string>>,
  overrides: Partial<PreparedRow> = {},
): PreparedRow {
  return {
    rowNumber: 1,
    identityNumberIndex: null,
    emailIndex: null,
    ...overrides,
    values,
  };
}

const COMPLETE = {
  addressLabel: "Storgatan 12",
  apartmentNumber: "1101",
  firstName: "Anna",
  lastName: "Lindqvist",
  role: "Medlem",
  movedInOn: "2019-06-01",
} as const;

describe("reading a row through the mapping", () => {
  it("puts each cell in the field its column was mapped to", () => {
    const mapping: ImportMapping = ["apartmentNumber", null, "fullName"];

    expect(readRow(["1101", "ignored", "Anna Lindqvist"], mapping)).toEqual({
      apartmentNumber: "1101",
      fullName: "Anna Lindqvist",
    });
  });

  it("treats a blank cell as absent rather than as an empty value", () => {
    expect(readRow(["1101", "  "], ["apartmentNumber", "email"])).toEqual({
      apartmentNumber: "1101",
    });
  });
});

describe("the match-key precedence", () => {
  it("matches on the personal identity number first", () => {
    const plan = planImport(
      [
        prepared(COMPLETE, {
          identityNumberIndex: "pin-index",
          emailIndex: "email-index",
        }),
      ],
      snapshot({
        personsByIdentityNumber: new Map([["pin-index", ["person-pin"]]]),
        personsByEmail: new Map([["email-index", ["person-email"]]]),
        personNames: new Map([
          ["person-pin", "Anna Lindqvist"],
          ["person-email", "Someone Else"],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.matchedPersonId).toBe("person-pin");
    expect(plan.rows[0]?.matchedBy).toBe("personalIdentityNumber");
  });

  it("falls back to the email address", () => {
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "email-index" })],
      snapshot({
        personsByEmail: new Map([["email-index", ["person-email"]]]),
        personNames: new Map([["person-email", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.matchedBy).toBe("email");
    expect(plan.rows[0]?.matchedPersonId).toBe("person-email");
  });

  it("falls back to the apartment and an exact name", () => {
    const plan = planImport(
      [prepared(COMPLETE)],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-name"],
          ],
        ]),
        personNames: new Map([["person-name", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.matchedBy).toBe("apartmentAndName");
  });

  it("creates a person when nothing matches", () => {
    const plan = planImport([prepared(COMPLETE)], snapshot(), DEFAULTS);

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[0]?.matchedPersonId).toBeNull();
    expect(plan.summary.create).toBe(1);
  });

  it("does not match a name on the wrong apartment", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, apartmentNumber: "1102" })],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-name"],
          ],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
  });
});

describe("an ambiguous match", () => {
  it("waits for a decision rather than picking one", () => {
    // Two people of the same name in the same apartment is a parent and a
    // child, and picking either would put one's phone number on the other.
    const plan = planImport(
      [prepared(COMPLETE)],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-a", "person-b"],
          ],
        ]),
        personNames: new Map([
          ["person-a", "Anna Lindqvist"],
          ["person-b", "Anna Lindqvist"],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[0]?.candidates.map((c) => c.personId)).toEqual([
      "person-a",
      "person-b",
    ]);
    expect(plan.summary.ambiguous).toBe(1);
  });
});

describe("resolving the apartment", () => {
  it("uses the address to tell two entrances apart", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, addressLabel: "Storgatan 14" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.apartment?.id).toBe("apartment-1101-b");
  });

  it("reads an address written without the usual spacing", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, addressLabel: "storgatan12" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.apartment?.id).toBe("apartment-1101");
  });

  it("refuses a number that exists at two addresses when none was given", () => {
    const { addressLabel: _ignored, ...withoutAddress } = COMPLETE;
    const plan = planImport([prepared(withoutAddress)], snapshot(), DEFAULTS);

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "apartmentNumber",
      reason: "apartment-ambiguous",
    });
  });

  it("takes a unique number without an address column", () => {
    const plan = planImport(
      [
        prepared({
          ...COMPLETE,
          addressLabel: undefined,
          apartmentNumber: "1102",
        }),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.apartment?.id).toBe("apartment-1102");
  });

  it("reports an address that is not in the register", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, addressLabel: "Lillgatan 3" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems).toContainEqual({
      field: "addressLabel",
      reason: "apartment-not-found",
    });
  });
});

describe("validating a row", () => {
  it("refuses a personal identity number that fails its own checksum", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, personalIdentityNumber: "811228-9875" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "personalIdentityNumber",
      reason: "invalid-personal-identity-number",
    });
  });

  it("accepts one that passes", () => {
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: "811228-9874" },
          { identityNumberIndex: "pin-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
  });

  it("refuses an email address the register could not look up again", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, email: "not-an-address" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems).toContainEqual({
      field: "email",
      reason: "invalid-email",
    });
  });

  it("refuses a role it does not recognise", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, role: "styrelseledamot" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems).toContainEqual({
      field: "role",
      reason: "role-unrecognised",
    });
  });

  it("applies the role chosen for the file when the row has none", () => {
    const { role: _ignored, ...withoutRole } = COMPLETE;
    const plan = planImport([prepared(withoutRole)], snapshot(), {
      defaultRole: "RESIDENT",
      defaultMovedInOn: null,
    });

    expect(plan.rows[0]?.role).toBe("RESIDENT");
    expect(plan.rows[0]?.outcome).toBe("create");
  });

  it("refuses a move-out earlier than the move-in", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, movedOutOn: "2015-01-01" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedOutOn",
      reason: "moved-out-before-moved-in",
    });
  });

  it("reports every problem on a row at once", () => {
    // Fixing one problem and being told about the next is how a board gives up
    // on an import.
    const plan = planImport(
      [
        prepared({
          apartmentNumber: "9999",
          fullName: "Lindqvist",
          role: "styrelse",
          movedInOn: "01/03/2020",
        }),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("one person appearing twice in the file", () => {
  it("attaches the second row to the person the first one creates", () => {
    // A member with two apartments is one person with two residencies, not two
    // people with the same name.
    const plan = planImport(
      [
        prepared(COMPLETE, {
          rowNumber: 1,
          emailIndex: "anna-index",
        }),
        prepared(
          { ...COMPLETE, apartmentNumber: "1102" },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[1]?.outcome).toBe("update");
    expect(plan.rows[1]?.sameAsRowNumber).toBe(1);
    expect(plan.rows[1]?.matchedBy).toBe("earlierRow");
  });

  it("attaches both rows to the existing person when there is one", () => {
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "anna-index" }),
        prepared(
          { ...COMPLETE, apartmentNumber: "1102" },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
      ],
      snapshot({
        personsByEmail: new Map([["anna-index", ["person-anna"]]]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(
      plan.rows.every((row) => row.matchedPersonId === "person-anna"),
    ).toBe(true);
    expect(plan.summary.update).toBe(2);
  });
});
