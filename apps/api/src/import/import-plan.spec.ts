import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizePersonalIdentityNumber } from "../crypto/personal-data";
import type { ImportField, ImportMapping } from "./import-columns";
import {
  apartmentNameKey,
  changedSincePreview,
  findUndecided,
  type ImportDecisions,
  type ImportDefaults,
  planImport,
  type PreparedRow,
  type PreviewedCandidates,
  readRow,
  type RegisterResidency,
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
  const current = overrides.personsByApartmentAndName ?? new Map();
  const personsByEmail = overrides.personsByEmail ?? new Map();
  return {
    apartments: APARTMENTS,
    personsByIdentityNumber: new Map(),
    personsByEmail,
    personsByApartmentAndName: current,
    // Every current residency is also a residency ever held.
    personsByApartmentAndNameEver: current,
    personNames: new Map(),
    identityNumberIndexByPerson: new Map(),
    // Everyone found by an address has one, unless a case says otherwise.
    personsWithEmail: new Set([...personsByEmail.values()].flat()),
    residenciesByPerson: new Map(),
    takenAt: new Date("2026-01-01T00:00:00.000Z"),
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

/**
 * The residency a {@link COMPLETE} row states, held already: the row writes no
 * residency of its own.
 */
function heldAsComplete(apartmentId: string): RegisterResidency[] {
  return [
    { apartmentId, role: "MEMBER", movedInOn: "2019-06-01", movedOutOn: null },
  ];
}

/** Checksum-valid, and nobody's. */
const PIN_ANNA = "9001010017";
const PIN_OTHER = "9001010025";

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
    expect(plan.rows[0]?.matchedPersonName).toBe("Anna Lindqvist");
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

describe("a single match the row contradicts", () => {
  it("waits for a decision when an email match has a different identity number", () => {
    // A shared or handed-on address reaches the wrong person, and filling in
    // from the row would put one person's identity number in another's record.
    const plan = planImport(
      [
        prepared(COMPLETE, {
          identityNumberIndex: "pin-row",
          emailIndex: "email-index",
        }),
      ],
      snapshot({
        personsByEmail: new Map([["email-index", ["person-a"]]]),
        personNames: new Map([["person-a", "Anna Lindqvist"]]),
        identityNumberIndexByPerson: new Map([["person-a", "pin-a"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[0]?.matchedPersonId).toBeNull();
    expect(plan.rows[0]?.matchedBy).toBe("email");
    expect(plan.rows[0]?.mismatch).toBe("personalIdentityNumber");
    expect(plan.rows[0]?.candidates).toEqual([
      { personId: "person-a", name: "Anna Lindqvist" },
    ]);
  });

  it("waits for a decision when an email match has a different name", () => {
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "email-index" })],
      snapshot({
        personsByEmail: new Map([["email-index", ["person-a"]]]),
        personNames: new Map([["person-a", "Bertil Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[0]?.mismatch).toBe("name");
  });

  it("reads a name that differs only in case and spacing as the same", () => {
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "email-index" })],
      snapshot({
        personsByEmail: new Map([["email-index", ["person-a"]]]),
        personNames: new Map([["person-a", "anna  LINDQVIST"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.mismatch).toBeNull();
  });

  it("waits for a decision when an apartment-and-name match has a different identity number", () => {
    const plan = planImport(
      [prepared(COMPLETE, { identityNumberIndex: "pin-row" })],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-a"],
          ],
        ]),
        personNames: new Map([["person-a", "Anna Lindqvist"]]),
        identityNumberIndexByPerson: new Map([["person-a", "pin-a"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[0]?.matchedBy).toBe("apartmentAndName");
    expect(plan.rows[0]?.mismatch).toBe("personalIdentityNumber");
  });

  it("updates when the matched person has no identity number to contradict", () => {
    const plan = planImport(
      [
        prepared(COMPLETE, {
          identityNumberIndex: "pin-row",
          emailIndex: "email-index",
        }),
      ],
      snapshot({
        personsByEmail: new Map([["email-index", ["person-a"]]]),
        personNames: new Map([["person-a", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.matchedPersonId).toBe("person-a");
  });

  it("does not second-guess an identity-number match on the name", () => {
    // A name changes over a lifetime; the identity number does not.
    const plan = planImport(
      [prepared(COMPLETE, { identityNumberIndex: "pin-a" })],
      snapshot({
        personsByIdentityNumber: new Map([["pin-a", ["person-a"]]]),
        personNames: new Map([["person-a", "Anna Berg"]]),
        identityNumberIndexByPerson: new Map([["person-a", "pin-a"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.matchedPersonName).toBe("Anna Berg");
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

  describe("written without its century", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks for the century when the reading flips within a year", () => {
      // The day before 261201-1235 stops reading as 1926 and starts reading
      // as 2026: matched now, the same file would match somebody else later.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, 30, 12));

      const plan = planImport(
        [
          prepared({ ...COMPLETE, personalIdentityNumber: "261201-1235" }),
          prepared(
            { ...COMPLETE, personalIdentityNumber: "19261201-1235" },
            { rowNumber: 2, identityNumberIndex: "pin-index" },
          ),
        ],
        snapshot(),
        DEFAULTS,
      );

      expect(plan.rows[0]?.outcome).toBe("error");
      expect(plan.rows[0]?.problems).toContainEqual({
        field: "personalIdentityNumber",
        reason: "personal-identity-number-needs-century",
      });
      expect(plan.rows[1]?.outcome).toBe("create");
    });
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

  it("applies the move-in date chosen for the file when the row has none", () => {
    const { movedInOn: _ignored, ...withoutMovedIn } = COMPLETE;
    const plan = planImport([prepared(withoutMovedIn)], snapshot(), {
      defaultRole: null,
      defaultMovedInOn: "2019-06-01",
    });

    expect(plan.rows[0]?.movedInOn).toBe("2019-06-01");
    expect(plan.rows[0]?.problems).toEqual([]);
  });

  it("refuses a move-in date for the file that is not on the calendar", () => {
    // The default lands on every row without a date of its own, so it is read
    // by the same parser as a cell rather than rolled over into March.
    const { movedInOn: _ignored, ...withoutMovedIn } = COMPLETE;
    const plan = planImport([prepared(withoutMovedIn)], snapshot(), {
      defaultRole: null,
      defaultMovedInOn: "2026-02-30",
    });

    expect(plan.rows[0]?.movedInOn).toBeNull();
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "date-not-iso",
    });
    expect(plan.rows[0]?.outcome).toBe("error");
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

    // Named rather than counted. A count still passes when one reason is
    // quietly replaced by another, and what this row is here to prove is that
    // the board is told all four faults at once rather than one per attempt.
    expect(plan.rows[0]?.problems).toEqual([
      { field: "fullName", reason: "name-not-splittable" },
      { field: "apartmentNumber", reason: "apartment-not-found" },
      { field: "role", reason: "role-unrecognised" },
      { field: "movedInOn", reason: "date-not-iso" },
    ]);
  });
});

describe("a value that has already lost characters", () => {
  it("refuses the row and names the field, so the board sees it before applying", () => {
    // What a file holds once it has been through a wrong decode somewhere else:
    // the letter is gone from the bytes, and only U+FFFD is left in its place.
    const plan = planImport(
      [prepared({ ...COMPLETE, lastName: "Bj\uFFFDrk" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toEqual([
      { field: "lastName", reason: "garbled-characters" },
    ]);
    expect(plan.summary.error).toBe(1);
  });

  it("gives a garbled field that problem alone", () => {
    // "Medl�m" is also no role anybody knows, but the reason it is not is
    // the lost letter, and that is the one worth reading.
    const plan = planImport(
      [prepared({ ...COMPLETE, role: "Medl�m" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.problems).toEqual([
      { field: "role", reason: "garbled-characters" },
    ]);
  });

  it("leaves Swedish letters that were read correctly alone", () => {
    const plan = planImport(
      [prepared({ ...COMPLETE, firstName: "Åsa", lastName: "Öberg" })],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[0]?.problems).toEqual([]);
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
    // Named although they have no id yet, so the board need not look it up.
    expect(plan.rows[1]?.matchedPersonId).toBeNull();
    expect(plan.rows[1]?.matchedPersonName).toBe("Anna Lindqvist");
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

  it("attaches a second row through the identity number the first one carries", () => {
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
          { rowNumber: 1 },
        ),
        prepared(
          {
            ...COMPLETE,
            apartmentNumber: "1102",
            personalIdentityNumber: PIN_ANNA,
          },
          { rowNumber: 2 },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[1]).toMatchObject({
      outcome: "update",
      matchedBy: "personalIdentityNumber",
      matchedPersonId: null,
      sameAsRowNumber: 1,
    });
  });
});

describe("an identity number an earlier row states without writing it", () => {
  // Anna is in the register with an email address and no identity number. Row
  // 1 reaches her by email, so its number is not written onto her. Row 2 is
  // her second apartment, listed with her number and nothing else to know her
  // by.
  const anna = snapshot({
    personsByEmail: new Map([["anna-index", ["person-anna"]]]),
    personNames: new Map([["person-anna", "Anna Lindqvist"]]),
    residenciesByPerson: new Map([
      ["person-anna", heldAsComplete("apartment-1101")],
    ]),
  });
  const first = prepared(
    { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
    { rowNumber: 1, emailIndex: "anna-index" },
  );
  const second = prepared(
    {
      ...COMPLETE,
      apartmentNumber: "1102",
      personalIdentityNumber: PIN_ANNA,
    },
    { rowNumber: 2 },
  );

  it("reaches the register person the earlier row reached, not a new one", () => {
    const plan = planImport([first, second], anna, DEFAULTS);

    expect(plan.rows[0]).toMatchObject({
      outcome: "update",
      matchedPersonId: "person-anna",
      matchedBy: "email",
    });
    expect(plan.rows[1]).toMatchObject({
      outcome: "update",
      matchedPersonId: "person-anna",
      matchedPersonName: "Anna Lindqvist",
      // Not "personalIdentityNumber": the apply writes the number only onto a
      // person the row reached through it, and Anna does not hold it.
      matchedBy: "earlierRow",
      sameAsRowNumber: 1,
    });
    expect(plan.summary.create).toBe(0);
  });

  it("reaches the person an earlier row creates and a later one gives the number", () => {
    // Row 1 creates Anna without a number. Row 2 reaches her by email with
    // one, which is not written. Row 3 has only the number.
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "anna-index" }),
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
        { ...second, rowNumber: 3 },
      ],
      snapshot(),
      DEFAULTS,
    );

    // Named after row 1 either way, but found under different keys: the apply
    // looks for persons added since the plan under the keys the plan looked
    // under, and no further.
    expect(plan.rows[0]).toMatchObject({
      outcome: "create",
      foundUnder: null,
    });
    expect(plan.rows[1]).toMatchObject({
      outcome: "update",
      matchedBy: "earlierRow",
      foundUnder: "email",
      sameAsRowNumber: 1,
    });
    expect(plan.rows[2]).toMatchObject({
      outcome: "update",
      matchedPersonId: null,
      matchedBy: "earlierRow",
      foundUnder: "personalIdentityNumber",
      sameAsRowNumber: 1,
    });
  });

  it("reaches the same person from a later chunk", () => {
    // The apply plans the second row in a chunk of its own, against a register
    // where Anna still has no number. What the first chunk did not write is
    // passed in.
    const chunk = planImport(
      [{ ...second, rowNumber: 150, identityNumberIndex: "pin-anna-index" }],
      anna,
      DEFAULTS,
      {},
      [
        {
          rowNumber: 1,
          identityNumber: normalizePersonalIdentityNumber(PIN_ANNA) ?? "",
          personId: "person-anna",
        },
      ],
    );

    expect(chunk.rows[0]).toMatchObject({
      outcome: "update",
      matchedPersonId: "person-anna",
      matchedBy: "earlierRow",
      sameAsRowNumber: 1,
    });
  });

  it("names a row decided for the earlier row's person after that row", () => {
    // Between the chunks somebody else was given the number in the register,
    // so the later row matches both of them by it. Chosen for Anna, the row is
    // still not one that reached her through a number she holds.
    const changed = snapshot({
      ...anna,
      personsByIdentityNumber: new Map([["pin-anna-index", ["person-other"]]]),
      personNames: new Map([
        ["person-anna", "Anna Lindqvist"],
        ["person-other", "Annan Person"],
      ]),
      identityNumberIndexByPerson: new Map([
        ["person-other", "pin-anna-index"],
      ]),
    });
    const plan = (personId: string) =>
      planImport(
        [{ ...second, rowNumber: 150, identityNumberIndex: "pin-anna-index" }],
        changed,
        DEFAULTS,
        { "150": { action: "use-person", personId } },
        [
          {
            rowNumber: 1,
            identityNumber: normalizePersonalIdentityNumber(PIN_ANNA) ?? "",
            personId: "person-anna",
          },
        ],
      ).rows[0];

    expect(plan("person-anna")).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "earlierRow",
    });
    expect(plan("person-other")).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "personalIdentityNumber",
    });
  });

  it("waits for a decision when a later row gives the same person another number", () => {
    const plan = planImport(
      [
        first,
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_OTHER },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
      ],
      anna,
      DEFAULTS,
    );

    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "personalIdentityNumber",
      candidates: [{ personId: "person-anna", name: "Anna Lindqvist" }],
    });
  });

  it("does not attach anyone through a number the register person already has another of", () => {
    // Anna holds a number of her own. The board chose her for a row with a
    // different one, and that number is still nobody's.
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_OTHER },
          {
            rowNumber: 1,
            emailIndex: "anna-index",
            identityNumberIndex: "pin-other-index",
          },
        ),
        prepared(
          { ...second.values, personalIdentityNumber: PIN_OTHER },
          { rowNumber: 2, identityNumberIndex: "pin-other-index" },
        ),
      ],
      snapshot({
        ...anna,
        personsByIdentityNumber: new Map([["pin-anna-index", ["person-anna"]]]),
        identityNumberIndexByPerson: new Map([
          ["person-anna", "pin-anna-index"],
        ]),
      }),
      DEFAULTS,
      { "1": { action: "use-person", personId: "person-anna" } },
    );

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[1]?.outcome).toBe("create");
  });
});

describe("a row that contradicts a person an earlier row writes", () => {
  it("waits for a decision when a second row has the first one's email and another name", () => {
    // A household sharing one address: folding the second row into the first
    // would put Bertil's phone number in Anna's record.
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "shared-index" }),
        prepared(
          { ...COMPLETE, firstName: "Bertil", phone: "070-000 00 00" },
          { rowNumber: 2, emailIndex: "shared-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      mismatch: "name",
      matchedBy: "earlierRow",
      sameAsRowNumber: 1,
      matchedPersonId: null,
      // The person does not exist yet, so there is nobody to choose: the row
      // is a person of its own or it is left out.
      candidates: [],
    });
  });

  it("waits for a decision when a second row has the first one's email and another identity number", () => {
    // No identity number in the register, so the preview computes no index:
    // the rows' own numbers are what is compared.
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
          { rowNumber: 1, emailIndex: "shared-index" },
        ),
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_OTHER },
          { rowNumber: 2, emailIndex: "shared-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      mismatch: "personalIdentityNumber",
    });
  });

  it("waits for a decision when a second row has the first one's apartment and name and another identity number", () => {
    // A parent and a child of one name in one apartment, told apart only by
    // their numbers. Folding them into one would put the child's number on
    // nobody and the child's residency on the parent.
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
          { rowNumber: 1 },
        ),
        prepared(
          { ...COMPLETE, personalIdentityNumber: PIN_OTHER },
          { rowNumber: 2 },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      mismatch: "personalIdentityNumber",
      matchedBy: "earlierRow",
      sameAsRowNumber: 1,
      candidates: [],
    });
  });

  it.each([
    {
      mismatch: "name",
      lastRow: { ...COMPLETE, firstName: "Bertil" },
      lastIndex: null,
    },
    {
      mismatch: "personalIdentityNumber",
      lastRow: { ...COMPLETE, personalIdentityNumber: PIN_OTHER },
      lastIndex: "pin-other-index",
    },
  ])(
    "reaches the same answer on a different $mismatch however far apart the two rows are",
    ({ mismatch, lastRow, lastIndex }) => {
      // The apply plans the file a hundred rows at a time against the register
      // the previous chunk left, so row 150 meets row 1's person as a register
      // person. The preview, which plans the whole file at once, has to stop
      // at row 150 too, or the import stops there with the first chunk written.
      const filler = Array.from({ length: 148 }, (_, index) =>
        prepared(
          { ...COMPLETE, movedInOn: "not a date" },
          { rowNumber: index + 2 },
        ),
      );
      const first = prepared(
        { ...COMPLETE, personalIdentityNumber: PIN_ANNA },
        { rowNumber: 1, emailIndex: "shared-index" },
      );

      // The preview, against a register with no identity numbers in it, so no
      // index is computed.
      const preview = planImport(
        [
          first,
          ...filler,
          prepared(lastRow, { rowNumber: 150, emailIndex: "shared-index" }),
        ],
        snapshot(),
        DEFAULTS,
      );
      expect(preview.rows[149]).toMatchObject({
        outcome: "ambiguous",
        mismatch,
        candidates: [],
      });

      // The second chunk, planned against the register after the first, where
      // row 1's person exists and every number is indexed.
      const secondChunk = planImport(
        [
          ...filler.slice(98),
          prepared(lastRow, {
            rowNumber: 150,
            emailIndex: "shared-index",
            identityNumberIndex: lastIndex,
          }),
        ],
        snapshot({
          personsByEmail: new Map([["shared-index", ["person-anna"]]]),
          personsByIdentityNumber: new Map([
            ["pin-anna-index", ["person-anna"]],
          ]),
          identityNumberIndexByPerson: new Map([
            ["person-anna", "pin-anna-index"],
          ]),
          personNames: new Map([["person-anna", "Anna Lindqvist"]]),
          residenciesByPerson: new Map([
            ["person-anna", heldAsComplete("apartment-1101")],
          ]),
        }),
        DEFAULTS,
      );
      expect(secondChunk.rows.at(-1)).toMatchObject({
        outcome: "ambiguous",
        mismatch,
        candidates: [{ personId: "person-anna", name: "Anna Lindqvist" }],
      });
    },
  );

  it("waits for a decision when a row has the address an earlier row gave a register person", () => {
    // Row 1 reaches Anna by apartment and name and gives her an address she
    // did not have. Row 2 is somebody else with that address, and nothing of
    // theirs may be written to Anna.
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "new-index" }),
        prepared(
          { ...COMPLETE, firstName: "Bertil", apartmentNumber: "1102" },
          { rowNumber: 2, emailIndex: "new-index" },
        ),
      ],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-anna"],
          ],
        ]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
        residenciesByPerson: new Map([
          ["person-anna", heldAsComplete("apartment-1101")],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]).toMatchObject({
      outcome: "update",
      matchedPersonId: "person-anna",
      matchedBy: "apartmentAndName",
    });
    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "name",
      matchedPersonId: null,
      candidates: [{ personId: "person-anna", name: "Anna Lindqvist" }],
    });
  });

  it("does not attach a row through an address the matched person will not get", () => {
    // Anna already has an address, so the apply keeps it and row 1's is not
    // written. Row 2 therefore reaches nobody, in the preview as in the apply.
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "other-index" }),
        prepared(
          { ...COMPLETE, firstName: "Bertil", apartmentNumber: "1102" },
          { rowNumber: 2, emailIndex: "other-index" },
        ),
      ],
      snapshot({
        personsByApartmentAndName: new Map([
          [
            apartmentNameKey("apartment-1101", "Anna", "Lindqvist"),
            ["person-anna"],
          ],
        ]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
        personsWithEmail: new Set(["person-anna"]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[1]?.outcome).toBe("create");
  });
});

