import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Proves the statutory archive guards from application code, against a real
 * PostgreSQL instance.
 *
 * The plan requires these to hold at the database level rather than only in
 * services (decision 21): a bug in an admin screen must be incapable of
 * destroying the member register, because EFL 5 kap. via BRL 9 kap. requires
 * it to be retained. A test that mocked the database would prove nothing here.
 *
 * Two mechanisms guard the statutory tier and neither is sufficient alone. The
 * triggers, exercised as the schema owner in the suites below, stop every
 * caller. The revoked privileges in prisma/sql/harden-runtime-role.sql stop the
 * application role, which is the half that survives an
 * ALTER TABLE ... DISABLE TRIGGER - and the owner can run that, which is why
 * the application is deliberately not the owner. The last suite in this file
 * covers that half, by running the REVOKE lines out of that file against a role
 * of its own, so a statutory table added without its line is a failure here
 * rather than a discovery in production.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaClient;

/** Distinct per run so a failed run never collides with the next one. */
const suffix = process.hrtime.bigint().toString(36);
const id = (name: string): string => `guard-${name}-${suffix}`;

const PERSON_ID = id("person");
/** Named by the audit log and nothing else, so it can be erased. */
const ERASED_PERSON_ID = id("erased");
const ADDRESS_ID = id("address");
const APARTMENT_ID = id("apartment");
/** A second apartment, so "the wrong apartment" is a real id and not a typo. */
const OTHER_APARTMENT_ID = id("other-apartment");
const ENTRY_ID = id("entry");
const AUDIT_ID = id("audit");
const ERASED_AUDIT_ID = id("erased-audit");
const TRANSFER_ID = id("transfer");
const LIEN_ID = id("lien");
const TERMINATION_ID = id("termination");
const OBLIGATION_ID = id("obligation");
/**
 * A second termination, so the privilege suite has an event with no obligation
 * of its own to append one to. One anmalan per event is a unique constraint, so
 * the insert that proves the application may still record a deadline cannot
 * reuse the row the assertions above it are about.
 */
const PROBE_TERMINATION_ID = id("probe-termination");
/**
 * A transfer with no membership decision recorded.
 *
 * The state Lag (2026:484) 3 kap. 3 § andra stycket names no day to count from,
 * so it may take no deadline at all - which is what
 * register_report_obligation_matches_its_event refuses.
 */
const UNDECIDED_TRANSFER_ID = id("undecided-transfer");
/** An upplatelse, whose window opens on the day of the grant itself. */
const GRANT_TRANSFER_ID = id("granted-transfer");
/**
 * An overgang the board has stated is the association's, so a case can be
 * refused a second one - and one whose acquirer reports it themselves, so the
 * ledger can be asked for a row it must never hold.
 */
const CASED_TRANSFER_ID = id("cased-transfer");
const ELSEWHERE_TRANSFER_ID = id("elsewhere-transfer");
/** A registered overlatelse recorded as having gone back to the seller. */
const REVERSAL_ID = id("reversal");
const REVERSED_TRANSFER_ID = id("reversed-transfer");

/**
 * A role for the privilege suite, made per run.
 *
 * Roles are cluster-wide while the test databases are per worker, so the name
 * carries the run's suffix: two workers provisioned at the same moment must not
 * be creating and dropping one role. Underscored because an identifier with a
 * hyphen would have to be quoted in every statement that names it.
 */
