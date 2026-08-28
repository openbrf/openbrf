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
});

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

describe("association", () => {
  it("refuses a second row, because one instance serves one association", async () => {
    await expect(
      prisma.association.create({
        data: { id: 2, name: "Brf Nummer Tva" },
      }),
    ).rejects.toThrow(/association_is_singleton/i);
  });
});