describe("a row after one the board decided", () => {
  // Row 1 is Anna, and the register holds two of her in her apartment: a
  // parent and a child. Row 2 is Bertil with the address row 1 carries.
  const twins = snapshot({
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
    residenciesByPerson: new Map([
      ["person-a", heldAsComplete("apartment-1101")],
      ["person-b", heldAsComplete("apartment-1101")],
    ]),
  });
  const rows = [
    prepared(COMPLETE, { rowNumber: 1, emailIndex: "anna-index" }),
    prepared(
      { ...COMPLETE, firstName: "Bertil", apartmentNumber: "1102" },
      { rowNumber: 2, emailIndex: "anna-index" },
    ),
  ];

  it("meets the person chosen for it with the row's address", () => {
    // The apply gives person-a row 1's address, and the chunk that meets row 2
    // after that would stop at it. The plan has to find it first.
    const plan = planImport(rows, twins, DEFAULTS, {
      "1": { action: "use-person", personId: "person-a" },
    });

    expect(plan.rows[0]?.outcome).toBe("ambiguous");
    expect(plan.rows[1]).toMatchObject({
      outcome: "ambiguous",
      matchedBy: "email",
      mismatch: "name",
      candidates: [{ personId: "person-a", name: "Anna Lindqvist" }],
    });
  });

  it("meets the person it creates", () => {
    const plan = planImport(
      [
        rows[0] ?? prepared(COMPLETE),
        prepared(COMPLETE, { rowNumber: 2, emailIndex: "anna-index" }),
      ],
      twins,
      DEFAULTS,
      { "1": { action: "create" } },
    );

    // Row 2 is row 1 again, by address and name, and follows it.
    expect(plan.rows[1]).toMatchObject({
      outcome: "update",
      matchedBy: "earlierRow",
      matchedPersonId: null,
      sameAsRowNumber: 1,
    });
  });

  it("does not meet anyone when it is left out", () => {
    const plan = planImport(rows, twins, DEFAULTS, {
      "1": { action: "skip" },
    });

    expect(plan.rows[1]?.outcome).toBe("create");
  });

  it("does not meet a person the row did not match", () => {
    // The apply refuses that decision; the plan does not write it either.
    const plan = planImport(rows, twins, DEFAULTS, {
      "1": { action: "use-person", personId: "person-elsewhere" },
    });

    expect(plan.rows[1]?.outcome).toBe("create");
  });

  it("is planned as before while it is undecided", () => {
    expect(planImport(rows, twins, DEFAULTS).rows[1]?.outcome).toBe("create");
  });

  it("does not meet a person chosen for it whose residencies the row's would overlap", () => {
    // person-a lives in 1101 as a resident, and row 1 makes them a member
    // there from another day. The apply refuses the row as a problem and
    // writes nothing to them, so row 2 does not meet them through the address.
    const plan = planImport(
      rows,
      snapshot({
        ...twins,
        residenciesByPerson: new Map([
          [
            "person-a",
            [
              {
                apartmentId: "apartment-1101",
                role: "RESIDENT",
                movedInOn: "2015-01-01",
                movedOutOn: null,
              },
            ],
          ],
          ["person-b", heldAsComplete("apartment-1101")],
        ]),
      }),
      DEFAULTS,
      { "1": { action: "use-person", personId: "person-a" } },
    );

    expect(plan.rows[1]?.outcome).toBe("create");
  });
});