const PROBE_ROLE = `openbrf_guard_${suffix.replace(/[^a-z0-9]/gi, "")}`;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  await prisma.person.create({
    data: { id: PERSON_ID, firstName: "Anna", lastName: "Lindqvist" },
  });
  await prisma.address.create({
    data: {
      id: ADDRESS_ID,
      street: "Storgatan",
      number: `12-${suffix}`,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: APARTMENT_ID, addressId: ADDRESS_ID, number: "1001", floor: 0 },
  });
  await prisma.apartment.create({
    data: {
      id: OTHER_APARTMENT_ID,
      addressId: ADDRESS_ID,
      number: "1002",
      floor: 0,
    },
  });
  await prisma.memberRegisterEntry.create({
    data: {
      id: ENTRY_ID,
      personId: PERSON_ID,
      apartmentId: APARTMENT_ID,
      eventType: "ENTRY",
      eventOn: new Date("2019-06-01"),
      recordedFirstName: "Anna",
      recordedLastName: "Lindqvist",
    },
  });
  await prisma.auditLogEntry.create({
    data: { id: AUDIT_ID, action: "DATA_EXPORTED", actorPersonId: PERSON_ID },
  });
  await prisma.person.create({
    data: { id: ERASED_PERSON_ID, firstName: "Erik", lastName: "Borttagen" },
  });
  await prisma.auditLogEntry.create({
    data: {
      id: ERASED_AUDIT_ID,
      action: "DATA_EXPORTED",
      actorPersonId: ERASED_PERSON_ID,
      targetPersonId: ERASED_PERSON_ID,
    },
  });
  await prisma.transfer.create({
    data: {
      id: TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      // An overgang: it carries a membership decision, which an upplatelse
      // never takes.
      kind: "TRANSFER",
      toPersonId: PERSON_ID,
      transferredOn: new Date("2019-06-01"),
      /*
       * Before the transfer, which is the ordinary order: the board approves
       * membership when it meets and the transfer completes on the
       * tilltradesdag. Recorded because the obligation suite below appends a
       * deadline to this transfer, and
       * register_report_obligation_matches_its_event refuses one on a transfer
       * with no membership decision - Lag (2026:484) 3 kap. 3 § andra stycket
       * names no day to count from without it.
       */
      membershipDecidedOn: new Date("2019-05-20"),
      // Required by transfer_agreement_reference_present: the apartment
      // register extract states a reference for every transfer it lists.
      agreementReference: `Upplatelseavtal ${TRANSFER_ID}`,
    },
  });
  await prisma.transfer.create({
    data: {
      id: UNDECIDED_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "TRANSFER",
      fromPersonId: PERSON_ID,
      toPersonId: PERSON_ID,
      transferredOn: new Date("2022-03-01"),
      agreementReference: `Overlatelseavtal ${UNDECIDED_TRANSFER_ID}`,
    },
  });
  await prisma.transfer.create({
    data: {
      id: GRANT_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "GRANT",
      toPersonId: PERSON_ID,
      transferredOn: new Date("2022-01-15"),
      agreementReference: `Upplatelseavtal ${GRANT_TRANSFER_ID}`,
    },
  });
  await prisma.lienNote.create({
    data: {
      id: LIEN_ID,
      apartmentId: APARTMENT_ID,
      creditor: "Bank AB",
      notedOn: new Date("2020-01-01"),
    },
  });
  await prisma.termination.create({
    data: {
      id: TERMINATION_ID,
      apartmentId: APARTMENT_ID,
      kind: "GENERAL_MEETING_DECISION",
      // Required by termination_reference_present: a termination states what
      // shows it, and a value of whitespace is not a reference.
      reference: `Stammoprotokoll ${TERMINATION_ID}`,
      tookEffectOn: new Date("2026-04-01"),
    },
  });
  await prisma.termination.create({
    data: {
      id: PROBE_TERMINATION_ID,
      apartmentId: APARTMENT_ID,
      kind: "BUILDING_TRANSFERRED",
      reference: `Kopeavtal ${PROBE_TERMINATION_ID}`,
      tookEffectOn: new Date("2026-04-08"),
    },
  });
  await prisma.transfer.create({
    data: {
      id: CASED_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "TRANSFER",
      toPersonId: PERSON_ID,
      transferredOn: new Date("2023-03-01"),
      // Andra stycket's second sentence: no membership decision, and the window
      // runs from the overgang.
      reportBasis: "ALREADY_MEMBER",
      agreementReference: `Overlatelseavtal ${CASED_TRANSFER_ID}`,
    },
  });
  await prisma.transfer.create({
    data: {
      id: ELSEWHERE_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "TRANSFER",
      toPersonId: PERSON_ID,
      transferredOn: new Date("2023-04-01"),
      // Forsta stycket's second sentence: the anmalan is the juridical person's,
      // so the association's ledger may hold no row about it at all.
      reportBasis: "LIENHOLDING_JURIDICAL_PERSON",
      agreementReference: `Overlatelseavtal ${ELSEWHERE_TRANSFER_ID}`,
    },
  });
  await prisma.transfer.create({
    data: {
      id: REVERSED_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "TRANSFER",
      toPersonId: PERSON_ID,
      transferredOn: new Date("2023-05-01"),
      agreementReference: `Overlatelseavtal ${REVERSED_TRANSFER_ID}`,
    },
  });
  await prisma.transferReversal.create({
    data: {
      id: REVERSAL_ID,
      transferId: REVERSED_TRANSFER_ID,
      apartmentId: APARTMENT_ID,
      kind: "RETURNED_TO_SELLER",
      reversedOn: new Date("2023-07-02"),
      reference: `Aterganget avtal ${REVERSAL_ID}`,
    },
  });
  await prisma.registerReportObligation.create({
    data: {
      id: OBLIGATION_ID,
      kind: "TERMINATION",
      apartmentId: APARTMENT_ID,
      terminationId: TERMINATION_ID,
      triggeredOn: new Date("2026-04-01"),
      // Fourteen days on, which register_report_obligation_two_week_window
      // requires: Lag (2026:484) 3 kap. 4 § gives two weeks from the day the
      // bostadsratt ceased.
      dueOn: new Date("2026-04-15"),
    },
  });

  /*
   * The role the privilege suite runs as, and the grants the hardening script
   * hands out before it takes any back. NOLOGIN: the suite reaches it with SET
   * ROLE on this connection rather than by connecting, so there is no password
   * to invent and nothing that could be logged into afterwards.
   *
   * Granted to the session user because SET ROLE requires membership. This
   * suite connects as the schema owner, which in the local container is a
   * superuser - and a superuser bypasses every privilege check, which is
   * exactly why the assertions below run under SET ROLE and not as the session
   * user.
   */
  await prisma.$executeRawUnsafe(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
  await prisma.$executeRawUnsafe(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
  await prisma.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`,
  );
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`,
  );
  for (const statement of statutoryRevokes()) {
    await prisma.$executeRawUnsafe(statement);
  }
});

/**
 * The REVOKE statements out of prisma/sql/harden-runtime-role.sql, retargeted
 * at this suite's own role.
 *
 * Lifted from the file rather than restated here, which is the whole point: a
 * statutory table added without its REVOKE line has no line to lift, so the
 * assertions below find the role still able to rewrite it. Restating the list
 * in this file would test the copy instead of the script.
 *
 * Only the single-table REVOKEs on public are taken. The script also revokes
 * TRUNCATE across the whole schema and CREATE on it, which are not per-table
 * statements and are covered by the runtime-role e2e suite against the role the
 * deployment really creates.
 */
function statutoryRevokes(): string[] {
  const script = readFileSync(
    join(process.cwd(), "prisma", "sql", "harden-runtime-role.sql"),
    "utf8",
  );
  const statements = [
    ...script.matchAll(
      /^REVOKE (UPDATE, DELETE|DELETE|UPDATE) ON public\."(\w+)" FROM openbrf_app;$/gm,
    ),
  ].map(
    (match) => `REVOKE ${match[1]} ON public."${match[2]}" FROM ${PROBE_ROLE}`,
  );

  if (statements.length === 0) {
    throw new Error(
      "No per-table REVOKE statements were found in harden-runtime-role.sql. " +
        "Either the script changed shape or the statutory tables lost their " +
        "privilege guard; both need looking at rather than a green test.",
    );
  }
  return statements;
}

