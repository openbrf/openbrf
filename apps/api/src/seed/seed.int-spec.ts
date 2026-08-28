import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { DEMO_BUILDINGS, DEMO_PERSON_COUNT } from "./demo-data";
import { seedDemoData } from "./seed";

/**
 * The demo association is the fixture the exit criteria are written against,
 * so it is worth asserting it lands in the shape the design canvas shows, and
 * that encrypted fields are genuinely searchable once seeded.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let encryption: FieldEncryptionService;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  encryption = new FieldEncryptionService(env);
  await seedDemoData(prisma, env);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("demo data", () => {
  it("produces the counts the design canvas shows", async () => {
    // Scoped to the seeded ids, as the person count already is. Suites that
    // write to the statutory archive leave their fixture addresses behind:
    // the member register entry naming an apartment cannot be deleted, and the
    // apartment and its address cannot be deleted while it names them. That is
    // the register working as designed, so the assertion counts the demo data
    // rather than the database.
    const [addresses, apartments, persons] = await Promise.all([
      prisma.address.count({ where: { id: { startsWith: "seed-address-" } } }),
      prisma.apartment.count({
        where: { address: { id: { startsWith: "seed-address-" } } },
      }),
      prisma.person.count({ where: { id: { startsWith: "seed-person-" } } }),
    ]);

    expect(addresses).toBe(DEMO_BUILDINGS.length);
    expect(apartments).toBe(42);
    expect(persons).toBe(DEMO_PERSON_COUNT);
  });

  it("numbers apartments so the board can group them by floor", async () => {
    const address = await prisma.address.findFirstOrThrow({
      where: { number: "12" },
      include: { apartments: { orderBy: { number: "asc" } } },
    });

    const groundFloor = address.apartments.filter((a) => a.floor === 0);
    const firstFloor = address.apartments.filter((a) => a.floor === 1);

    // Ground floor is 10XX, first floor 11XX, matching Lantmateriet numbering
    // and the "ENTREPLAN 10XX" group rows on the board.
    expect(groundFloor.every((a) => a.number.startsWith("10"))).toBe(true);
    expect(firstFloor.every((a) => a.number.startsWith("11"))).toBe(true);
  });

  it("finds a seeded resident by email even though it is encrypted", async () => {
    const index = await encryption.computeIndex(
      "person.email",
      "anna.lindqvist@exempel.se",
    );
    const found = await prisma.person.findFirstOrThrow({
      where: { emailIndex: index },
    });

    expect(found.lastName).toBe("Lindqvist");
    // The ciphertext holds what was entered, so the register prints it back
    // exactly as written.
    await expect(
      encryption.decrypt("person.email", found.emailCipher ?? ""),
    ).resolves.toBe("anna.lindqvist@exempel.se");
  });

  it("finds a resident by a phone number spelled differently than stored", async () => {
    // Seeded as "070-123 45 67"; searched in E.164.
    const index = await encryption.computeIndex("person.phone", "+46701234567");
    const found = await prisma.person.findFirstOrThrow({
      where: { phoneIndex: index },
    });

    expect(found.firstName).toBe("Anna");
  });

  it("marks the protected resident so every view can mask her", async () => {
    const sara = await prisma.person.findUniqueOrThrow({
      where: { id: "seed-person-sara-berg" },
    });

    expect(sara.protectedPersonalData).toBe(true);
  });

  it("records a moved-out member with both membership events", async () => {
    const entries = await prisma.memberRegisterEntry.findMany({
      where: { personId: "seed-person-karin-ohman" },
      orderBy: { eventOn: "asc" },
    });

    expect(entries.map((e) => e.eventType)).toEqual(["ENTRY", "EXIT"]);
  });

  it("is idempotent, which the append-only register makes essential", async () => {
    const before = await prisma.memberRegisterEntry.count();
    await seedDemoData(prisma, env);
    const after = await prisma.memberRegisterEntry.count();

    // A duplicate membership event could never be deleted afterwards.
    expect(after).toBe(before);
  }, 120_000);
});