describe("finding a row the board has not answered for", () => {
  // Rows 1 and 2 of a file of three, as one chunk plans them: row 1 matches two
  // people, row 2 nobody, and row 3 belongs to the next chunk.
  const plan = planImport(
    [
      prepared(COMPLETE),
      prepared({ ...COMPLETE, firstName: "Bo" }, { rowNumber: 2 }),
    ],
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

  it.each<[string, ImportDecisions, ReturnType<typeof findUndecided>]>([
    ["no decision", {}, "ambiguous-rows-undecided"],
    [
      "a person the row did not match",
      { "1": { action: "use-person", personId: "person-c" } },
      "decision-not-a-candidate",
    ],
    [
      "one of its candidates",
      { "1": { action: "use-person", personId: "person-b" } },
      null,
    ],
    ["a new person", { "1": { action: "create" } }, null],
    ["leaving it out", { "1": { action: "skip" } }, null],
    [
      "a decision for a row of another chunk",
      { "1": { action: "skip" }, "3": { action: "skip" } },
      null,
    ],
    [
      "a decision for a row that matched nobody",
      { "1": { action: "skip" }, "2": { action: "skip" } },
      "decision-not-needed",
    ],
    [
      "a decision for a row that matched nobody, before an unanswered one",
      { "2": { action: "create" } },
      "decision-not-needed",
    ],
    [
      "a decision for a row the file does not have",
      { "1": { action: "skip" }, "4": { action: "skip" } },
      "decision-not-needed",
    ],
  ])("answers %s", (_, decisions, expected) => {
    expect(plan.rows.map((row) => row.outcome)).toEqual([
      "ambiguous",
      "create",
    ]);
    expect(findUndecided(plan, decisions, 3)).toBe(expected);
  });
});

describe("one person under different keys", () => {
  it("attaches a row carrying only the email address of an earlier row", () => {
    // Keyed on its first identifier alone, the first row would be found only
    // by its identity number, and the second row would become a second Anna.
    const plan = planImport(
      [
        prepared(
          { ...COMPLETE, personalIdentityNumber: "811228-9874" },
          { rowNumber: 1, emailIndex: "anna-index" },
        ),
        prepared(
          { ...COMPLETE, apartmentNumber: "1102" },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[1]?.outcome).toBe("update");
    expect(plan.rows[1]?.sameAsRowNumber).toBe(1);
  });

  it("matches a row stating its own dates against a residency that has ended", () => {
    const key = apartmentNameKey("apartment-1101", "Anna", "Lindqvist");
    const plan = planImport(
      [prepared({ ...COMPLETE, movedInOn: "2018-03-01" })],
      snapshot({
        personsByApartmentAndNameEver: new Map([[key, ["person-anna"]]]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.matchedPersonId).toBe("person-anna");
  });

  it("does not match the file's default date against a residency that has ended", () => {
    // The default says nothing about when this person lived here, so a
    // namesake who left years ago is not assumed to be them.
    const key = apartmentNameKey("apartment-1101", "Anna", "Lindqvist");
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const plan = planImport(
      [prepared(undated)],
      snapshot({
        personsByApartmentAndNameEver: new Map([[key, ["person-anna"]]]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2024-01-01" },
    );

    expect(plan.rows[0]?.outcome).toBe("create");
  });

  it("does not match the file's default date against a residency an earlier row ended", () => {
    // Row 1 is Anna, a member of 1101 who moved out in 2015. Row 150 is an
    // Anna Lindqvist there now, on the file's default date. A person an
    // earlier row writes is matched by the rules a register person is, so
    // row 150 is a person of their own - a namesake who lives there now is
    // not assumed to be the one who left - and the board sees that in the
    // preview.
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const ended = prepared(
      { ...COMPLETE, movedInOn: "2010-01-01", movedOutOn: "2015-01-01" },
      { rowNumber: 1 },
    );
    const later = prepared(undated, { rowNumber: 150 });
    const defaults = { ...DEFAULTS, defaultMovedInOn: "2024-01-01" };

    const whole = planImport([ended, later], snapshot(), defaults);
    expect(whole.rows.map((row) => row.outcome)).toEqual(["create", "create"]);

    // And the apply's later chunk, against the register the first one left,
    // plans row 150 the same way.
    const key = apartmentNameKey("apartment-1101", "Anna", "Lindqvist");
    const chunk = planImport(
      [later],
      snapshot({
        personsByApartmentAndNameEver: new Map([[key, ["person-anna"]]]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2010-01-01",
                movedOutOn: "2015-01-01",
              },
            ],
          ],
        ]),
      }),
      defaults,
    );
    expect(chunk.rows[0]?.outcome).toBe("create");
  });
});

describe("a residency the person already holds", () => {
  const anna = {
    personsByEmail: new Map([["anna-index", ["person-anna"]]]),
    personNames: new Map([["person-anna", "Anna Lindqvist"]]),
  };

  it("refuses a row giving them a second residency on the same days", () => {
    // Anna lives in 1101 as a resident, and the file says member. Writing
    // nothing while the preview said "update" is what this replaces.
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "RESIDENT",
                movedInOn: "2015-01-01",
                movedOutOn: null,
              },
            ],
          ],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });
  });

  it("takes a residency held exactly as the row states it as already written", () => {
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2019-06-01",
                movedOutOn: null,
              },
            ],
          ],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.problems).toEqual([]);
  });

  it("takes the residency they hold as the one a row without its own date means", () => {
    // Anna has been a member of 1101 since 2015, and the file has no move-in
    // column. The date chosen for the file is not a claim that she moved in on
    // it: the row fills in her details and writes no residency.
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const plan = planImport(
      [prepared(undated, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2015-01-01",
                movedOutOn: null,
              },
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2026-10-01" },
    );

    expect(plan.rows[0]?.outcome).toBe("update");
    expect(plan.rows[0]?.problems).toEqual([]);
    expect(plan.rows[0]?.movedInStated).toBe(false);
  });

  it("still refuses a row without its own date that gives them another role there", () => {
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const plan = planImport(
      [prepared(undated, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "RESIDENT",
                movedInOn: "2015-01-01",
                movedOutOn: null,
              },
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2026-10-01" },
    );

    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });
  });

  it("refuses a row without its own date that ends the residency they hold", () => {
    // Anna has been a member of 1101 since 2015, and the file says she moves
    // out at midsummer. The import does not end a residency, and taking the
    // row as the one she holds would drop the move-out without a word.
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const plan = planImport(
      [
        prepared(
          { ...undated, movedOutOn: "2026-06-30" },
          { emailIndex: "anna-index" },
        ),
      ],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2015-01-01",
                movedOutOn: null,
              },
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2026-01-01" },
    );

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });
  });

  it("refuses a row without its own date that the register says has ended", () => {
    // Anna was a member of 1101 from 2015 to 2024, and the file lists her
    // there with no move-out. The date chosen for the file falls inside that
    // residency, which does not make the row it: no current one would be
    // written.
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const plan = planImport(
      [prepared(undated, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2015-01-01",
                movedOutOn: "2024-01-01",
              },
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2020-01-01" },
    );

    expect(plan.rows[0]?.outcome).toBe("error");
    expect(plan.rows[0]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });
  });

  it("lets them move back in after an earlier residency ended", () => {
    const plan = planImport(
      [prepared(COMPLETE, { emailIndex: "anna-index" })],
      snapshot({
        ...anna,
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2010-01-01",
                movedOutOn: "2015-01-01",
              },
            ],
          ],
        ]),
      }),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("update");
  });

  it("finds them among current residents once a row moves them back in", () => {
    // The register knows Anna only from a residency that has ended, so a row
    // carrying the file's default date cannot reach her by name. Row 1 states
    // its own date and moves her back in; the apply writes that, and the chunk
    // after it finds her by name. Row 2 has to find her the same way, or the
    // preview shows a new person the apply then does not create.
    const { movedInOn: _movedInOn, ...undated } = COMPLETE;
    const key = apartmentNameKey("apartment-1101", "Anna", "Lindqvist");
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1 }),
        prepared(undated, { rowNumber: 2 }),
      ],
      snapshot({
        personsByApartmentAndNameEver: new Map([[key, ["person-anna"]]]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2010-01-01",
                movedOutOn: "2015-01-01",
              },
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2024-01-01" },
    );

    expect(plan.rows.map((row) => [row.outcome, row.matchedPersonId])).toEqual([
      ["update", "person-anna"],
      ["update", "person-anna"],
    ]);

    // The apply's next chunk, against the register holding what row 1 wrote.
    const chunk = planImport(
      [prepared(undated, { rowNumber: 2 })],
      snapshot({
        personsByApartmentAndName: new Map([[key, ["person-anna"]]]),
        personNames: new Map([["person-anna", "Anna Lindqvist"]]),
        residenciesByPerson: new Map([
          [
            "person-anna",
            [
              {
                apartmentId: "apartment-1101",
                role: "MEMBER",
                movedInOn: "2010-01-01",
                movedOutOn: "2015-01-01",
              },
              ...heldAsComplete("apartment-1101"),
            ],
          ],
        ]),
      }),
      { ...DEFAULTS, defaultMovedInOn: "2024-01-01" },
    );
    expect(chunk.rows.map((row) => [row.outcome, row.matchedPersonId])).toEqual(
      [["update", "person-anna"]],
    );
  });

  it("refuses a second row of the file giving one person overlapping residencies", () => {
    const plan = planImport(
      [
        prepared(COMPLETE, { rowNumber: 1, emailIndex: "anna-index" }),
        prepared(
          { ...COMPLETE, role: "Boende", movedInOn: "2020-01-01" },
          { rowNumber: 2, emailIndex: "anna-index" },
        ),
      ],
      snapshot(),
      DEFAULTS,
    );

    expect(plan.rows[0]?.outcome).toBe("create");
    expect(plan.rows[1]?.outcome).toBe("error");
    expect(plan.rows[1]?.problems).toContainEqual({
      field: "movedInOn",
      reason: "residency-conflict",
    });
  });
});