afterAll(async () => {
  // Cleanup has to disable the very triggers under test, which is only
  // possible because the test connects as the schema owner. In production the
  // application uses a non-owner role precisely so this is impossible
  // (prisma/sql/harden-runtime-role.sql).
  const triggers = [
    ["member_register_entry", "member_register_entry_append_only"],
    ["audit_log_entry", "audit_log_entry_append_only"],
    ["transfer", "transfer_no_delete"],
    ["lien_note", "lien_note_no_delete"],
    ["termination", "termination_append_only"],
    ["transfer_reversal", "transfer_reversal_append_only"],
    ["register_report_obligation", "register_report_obligation_append_only"],
  ] as const;

  for (const [table, trigger] of triggers) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`,
    );
  }

  try {
    await prisma.memberRegisterEntry.deleteMany({
      where: { personId: PERSON_ID },
    });
    await prisma.auditLogEntry.deleteMany({
      where: { actorPersonId: { in: [PERSON_ID, ERASED_PERSON_ID] } },
    });
    await prisma.lienNote.deleteMany({ where: { apartmentId: APARTMENT_ID } });
    // Before the events it points at: every reference it carries is RESTRICT,
    // so a transfer or a termination with a deadline against it cannot go
    // first.
    await prisma.registerReportObligation.deleteMany({
      where: { apartmentId: APARTMENT_ID },
    });
    // Before the transfers, for the same reason: the reference is RESTRICT.
    await prisma.transferReversal.deleteMany({
      where: { apartmentId: APARTMENT_ID },
    });
    await prisma.transfer.deleteMany({ where: { apartmentId: APARTMENT_ID } });
    await prisma.termination.deleteMany({
      where: { apartmentId: APARTMENT_ID },
    });
    await prisma.apartment.deleteMany({
      where: { id: { in: [APARTMENT_ID, OTHER_APARTMENT_ID] } },
    });
    await prisma.address.deleteMany({ where: { id: ADDRESS_ID } });
    await prisma.person.deleteMany({
      where: { id: { in: [PERSON_ID, ERASED_PERSON_ID] } },
    });
    // Only ever present if the singleton check regressed and the test below
    // managed to insert it. Leaving it behind would break every later suite
    // that assumes one association.
    await prisma.association.deleteMany({ where: { id: 2 } });
  } finally {
    // A failed delete must not leave the guards off: they would stay disabled
    // for every later suite and for the developer's local database, removing
    // the protection this suite exists to prove.
    for (const [table, trigger] of triggers) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`,
      );
    }
    // DROP OWNED BY first: a role holding a privilege on any object cannot be
    // dropped, and the suite below grants it privileges on every table in the
    // schema. Left behind, the role would accumulate one per run in a cluster
    // that is shared with every other worker.
    await prisma.$executeRawUnsafe(`DROP OWNED BY ${PROBE_ROLE}`);
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await prisma.$disconnect();
  }
});

