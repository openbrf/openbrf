import { describe, expect, it } from "vite-plus/test";

import {
  registerReportSchema,
  renderRegisterReport,
  type ReportSource,
  type ReportSourcePerson,
} from "./register-report-content";

/**
 * What a report to the cooperative housing register carries, and when it is
 * refused rather than sent short. ADR 0029.
 *
 * Every rendered report is also parsed with the schema an adapter maps from, so
 * a renderer that produced something the contract does not allow fails here and
 * not against Lantmäteriet.
 */

const NOW = new Date("2026-10-19T10:00:00.000Z");

function column(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const holder: ReportSourcePerson = {
  id: "person-holder",
  firstName: "Mira",
  lastName: "Ek",
  postalStreet: "Aspgatan 7",
  postalCode: "11144",
  postalCity: "Stockholm",
  protectedPersonalData: false,
  personalIdentityNumber: "19811218-9876",
};

function source(overrides: Partial<ReportSource>): ReportSource {
  return {
    obligationId: "obligation-1",
    kind: "TERMINATION",
    association: { name: " Brf Talgoxen ", organizationNumber: "769600-0101" },
    apartment: {
      number: "1101",
      address: {
        street: "Aspgatan",
        number: "7",
        postalCode: "11144",
        city: "Stockholm",
      },
    },
    transfer: null,
    termination: null,
    reversal: null,
    ...overrides,
  };
}

function rendered(input: ReportSource) {
  const result = renderRegisterReport(input, NOW);
  if (!result.ok) {
    throw new Error(`expected a report, got ${result.problem}`);
  }
  expect(registerReportSchema.safeParse(result.report).success).toBe(true);
  return result;
}

describe("what every report carries", () => {
  it("names the association, the apartment and the platform's own reference", () => {
    const result = rendered(
      source({
        termination: {
          tookEffectOn: column("2026-10-01"),
          kind: "GENERAL_MEETING_DECISION",
        },
      }),
    );

    expect(result.report.reference).toBe("obligation-1");
    expect(result.report.association).toEqual({
      name: "Brf Talgoxen",
      organizationNumber: "769600-0101",
    });
    expect(result.report.apartment).toEqual({
      number: "1101",
      street: "Aspgatan",
      streetNumber: "7",
      postalCode: "11144",
      city: "Stockholm",
    });
  });
});

describe("a termination", () => {
  it("states the day and the ground and names nobody", () => {
    const result = rendered(
      source({
        termination: {
          tookEffectOn: column("2026-10-01"),
          kind: "BUILDING_TRANSFERRED",
        },
      }),
    );

    expect(result.report.event).toEqual({
      kind: "TERMINATION",
      tookEffectOn: "2026-10-01",
      ground: "BUILDING_TRANSFERRED",
    });
    expect(result.personIds).toEqual([]);
  });
});

describe("a grant", () => {
  it("names the holder with the number in its twelve-digit form", () => {
    const result = rendered(
      source({
        kind: "GRANT",
        transfer: {
          transferredOn: column("2026-10-05"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: holder,
        },
      }),
    );

    expect(result.report.event).toEqual({
      kind: "GRANT",
      grantedOn: "2026-10-05",
      holder: {
        kind: "PERSON",
        name: "Mira Ek",
        personalIdentityNumber: "198112189876",
        postalAddress: {
          street: "Aspgatan 7",
          postalCode: "11144",
          city: "Stockholm",
        },
        protectedPersonalData: false,
      },
    });
    expect(result.personIds).toEqual(["person-holder"]);
    expect(result.protectedPersonIds).toEqual([]);
  });

  it("withholds a protected holder's address and says why", () => {
    /*
     * The initial supply's rule, unchanged: the name and the number identify
     * the holder in a register keyed on them, and Lantmäteriet holds the address
     * through Skatteverket, where the protection is administered.
     */
    const result = rendered(
      source({
        kind: "GRANT",
        transfer: {
          transferredOn: column("2026-10-05"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: { ...holder, protectedPersonalData: true },
        },
      }),
    );

    expect(result.report.event).toMatchObject({
      holder: { postalAddress: null, protectedPersonalData: true },
    });
    expect(result.protectedPersonIds).toEqual(["person-holder"]);
  });

  it("is refused where the holder has no personal identity number", () => {
    const result = renderRegisterReport(
      source({
        kind: "GRANT",
        transfer: {
          transferredOn: column("2026-10-05"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: { ...holder, personalIdentityNumber: null },
        },
      }),
      NOW,
    );

    expect(result).toEqual({
      ok: false,
      problem: "holder-identity-number-missing",
    });
  });

  it("is refused where the stored number cannot be read as one", () => {
    const result = renderRegisterReport(
      source({
        kind: "GRANT",
        transfer: {
          transferredOn: column("2026-10-05"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: { ...holder, personalIdentityNumber: "not a number" },
        },
      }),
      NOW,
    );

    expect(result).toEqual({
      ok: false,
      problem: "holder-identity-number-invalid",
    });
  });
});

describe("a transfer", () => {
  it("carries its case and the membership decision that dated it", () => {
    const result = rendered(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: "MEMBERSHIP_DECISION",
          membershipDecidedOn: column("2026-09-20"),
          toPerson: holder,
        },
      }),
    );

    expect(result.report.event).toMatchObject({
      kind: "TRANSFER",
      transferredOn: "2026-09-01",
      reportBasis: "MEMBERSHIP_DECISION",
      membershipDecidedOn: "2026-09-20",
      acquirer: { kind: "PERSON", personalIdentityNumber: "198112189876" },
    });
  });

  it("carries no decision date in a case that has none", () => {
    const result = rendered(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: "ALREADY_MEMBER",
          membershipDecidedOn: null,
          toPerson: holder,
        },
      }),
    );

    expect(result.report.event).toMatchObject({
      reportBasis: "ALREADY_MEMBER",
      membershipDecidedOn: null,
    });
  });

  it("names the association and no person where the bostadsrätt passed to it", () => {
    const result = rendered(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: "TO_THE_ASSOCIATION",
          membershipDecidedOn: null,
          toPerson: holder,
        },
      }),
    );

    expect(result.report.event).toMatchObject({
      reportBasis: "TO_THE_ASSOCIATION",
      acquirer: { kind: "ASSOCIATION" },
    });
    expect(result.personIds).toEqual([]);
  });

  it("states the first case for a decision recorded before the case was asked", () => {
    /*
     * Its duty was entered on the decision's day, which is the first case's,
     * and recordReportBasis refuses to state a case afterwards. Refusing the
     * report as well would leave the duty with no way to be sent.
     */
    const result = rendered(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: null,
          membershipDecidedOn: column("2026-09-20"),
          toPerson: holder,
        },
      }),
    );

    expect(result.report.event).toMatchObject({
      reportBasis: "MEMBERSHIP_DECISION",
      membershipDecidedOn: "2026-09-20",
    });
  });

  it("is refused where no case can be stated", () => {
    const result = renderRegisterReport(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: holder,
        },
      }),
      NOW,
    );

    expect(result).toEqual({ ok: false, problem: "transfer-case-not-stated" });
  });
});