describe("a row the preview asked about, planned again", () => {
  // The same chunk: row 1 now matches person-a and person-b, row 2 nobody. The
  // board answered row 1 by the persons the preview listed for it.
  const plan = planImport(
    [
      prepared(COMPLETE),
      prepared({ ...COMPLETE, firstName: "Bo" }, { rowNumber: 2 }),
    ],
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

  it.each<[string, PreviewedCandidates, readonly string[], boolean]>([
    ["the same persons", { "1": ["person-b", "person-a"] }, [], false],
    [
      // Added since the preview: the board never chose against them.
      "one more person",
      { "1": ["person-a"] },
      [],
      true,
    ],
    [
      // Created by an earlier chunk, so the preview could not list them.
      "one more person the apply created",
      { "1": ["person-a"] },
      ["person-b"],
      false,
    ],
    [
      "one person fewer",
      { "1": ["person-a", "person-b", "person-c"] },
      [],
      true,
    ],
    [
      "a row that no longer asks",
      { "1": ["person-a", "person-b"], "2": [] },
      [],
      true,
    ],
    [
      "a row of another chunk",
      { "1": ["person-a", "person-b"], "3": ["person-c"] },
      [],
      false,
    ],
  ])("tells %s", (_, previewed, createdByApply, expected) => {
    expect(
      changedSincePreview(plan, previewed, {}, new Set(createdByApply)),
    ).toBe(expected);
  });
});

describe("a decided row planned again", () => {
  // Row 1 is Anna of 1101, and the register held two of her when the preview
  // asked about the row. A third moves in after the board decided.
  const annaKey = apartmentNameKey("apartment-1101", "Anna", "Lindqvist");
  const names = new Map([
    ["person-a", "Anna Lindqvist"],
    ["person-b", "Anna Lindqvist"],
    ["person-c", "Anna Lindqvist"],
  ]);
  const previewed: PreviewedCandidates = { "1": ["person-a", "person-b"] };

  function changed(
    annas: readonly string[],
    decisions: ImportDecisions,
    asked: PreviewedCandidates = previewed,
  ): boolean {
    const plan = planImport(
      [prepared(COMPLETE)],
      snapshot({
        personsByApartmentAndName: new Map([[annaKey, [...annas]]]),
        personNames: names,
      }),
      DEFAULTS,
      decisions,
    );
    return changedSincePreview(plan, asked, decisions);
  }

  const create: ImportDecisions = { "1": { action: "create" } };
  const choose: ImportDecisions = {
    "1": { action: "use-person", personId: "person-a" },
  };
  const skip: ImportDecisions = { "1": { action: "skip" } };

  it.each([
    ["a new person", create],
    ["a chosen one", choose],
  ])(
    "holds a decision for %s while the candidates are the same",
    (_, decisions) => {
      expect(changed(["person-b", "person-a"], decisions)).toBe(false);
    },
  );

  it.each([
    ["a new person", create, true],
    ["a chosen one", choose, true],
    // It writes nothing, whoever it matches.
    ["leaving it out", skip, false],
  ])("finds somebody who joined them, for %s", (_, decisions, expected) => {
    expect(changed(["person-a", "person-b", "person-c"], decisions)).toBe(
      expected,
    );
  });

  it("counts a row decided to be written that the preview did not ask about as changed", () => {
    expect(changed(["person-a", "person-b"], create, {})).toBe(true);
    // One left undecided is the undecided rule's to refuse.
    expect(changed(["person-a", "person-b"], {}, {})).toBe(false);
  });

  it("knows a person an earlier chunk created for the row", () => {
    // Rows 1 and 2 are both an Anna of 1101, and the board made row 1 a new
    // person. The preview could not list that person for row 2, having no id
    // for them; the second chunk finds them in the register, as person-new.
    const decisions: ImportDecisions = {
      "1": { action: "create" },
      "2": { action: "use-person", personId: "person-a" },
    };
    const secondChunk = planImport(
      [prepared(COMPLETE, { rowNumber: 2 })],
      snapshot({
        personsByApartmentAndName: new Map([
          [annaKey, ["person-a", "person-b", "person-new"]],
        ]),
        personNames: new Map([...names, ["person-new", "Anna Lindqvist"]]),
      }),
      DEFAULTS,
      decisions,
    );
    const asked: PreviewedCandidates = { "2": ["person-a", "person-b"] };

    expect(
      changedSincePreview(
        secondChunk,
        asked,
        decisions,
        new Set(["person-new"]),
      ),
    ).toBe(false);
    // Without knowing who the apply created, person-new is a stranger.
    expect(changedSincePreview(secondChunk, asked, decisions)).toBe(true);
  });
});