describe("member register (medlemsforteckning)", () => {
  it("refuses an update", async () => {
    await expect(
      prisma.memberRegisterEntry.update({
        where: { id: ENTRY_ID },
        data: { recordedLastName: "Tampered" },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a delete", async () => {
    await expect(
      prisma.memberRegisterEntry.delete({ where: { id: ENTRY_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a truncate, which row triggers alone would not catch", async () => {
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE "member_register_entry"'),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("still accepts a correction, which is a new row rather than an edit", async () => {
    const correction = await prisma.memberRegisterEntry.create({
      data: {
        id: id("correction"),
        personId: PERSON_ID,
        apartmentId: APARTMENT_ID,
        eventType: "CORRECTION",
        eventOn: new Date("2019-06-01"),
        recordedFirstName: "Anna",
        recordedLastName: "Lindquist",
        correctsEntryId: ENTRY_ID,
        note: "Surname misspelled in the original entry",
      },
    });

    expect(correction.correctsEntryId).toBe(ENTRY_ID);

    // The superseded entry is untouched, which is the whole point of
    // correcting by appending.
    const original = await prisma.memberRegisterEntry.findUniqueOrThrow({
      where: { id: ENTRY_ID },
    });
    expect(original.recordedLastName).toBe("Lindqvist");
  });
});

describe("audit log", () => {
  it("refuses a delete, because the log is evidence", async () => {
    await expect(
      prisma.auditLogEntry.delete({ where: { id: AUDIT_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses an update", async () => {
    await expect(
      prisma.auditLogEntry.update({
        where: { id: AUDIT_ID },
        data: { action: "SYSTEM_ROLE_GRANTED" },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("does not block erasing a person it names, and keeps naming them", async () => {
    // The actor and target columns carry no foreign key precisely because of
    // this case. ON DELETE SET NULL performs an UPDATE, which the trigger
    // above rejects, so the delete below would fail outright; ON DELETE
    // RESTRICT would let the log veto erasure altogether. Neither is
    // acceptable for a register that has to honour an erasure request.
    await prisma.person.delete({ where: { id: ERASED_PERSON_ID } });

    const entry = await prisma.auditLogEntry.findUniqueOrThrow({
      where: { id: ERASED_AUDIT_ID },
    });
    // The log is evidence: it keeps the id that acted, even though the person
    // is gone.
    expect(entry.actorPersonId).toBe(ERASED_PERSON_ID);
    expect(entry.targetPersonId).toBe(ERASED_PERSON_ID);
  });
});

describe("apartment register (lagenhetsforteckning)", () => {
  it("refuses to delete a transfer", async () => {
    await expect(
      prisma.transfer.delete({ where: { id: TRANSFER_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses to delete a lien note", async () => {
    await expect(
      prisma.lienNote.delete({ where: { id: LIEN_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("allows releasing a lien, which is an update rather than a deletion", async () => {
    const released = await prisma.lienNote.update({
      where: { id: LIEN_ID },
      data: { releasedOn: new Date("2026-01-15") },
    });

    expect(released.releasedOn).toEqual(new Date("2026-01-15"));
  });
});

describe("termination (upphorande)", () => {
  it("refuses an update, unlike a transfer or a lien note", async () => {
    // Stricter than the two tables above it on purpose. A lien note is
    // released and a mis-keyed transfer corrected, so both keep UPDATE; a
    // tenant-ownership that has ceased has no later state to reach.
    await expect(
      prisma.termination.update({
        where: { id: TERMINATION_ID },
        data: { tookEffectOn: new Date("2020-01-01") },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a delete", async () => {
    await expect(
      prisma.termination.delete({ where: { id: TERMINATION_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a truncate, which row triggers alone would not catch", async () => {
    /*
     * Both tables in one statement, because register_report_obligation
     * references this one. PostgreSQL refuses to truncate a table referenced by
     * a foreign key unless the referencing table is truncated with it, and it
     * does so with 0A000 before any statement-level trigger fires - so
     * `TRUNCATE TABLE "termination"` alone would pass this test on a database
     * where the guard had been dropped. This is the form somebody emptying the
     * archive would have to use, and it is the form the guard has to stop.
     *
     * The table is named in the expected message, and this table is named first
     * in the statement, because both tables carry a guard of their own: matching
     * the marker alone would let the ledger's guard answer for this one, and the
     * test would stay green with this table's guard gone.
     */
    await expect(
      prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "termination", "register_report_obligation"',
      ),
    ).rejects.toThrow(
      /OPENBRF_STATUTORY_ARCHIVE: TRUNCATE is not permitted on termination/,
    );
  });

  it("refuses to lose the apartment it was about", async () => {
    // Restrict rather than SetNull: a row saying a tenant-ownership ceased,
    // with no apartment, is not a shorter record but a false one. SetNull would
    // also be an UPDATE, which the trigger above rejects, so the delete would
    // fail either way - but with a message about the archive rather than about
    // the reference that is actually being broken.
    await expect(
      prisma.apartment.delete({ where: { id: APARTMENT_ID } }),
    ).rejects.toThrow(/termination_apartmentId_fkey|foreign key/i);
  });

  it("refuses a reference that is only whitespace", async () => {
    // The CHECK, not the service. This table has writers the service is not -
    // the seed, a migration, an import - and a constraint weaker than the
    // service is not the boundary it was added to be. U+3000 is in the class
    // for the same reason it is in the transfer constraint: JavaScript's trim
    // strips it, so the database has to as well.
    await expect(
      prisma.termination.create({
        data: {
          id: id("blank-reference"),
          apartmentId: APARTMENT_ID,
          kind: "BUILDING_TRANSFERRED",
          reference: "\u3000",
          tookEffectOn: new Date("2026-04-01"),
        },
      }),
    ).rejects.toThrow(/termination_reference_present/);
  });

  it("still accepts a second termination, which is an insert", async () => {
    // Append-only is not read-only. Two apartments in one disposed building
    // each get a row, and a correction is a new row beside the old one.
    const second = await prisma.termination.create({
      data: {
        id: id("second-termination"),
        apartmentId: APARTMENT_ID,
        kind: "BUILDING_TRANSFERRED",
        reference: `Kopeavtal ${suffix}`,
        tookEffectOn: new Date("2026-05-01"),
      },
    });

    expect(second.kind).toBe("BUILDING_TRANSFERRED");

    const original = await prisma.termination.findUniqueOrThrow({
      where: { id: TERMINATION_ID },
    });
    expect(original.kind).toBe("GENERAL_MEETING_DECISION");
  });
});

describe("the obligation ledger (anmalningsskyldighet)", () => {
  it("refuses an update, on the termination's reading rather than the transfer's", async () => {
    // The row states a statutory deadline: the event it reports cannot change,
    // and neither can the day Lag (2026:484) 3 kap. runs the two weeks from. So
    // there is no later state for an UPDATE to reach, and discharging the duty
    // is a separate fact about a report that was made.
    await expect(
      prisma.registerReportObligation.update({
        where: { id: OBLIGATION_ID },
        data: { dueOn: new Date("2027-01-01") },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a delete", async () => {
    await expect(
      prisma.registerReportObligation.delete({ where: { id: OBLIGATION_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a truncate, which row triggers alone would not catch", async () => {
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE "register_report_obligation"'),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a window that is not the statutory two weeks", async () => {
    // The CHECK, not the service. This table has writers the service is not - a
    // seed, an import, a migration - and a deadline stated fifteen days out
    // looks exactly like one stated fourteen days out, which is why the
    // arithmetic is in the database as well.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("wrong-window"),
          kind: "TERMINATION",
          apartmentId: APARTMENT_ID,
          terminationId: PROBE_TERMINATION_ID,
          triggeredOn: new Date("2026-04-08"),
          dueOn: new Date("2026-04-23"),
        },
      }),
    ).rejects.toThrow(/register_report_obligation_two_week_window/);
  });

  it("refuses an event reference that does not match the kind", async () => {
    // A row naming a termination while calling itself a transfer would report
    // the wrong event on the wrong paragraph's clock: 3 kap. 3 § runs from the
    // membership decision and 3 kap. 4 § from the day the bostadsratt ceased.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("mismatched-kind"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          terminationId: PROBE_TERMINATION_ID,
          triggeredOn: new Date("2026-04-08"),
          dueOn: new Date("2026-04-22"),
        },
      }),
    ).rejects.toThrow(/register_report_obligation_event_matches_kind/);
  });

  it("refuses a row that names no event at all", async () => {
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("eventless"),
          kind: "TERMINATION",
          apartmentId: APARTMENT_ID,
          triggeredOn: new Date("2026-04-08"),
          dueOn: new Date("2026-04-22"),
        },
      }),
    ).rejects.toThrow(/register_report_obligation_event_matches_kind/);
  });

  it("refuses a deadline on an apartment its event is not about", async () => {
    // The apartment is denormalised onto this row, so nothing but this trigger
    // stops the two answers disagreeing - permanently, on a table nothing can
    // correct.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("wrong-apartment"),
          kind: "TERMINATION",
          apartmentId: OTHER_APARTMENT_ID,
          terminationId: PROBE_TERMINATION_ID,
          triggeredOn: new Date("2026-04-08"),
          dueOn: new Date("2026-04-22"),
        },
      }),
    ).rejects.toThrow(/OPENBRF_REPORT_OBLIGATION_EVENT/);
  });

  it("refuses a window opened on a day its event does not carry", async () => {
    // Lag (2026:484) 3 kap. 4 § counts the two weeks from the day the
    // bostadsratt ceased. A row fourteen days wide from some other day satisfies
    // register_report_obligation_two_week_window and is still the wrong
    // deadline.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("wrong-window-start"),
          kind: "TERMINATION",
          apartmentId: APARTMENT_ID,
          terminationId: PROBE_TERMINATION_ID,
          triggeredOn: new Date("2026-05-01"),
          dueOn: new Date("2026-05-15"),
        },
      }),
    ).rejects.toThrow(/OPENBRF_REPORT_OBLIGATION_EVENT/);
  });

  it("refuses a deadline on a transfer with no membership decision", async () => {
    // 3 kap. 3 § andra stycket runs the window from the decision, so a transfer
    // without one has no day to count from and takes no row. The service
    // reaches this state by never writing one; this is what says so for every
    // other writer.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("undecided"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          transferId: UNDECIDED_TRANSFER_ID,
          triggeredOn: new Date("2022-03-01"),
          dueOn: new Date("2022-03-15"),
        },
      }),
    ).rejects.toThrow(/OPENBRF_REPORT_OBLIGATION_EVENT/);
  });

  it("refuses a recorded kind being restated", async () => {
    /*
     * The reporting obligation is computed from the kind and the ledger that
     * holds it refuses UPDATE and DELETE. A grant's duty names Lag (2026:484)
     * 3 kap. 2 § and opens on the day of the grant; a transfer's names 3 kap.
     * 3 § and opens on the membership decision. Let the kind move afterwards
     * and the ledger states the wrong paragraph and the wrong day for good.
     */
    await expect(
      prisma.transfer.update({
        where: { id: GRANT_TRANSFER_ID },
        data: { kind: "TRANSFER" },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_RECORD/);

    await expect(
      prisma.transfer.update({
        where: { id: UNDECIDED_TRANSFER_ID },
        data: { kind: "GRANT" },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_RECORD/);

    // And removed, which is the third way to stop the ledger's row from
    // describing the event it names.
    await expect(
      prisma.transfer.update({
        where: { id: GRANT_TRANSFER_ID },
        data: { kind: null },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_RECORD/);

    // And the row is untouched, which is what makes the refusal meaningful.
    const transfer = await prisma.transfer.findUniqueOrThrow({
      where: { id: GRANT_TRANSFER_ID },
      select: { kind: true },
    });
    expect(transfer.kind).toBe("GRANT");
  });

  it("refuses a grant's deadline on a transfer that is not one", async () => {
    /*
     * The two paragraphs count from different days: 3 kap. 2 § from the
     * upplatelse itself, 3 kap. 3 § andra stycket from the membership decision.
     * A row calling itself a GRANT while naming an overgang would take the
     * transfer's own date as the day of a grant that never happened - and the
     * apartment and the fourteen days would both check out.
     */
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("grant-on-a-transfer"),
          kind: "GRANT",
          apartmentId: APARTMENT_ID,
          transferId: UNDECIDED_TRANSFER_ID,
          triggeredOn: new Date("2022-03-01"),
          dueOn: new Date("2022-03-15"),
        },
      }),
    ).rejects.toThrow(/OPENBRF_REPORT_OBLIGATION_EVENT/);
  });

  it("refuses a transfer's deadline on an upplatelse", async () => {
    // And the other way round, because an upplatelse reported under 3 kap. 3 §
    // would wait for a membership decision that an upplatelse never takes.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("transfer-on-a-grant"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          transferId: GRANT_TRANSFER_ID,
          triggeredOn: new Date("2022-01-15"),
          dueOn: new Date("2022-01-29"),
        },
      }),
    ).rejects.toThrow(/OPENBRF_REPORT_OBLIGATION_EVENT/);
  });

  it("counts a grant's two weeks from the day of the upplatelse", async () => {
    // The accepting half: the same row with the grant's own date is written,
    // which is what makes the two refusals above about the paragraph rather
    // than about the table refusing everything.
    const obligation = await prisma.registerReportObligation.create({
      data: {
        id: id("granted-window"),
        kind: "GRANT",
        apartmentId: APARTMENT_ID,
        transferId: GRANT_TRANSFER_ID,
        triggeredOn: new Date("2022-01-15"),
        dueOn: new Date("2022-01-29"),
      },
      select: { kind: true },
    });
    expect(obligation.kind).toBe("GRANT");
  });

  it("leaves a reference to no event at all to the foreign key", async () => {
    // The event-match trigger returns without an opinion, so the refusal names
    // the constraint that was actually broken rather than reporting a missing
    // membership decision on a transfer that does not exist.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("dangling"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          transferId: id("no-such-transfer"),
          triggeredOn: new Date("2019-05-20"),
          dueOn: new Date("2019-06-03"),
        },
      }),
    ).rejects.toThrow(
      /register_report_obligation_transferId_fkey|foreign key/i,
    );
  });

  it("refuses a second deadline for one event", async () => {
    // One anmalan per event, so one deadline per event. Nothing here can take
    // either row out again, so two would leave the ledger permanently unable to
    // say which date the duty ran to.
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("duplicate"),
          kind: "TERMINATION",
          apartmentId: APARTMENT_ID,
          terminationId: TERMINATION_ID,
          triggeredOn: new Date("2026-04-01"),
          dueOn: new Date("2026-04-15"),
        },
      }),
    ).rejects.toThrow(/terminationId/i);
  });

  it("refuses to lose the event it was about", async () => {
    // Restrict on every reference, for the reason the termination above gives: a
    // deadline with no event is not a shorter record but a false one. The
    // termination is undeletable anyway, so this is asserted through the
    // obligation's own constraint by deleting with the archive guard off - which
    // is only possible because this suite connects as the schema owner.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "termination" DISABLE TRIGGER "termination_append_only"',
    );
    try {
      await expect(
        prisma.termination.delete({ where: { id: TERMINATION_ID } }),
      ).rejects.toThrow(
        /register_report_obligation_terminationId_fkey|foreign key/i,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "termination" ENABLE TRIGGER "termination_append_only"',
      );
    }
  });

  it("still accepts a second obligation, which is an insert", async () => {
    // Append-only is not read-only: every register event the association has to
    // report gets a row, and the ledger only grows.
    const second = await prisma.registerReportObligation.create({
      data: {
        id: id("second-obligation"),
        kind: "TRANSFER",
        apartmentId: APARTMENT_ID,
        transferId: TRANSFER_ID,
        // The transfer's own membership decision date, which
        // register_report_obligation_matches_its_event requires.
        triggeredOn: new Date("2019-05-20"),
        dueOn: new Date("2019-06-03"),
      },
    });

    expect(second.kind).toBe("TRANSFER");

    const original = await prisma.registerReportObligation.findUniqueOrThrow({
      where: { id: OBLIGATION_ID },
    });
    expect(original.dueOn).toEqual(new Date("2026-04-15"));
  });
});

/**
 * The other half of the guard: the privileges, not the triggers.
 *
 * These run as {@link PROBE_ROLE}, holding exactly what
 * harden-runtime-role.sql leaves the application holding. A trigger is
 * bypassable by the table owner, so this is the half that still stands after an
 * ALTER TABLE ... DISABLE TRIGGER - and the reason the application connects as a
 * role that owns nothing.
 *
 * PostgreSQL checks privileges before it executes, so the refusal is 42501 and
 * the trigger never fires. That is what makes these assertions about the
 * privilege rather than about the guard already proven above: with the REVOKE
 * removed, the same statements would come back with the archive message
 * instead, and every expectation here fails.
 *
 * The role and the statement it governs travel down one connection, which is
 * the condition that makes any of the above true. See {@link sqlStateAsProbe}.
 */
/**
 * Thrown to roll a probe transaction back once it has proved its point.
 *
 * Two rules below are about what the database accepts, and the rows they would
 * write are shared with the assertions around them - the association singleton,
 * and a transfer other tests read the absence of a case on.
 */
class GuardRollback extends Error {}

/**
 * A registered overlatelse that has been havd or has gone back to the seller.
 *
 * Lag (2026:484) 3 kap. 3 § tredje stycket. Statutory tier, so it takes the
 * termination's guards rather than the transfer's: the event has happened and
 * there is no later state for the row to reach.
 */
describe("a reversed overlatelse", () => {
  it("refuses an update, on the termination's reading", async () => {
    await expect(
      prisma.transferReversal.update({
        where: { id: REVERSAL_ID },
        data: { reversedOn: new Date("2020-01-01") },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a delete", async () => {
    await expect(
      prisma.transferReversal.delete({ where: { id: REVERSAL_ID } }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("refuses a truncate, which row triggers alone would not catch", async () => {
    /*
     * Both tables in one statement, because register_report_obligation
     * references this one, and this table named first: PostgreSQL refuses to
     * truncate a table a foreign key points at unless the referencing table goes
     * with it, and it does so with 0A000 before any statement-level trigger
     * fires. Naming this table first is what makes the message prove this
     * table's guard rather than the ledger's.
     */
    await expect(
      prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "transfer_reversal", "register_report_obligation"',
      ),
    ).rejects.toThrow(
      /OPENBRF_STATUTORY_ARCHIVE: TRUNCATE is not permitted on transfer_reversal/,
    );
  });

  it("refuses a reference that is only whitespace", async () => {
    // The board records what shows the reversal. A field of spaces is not a
    // reference, and the class is String.prototype.trim's rather than
    // [[:space:]], which is locale-dependent.
    await expect(
      prisma.transferReversal.create({
        data: {
          id: id("blank-reference"),
          transferId: CASED_TRANSFER_ID,
          apartmentId: APARTMENT_ID,
          kind: "RESCINDED",
          reversedOn: new Date("2023-08-01"),
          reference: "\u00a0 \u2007",
        },
      }),
    ).rejects.toThrow(/transfer_reversal_reference_present/);
  });

  it("refuses one on an apartment its overlatelse is not about", async () => {
    // The apartment is denormalised so the register can be read per apartment
    // without a join, and a denormalised column nothing checks is a second
    // answer waiting to disagree with the first.
    await expect(
      prisma.transferReversal.create({
        data: {
          id: id("wrong-apartment-reversal"),
          transferId: CASED_TRANSFER_ID,
          apartmentId: OTHER_APARTMENT_ID,
          kind: "RESCINDED",
          reversedOn: new Date("2023-08-01"),
          reference: `Havning ${suffix}`,
        },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_REVERSAL/);
  });

  it("refuses one on an upplatelse, which has no seller to go back to", async () => {
    await expect(
      prisma.transferReversal.create({
        data: {
          id: id("grant-reversal"),
          transferId: GRANT_TRANSFER_ID,
          apartmentId: APARTMENT_ID,
          kind: "RESCINDED",
          reversedOn: new Date("2023-08-01"),
          reference: `Havning ${suffix}`,
        },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_REVERSAL/);
  });

  it("refuses a second reversal of one overlatelse", async () => {
    await expect(
      prisma.transferReversal.create({
        data: {
          id: id("second-reversal"),
          transferId: REVERSED_TRANSFER_ID,
          apartmentId: APARTMENT_ID,
          kind: "RESCINDED",
          reversedOn: new Date("2023-09-01"),
          reference: `Havning ${suffix}`,
        },
      }),
    ).rejects.toThrow(/transfer_reversal_transferId_key/);
  });
});

/**
 * The cases of Lag (2026:484) 3 kap. 3 §, in the database.
 *
 * The service chooses which day a window opens on. These are what say the same
 * thing to every other writer this schema has - a seed, an import, a migration.
 */
describe("which case of 3 kap. 3 § an overgang falls in", () => {
  it("refuses a case being restated, as a recorded kind is", async () => {
    // The obligation computed from it names a paragraph and a day, and the
    // ledger refuses UPDATE and DELETE, so a case that could move would leave
    // the association's own record of what it owed stating a rule nobody chose.
    await expect(
      prisma.transfer.update({
        where: { id: CASED_TRANSFER_ID },
        data: { reportBasis: "TO_THE_ASSOCIATION" },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_RECORD/);

    await expect(
      prisma.transfer.update({
        where: { id: CASED_TRANSFER_ID },
        data: { reportBasis: null },
      }),
    ).rejects.toThrow(/OPENBRF_TRANSFER_RECORD/);
  });

  it("still accepts one on a transfer that never stated one", async () => {
    // Null to a value is a correction the board is making rather than a guess
    // the platform is making, which is the grandfathering the kind's own rule
    // keeps. Rolled back, because the row is shared with the tests around it.
    await prisma
      .$transaction(async (tx) => {
        await tx.transfer.update({
          where: { id: UNDECIDED_TRANSFER_ID },
          data: { reportBasis: "ALREADY_MEMBER" },
        });
        throw new GuardRollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof GuardRollback)) {
          throw error;
        }
      });

    const stored = await prisma.transfer.findUniqueOrThrow({
      where: { id: UNDECIDED_TRANSFER_ID },
      select: { reportBasis: true },
    });
    expect(stored.reportBasis).toBeNull();
  });

  it("refuses a case on an upplatelse, which 3 kap. 3 § does not reach", async () => {
    await expect(
      prisma.transfer.update({
        where: { id: GRANT_TRANSFER_ID },
        data: { reportBasis: "ALREADY_MEMBER" },
      }),
    ).rejects.toThrow(/transfer_report_basis_is_for_an_overgang/);
  });

  it("refuses a membership decision date beside a case that has none", async () => {
    // Andra stycket's second sentence runs the window from the overgang, so
    // there is no decision to date, and a value here would be a second and
    // contradictory answer to which day the window opened.
    await expect(
      prisma.transfer.update({
        where: { id: CASED_TRANSFER_ID },
        data: { membershipDecidedOn: new Date("2023-02-01") },
      }),
    ).rejects.toThrow(/transfer_membership_decision_matches_basis/);
  });

  it("counts an already-member overgang's two weeks from the overgang", async () => {
    // The whole content of the rule: this transfer has no membership decision,
    // so a ledger row dated from that column would be dated from nothing. The
    // day it is dated from is the transfer's own.
    const obligation = await prisma.registerReportObligation.create({
      data: {
        id: id("already-member-window"),
        kind: "TRANSFER",
        apartmentId: APARTMENT_ID,
        transferId: CASED_TRANSFER_ID,
        triggeredOn: new Date("2023-03-01"),
        dueOn: new Date("2023-03-15"),
      },
    });
    expect(obligation.id).toBe(id("already-member-window"));
  });

  it("refuses that overgang's window dated from anything else", async () => {
    /*
     * The transfer whose case runs the window from the overgang, dated a day
     * off it. Matched on the sentence about the day rather than on the marker:
     * three rules in this trigger raise the same marker, and a test that
     * accepted any of them would pass with the rule it is about removed.
     */
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("already-member-wrong-day"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          transferId: CASED_TRANSFER_ID,
          triggeredOn: new Date("2023-03-02"),
          dueOn: new Date("2023-03-16"),
        },
      }),
    ).rejects.toThrow(/the window is dated .* but the statute counts it from/);
  });

  it("refuses any duty at all where the acquirer makes the anmalan", async () => {
    /*
     * Forsta stycket puts the anmalan on the juridical person, so a row here
     * would be the association recording a deadline it does not owe - and it
     * could never be taken out again, because this table refuses UPDATE and
     * DELETE. Dated from the overgang, which is the day a caller reading andra
     * stycket alone would reach for.
     */
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("elsewhere-duty"),
          kind: "TRANSFER",
          apartmentId: APARTMENT_ID,
          transferId: ELSEWHERE_TRANSFER_ID,
          triggeredOn: new Date("2023-04-01"),
          dueOn: new Date("2023-04-15"),
        },
      }),
      // On the sentence that names the anmalare, not on the marker. Without
      // this rule the trigger falls through to the date check, which raises the
      // same marker because that case has no membership decision to count from
      // - so a test matching the marker alone stays green with the rule gone.
    ).rejects.toThrow(/anmald by the juridical person that acquired it/);
  });
});

/**
 * The duty tredje stycket sets no period for.
 *
 * Every other reporting sentence in 3 kap. says "inom tva veckor"; this one says
 * the association "ska anmala" and stops. The CHECK states both halves, so
 * neither a fabricated deadline nor a missing one can be written.
 */
describe("a reversal's deadline, or its absence", () => {
  it("accepts one with no deadline at all", async () => {
    const obligation = await prisma.registerReportObligation.create({
      data: {
        id: id("reversal-duty"),
        kind: "TRANSFER_REVERSAL",
        apartmentId: APARTMENT_ID,
        reversalId: REVERSAL_ID,
        triggeredOn: new Date("2023-07-02"),
        dueOn: null,
      },
    });
    expect(obligation.dueOn).toBeNull();
  });

  it("refuses a deadline read into a sentence that names none", async () => {
    // Raw SQL, because the generated client's own types now say a reversal's
    // deadline is null and this is about what the database refuses rather than
    // about what TypeScript allows. Fourteen days, which is the value an
    // analogy with the sentences around tredje stycket would reach for.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "register_report_obligation"
           ("id", "kind", "apartmentId", "reversalId", "triggeredOn", "dueOn")
         VALUES ($1, 'TRANSFER_REVERSAL', $2, $3, DATE '2023-07-02', DATE '2023-07-16')`,
        id("reversal-dated"),
        APARTMENT_ID,
        REVERSAL_ID,
      ),
    ).rejects.toThrow(/register_report_obligation_deadline_only_where_stated/);
  });

  /*
   * The invariant that could have been lost when the column became nullable.
   *
   * Before this change the column was NOT NULL, so the database itself said
   * every duty in the ledger has a deadline. A plain nullable column says
   * nothing, and a GRANT, a TRANSFER or a TERMINATION written without one would
   * be a duty the queue can never call overdue - on a table that refuses UPDATE,
   * so it could never be corrected either. One case per kind, because the
   * constraint branches on the kind and a single case would leave two of the
   * three untested.
   */
  const DATED_KINDS = [
    { kind: "GRANT", event: { transferId: GRANT_TRANSFER_ID } },
    { kind: "TRANSFER", event: { transferId: CASED_TRANSFER_ID } },
    { kind: "TERMINATION", event: { terminationId: PROBE_TERMINATION_ID } },
  ] as const;

  for (const { kind, event } of DATED_KINDS) {
    it(`refuses a ${kind} with no deadline at all`, async () => {
      await expect(
        prisma.registerReportObligation.create({
          data: {
            id: id(`undated-${kind}`),
            kind,
            apartmentId: APARTMENT_ID,
            ...event,
            // The day each event actually carries, so the row is refused on its
            // nullability rather than on the trigger that checks the window
            // against the register event.
            triggeredOn:
              kind === "GRANT"
                ? new Date("2022-01-15")
                : kind === "TRANSFER"
                  ? new Date("2023-03-01")
                  : new Date("2026-04-08"),
            dueOn: null,
          },
        }),
      ).rejects.toThrow(
        /register_report_obligation_deadline_only_where_stated/,
      );
    });
  }

  it("refuses a reversal's window dated from a day it does not carry", async () => {
    await expect(
      prisma.registerReportObligation.create({
        data: {
          id: id("reversal-wrong-day"),
          kind: "TRANSFER_REVERSAL",
          apartmentId: APARTMENT_ID,
          reversalId: REVERSAL_ID,
          triggeredOn: new Date("2023-07-03"),
          dueOn: null,
        },
      }),
    ).rejects.toThrow(/the window is dated .* but the statute counts it from/);
  });
});

describe("the application role's privileges on the statutory archive", () => {
  /** PostgreSQL's insufficient_privilege. */
  const PERMISSION_DENIED = "42501";

  /**
   * The SQLSTATE a statement failed with as the probe role, or undefined.
   *
   * One transaction, and SET LOCAL ROLE on the transaction's own client, so
   * that the role and the statement it is supposed to govern are guaranteed to
   * be the same connection. Issued as three separate calls on the pool -
   * SET ROLE, the statement, RESET ROLE - they need not be: the pool is free to
   * hand the statement a different connection, on which the session user is
   * still the owner, and then every refusal asserted below would be asserted
   * against a role that was never revoked anything. This suite is the only
   * thing standing behind the REVOKE lines in harden-runtime-role.sql, so a
   * pass for that reason would be worse than no suite at all.
   *
   * LOCAL also means the role ends with the transaction rather than being reset
   * by a later call, so no connection goes back to the pool still wearing it.
   */
  async function sqlStateAsProbe(
    statement: string,
  ): Promise<string | undefined> {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
        await tx.$executeRawUnsafe(statement);
      });
      return undefined;
    } catch (error) {
      const code = (error as { meta?: { code?: string } }).meta?.code;
      // The message is the fallback: the driver surfaces the SQLSTATE on the
      // metadata for a raw query, and a shape change there must not turn this
      // into a test that passes on any failure at all.
      return (
        code ??
        (/permission denied/i.test(String((error as Error).message))
          ? PERMISSION_DENIED
          : `no-sqlstate: ${String((error as Error).message)}`)
      );
    }
  }

  it("runs a probe as the application role, which every case below rests on", async () => {
    // Asserted through the helper rather than through a second copy of it, so
    // what is pinned is the guarantee the other cases actually use. The two
    // permissive cases at the end are why this matters: run as the owner they
    // come back clean as well, and would report that the application may read
    // and append when nothing had been established about the application at
    // all. The refusals would not be silent - as the owner they would trip the
    // table's trigger and come back with the archive message - but a suite
    // whose positive half can pass for the wrong reason is not proof of a
    // privilege.
    expect(
      await sqlStateAsProbe(
        `DO $$ BEGIN
           IF current_user <> '${PROBE_ROLE}' THEN
             RAISE EXCEPTION 'the probe ran as %', current_user;
           END IF;
         END $$`,
      ),
    ).toBeUndefined();
  });

  it("refuses to rewrite a termination", async () => {
    expect(
      await sqlStateAsProbe(
        `UPDATE public."termination" SET "reference" = 'Tampered' WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("refuses to delete a termination", async () => {
    expect(
      await sqlStateAsProbe(
        `DELETE FROM public."termination" WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("refuses to truncate a termination", async () => {
    // TRUNCATE was never granted - it is its own privilege and DELETE does not
    // imply it - so this is refused before the statement-level trigger.
    expect(await sqlStateAsProbe('TRUNCATE TABLE public."termination"')).toBe(
      PERMISSION_DENIED,
    );
  });

  it("still reads it, because the register has to be printable", async () => {
    expect(
      await sqlStateAsProbe('SELECT count(*) FROM public."termination"'),
    ).toBeUndefined();
  });

  it("still appends to it, because a termination has to be recordable", async () => {
    expect(
      await sqlStateAsProbe(
        `INSERT INTO public."termination" ("id", "apartmentId", "kind", "tookEffectOn", "reference")
         VALUES ('${id("probe-insert")}', '${APARTMENT_ID}', 'BUILDING_TRANSFERRED', '2026-06-01', 'Kopeavtal probe')`,
      ),
    ).toBeUndefined();
  });

  it("refuses to rewrite an obligation", async () => {
    expect(
      await sqlStateAsProbe(
        `UPDATE public."register_report_obligation" SET "dueOn" = '2030-01-01' WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("refuses to delete an obligation", async () => {
    expect(
      await sqlStateAsProbe(
        `DELETE FROM public."register_report_obligation" WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("refuses to truncate the obligation ledger", async () => {
    // TRUNCATE was never granted - it is its own privilege and DELETE does not
    // imply it - so this is refused before the statement-level trigger.
    expect(
      await sqlStateAsProbe(
        'TRUNCATE TABLE public."register_report_obligation"',
      ),
    ).toBe(PERMISSION_DENIED);
  });

  it("still reads the ledger, because the duties have to be listable", async () => {
    expect(
      await sqlStateAsProbe(
        'SELECT count(*) FROM public."register_report_obligation"',
      ),
    ).toBeUndefined();
  });

  it("still appends to it, because a deadline has to be recordable", async () => {
    // The insert the register write performs in its own transaction. If this
    // were refused the application could record a termination and not its
    // deadline, which is the one outcome the ledger exists to rule out.
    expect(
      await sqlStateAsProbe(
        `INSERT INTO public."register_report_obligation" ("id", "kind", "apartmentId", "terminationId", "triggeredOn", "dueOn")
         VALUES ('${id("probe-obligation")}', 'TERMINATION', '${APARTMENT_ID}', '${PROBE_TERMINATION_ID}', '2026-04-08', '2026-04-22')`,
      ),
    ).toBeUndefined();
  });

  it("refuses to rewrite the member register and the audit log too", async () => {
    // The tables the script already covered, asserted here as well: this suite
    // reads its statements out of the file, so these are what says the
    // extraction found the existing lines and not only the new one.
    expect(
      await sqlStateAsProbe(
        `UPDATE public."member_register_entry" SET "recordedLastName" = 'Tampered' WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
    expect(
      await sqlStateAsProbe(
        `DELETE FROM public."audit_log_entry" WHERE id = 'no-such-row'`,
      ),
    ).toBe(PERMISSION_DENIED);
  });
});

describe("association", () => {
  it("refuses a second row, because one instance serves one association", async () => {
    await expect(
      prisma.association.create({
        data: { id: 2, name: "Brf Nummer Tva" },
      }),
    ).rejects.toThrow(/association_is_singleton/i);
  });
});