describe("a transfer reversal", () => {
  it("states its day, its ground and the övergång it undid, and names nobody", () => {
    const result = rendered(
      source({
        kind: "TRANSFER_REVERSAL",
        reversal: {
          reversedOn: column("2026-10-10"),
          kind: "RETURNED_TO_SELLER",
          transferredOn: column("2026-09-01"),
        },
      }),
    );

    expect(result.report.event).toEqual({
      kind: "TRANSFER_REVERSAL",
      reversedOn: "2026-10-10",
      ground: "RETURNED_TO_SELLER",
      transferredOn: "2026-09-01",
    });
    expect(result.personIds).toEqual([]);
  });
});

describe("an association that cannot be identified", () => {
  it("is refused before anything is rendered where it is not set up", () => {
    expect(renderRegisterReport(source({ association: null }), NOW)).toEqual({
      ok: false,
      problem: "association-not-set-up",
    });
  });

  it("is refused where it has no organisation number", () => {
    /*
     * Förordning (2026:898) 3 kap. 1 § makes the organisationsnummer one of the
     * terms the register is searched by, so a report without it names an
     * association the register cannot key on.
     */
    expect(
      renderRegisterReport(
        source({
          association: { name: "Brf Talgoxen", organizationNumber: "  " },
        }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      problem: "association-organization-number-missing",
    });
  });
});

describe("the schema an adapter maps from", () => {
  it("refuses a protected person's address", () => {
    const result = rendered(
      source({
        kind: "GRANT",
        transfer: {
          transferredOn: column("2026-10-05"),
          reportBasis: null,
          membershipDecidedOn: null,
          toPerson: { ...holder, protectedPersonalData: true },
        },
      }),
    );
    const leaked = structuredClone(result.report);
    if (leaked.event.kind !== "GRANT") {
      throw new Error("expected a grant");
    }
    leaked.event.holder.postalAddress = {
      street: "Aspgatan 7",
      postalCode: "11144",
      city: "Stockholm",
    };

    expect(registerReportSchema.safeParse(leaked).success).toBe(false);
  });

  it("refuses a decision date on a case that has none", () => {
    const result = rendered(
      source({
        kind: "TRANSFER",
        transfer: {
          transferredOn: column("2026-09-01"),
          reportBasis: "ALREADY_MEMBER",
          membershipDecidedOn: null,
          toPerson: holder,
        },
      }),
    );

    expect(
      registerReportSchema.safeParse({
        ...result.report,
        event: { ...result.report.event, membershipDecidedOn: "2026-09-20" },
      }).success,
    ).toBe(false);
  });
});
