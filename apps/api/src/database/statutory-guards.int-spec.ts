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
const ENTRY_ID = id("entry");
const AUDIT_ID = id("audit");
const ERASED_AUDIT_ID = id("erased-audit");
const TRANSFER_ID = id("transfer");
const LIEN_ID = id("lien");
const TERMINATION_ID = id("termination");

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
      toPersonId: PERSON_ID,
      transferredOn: new Date("2019-06-01"),
      // Required by transfer_agreement_reference_present: the apartment
      // register extract states a reference for every transfer it lists.
      agreementReference: `Upplatelseavtal ${TRANSFER_ID}`,
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
    await prisma.transfer.deleteMany({ where: { apartmentId: APARTMENT_ID } });
    await prisma.termination.deleteMany({
      where: { apartmentId: APARTMENT_ID },
    });
    await prisma.apartment.deleteMany({ where: { id: APARTMENT_ID } });
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
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE "termination"'),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
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
