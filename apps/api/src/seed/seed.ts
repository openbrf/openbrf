import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { Env } from "../config/env";
import type { PrismaClient } from "../generated/prisma/client";
import {
  DEMO_ASSOCIATION,
  DEMO_BUILDINGS,
  DEMO_FLOOR_WEIGHTS,
  DEMO_TOTAL_INITIAL_SHARE_CAPITAL,
  DEMO_PEOPLE,
  DEMO_PERSON_COUNT,
  FILLER_FIRST_NAMES,
  FILLER_LAST_NAMES,
  type DemoPerson,
} from "./demo-data";

export interface SeedResult {
  addresses: number;
  apartments: number;
  persons: number;
  memberRegisterEntries: number;
}

/** The argument that asks for the demo data, on the command line every time. */
export const DEMO_SEED_FLAG = "--demo-data";

/** The id prefix every person the seed writes carries. */
const SEED_PERSON_PREFIX = "seed-person-";

/**
 * Why the demo data must not be written here, or null when it may.
 *
 * The seed renames association 1, adds a hundred people and writes member
 * register entries that can never be deleted (EFL 5 kap., by trigger), so it
 * runs only where every one of these holds. Asked for in this invocation, by an
 * argument rather than a variable: an .env line would ask on every later run as
 * well, from whichever checkout it sits in. Not production. And a database that
 * holds nothing but the seed's own rows - no association under another name or
 * organisation number, no person and no member register entry the seed did not
 * write - because
 * NODE_ENV defaults to development, and a checkout whose DATABASE_URL points at
 * a real instance is exactly where the first two would not stop it.
 */
export async function demoSeedRefusal(
  prisma: PrismaClient,
  invocation: { nodeEnv: string; argv: readonly string[] },
): Promise<string | null> {
  if (!invocation.argv.includes(DEMO_SEED_FLAG)) {
    return `Seeding writes demo data that cannot all be removed again; pass ${DEMO_SEED_FLAG} to ask for it.`;
  }
  if (invocation.nodeEnv === "production") {
    return "Refusing to seed demo data in production: the member register entries it creates are append-only and could not be removed.";
  }
  const [association, people, entries] = await Promise.all([
    prisma.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    }),
    prisma.person.count({
      where: { NOT: { id: { startsWith: SEED_PERSON_PREFIX } } },
    }),
    prisma.memberRegisterEntry.count({
      where: { NOT: { personId: { startsWith: SEED_PERSON_PREFIX } } },
    }),
  ]);
  // The name alone is not the demo's: a real association can be called that,
  // and the seed would write its undeletable entries into that one's register.
  const foreign =
    association !== null &&
    (association.name !== DEMO_ASSOCIATION.name ||
      association.organizationNumber !== DEMO_ASSOCIATION.organizationNumber);
  if (foreign || people > 0 || entries > 0) {
    return "Refusing to seed demo data: this database already holds an association, people or member register entries of its own.";
  }
  return null;
}

/**
 * Populates an instance with the Brf Eksemplet demo association.
 *
 * Idempotent: every row is keyed on a stable identifier so re-running updates
 * rather than duplicating. The member register is the exception and needs care,
 * because it is append-only at the database level: entries are created only
 * when the person has none, otherwise a second run would write a duplicate
 * membership event that could never be deleted.
 */
export async function seedDemoData(
  prisma: PrismaClient,
  env: Env,
): Promise<SeedResult> {
  const encryption = new FieldEncryptionService(env);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: DEMO_ASSOCIATION.name,
      organizationNumber: DEMO_ASSOCIATION.organizationNumber,
      setupCompletedAt: new Date(),
    },
    update: { name: DEMO_ASSOCIATION.name },
  });

  // Addresses and apartments.
  const apartmentIdByNumber = new Map<string, string>();
  const weighted: { apartmentId: string; weight: number }[] = [];
  let apartmentCount = 0;

  for (const building of DEMO_BUILDINGS) {
    const addressId = `seed-address-${building.street}-${building.number}`
      .toLowerCase()
      .replace(/\s+/g, "-");

    await prisma.address.upsert({
      where: { id: addressId },
      create: {
        id: addressId,
        street: building.street,
        number: building.number,
        postalCode: building.postalCode,
        city: building.city,
        sortOrder: building.sortOrder,
      },
      update: { sortOrder: building.sortOrder },
    });

    for (const [floor, count] of building.apartmentsPerFloor.entries()) {
      for (let index = 1; index <= count; index++) {
        // Lantmateriet style numbering: 1000 + floor * 100 + index, so the
        // ground floor is 10XX, the first floor 11XX and so on. The board
        // groups rows by this.
        const number = String(1000 + floor * 100 + index);
        const apartmentId = `${addressId}-${number}`;

        await prisma.apartment.upsert({
          where: { id: apartmentId },
          create: {
            id: apartmentId,
            addressId,
            number,
            floor,
          },
          update: { floor },
        });

        // Collected rather than written here: the shares have to add to exactly
        // one across every apartment, which cannot be known until the last of
        // them has been counted.
        weighted.push({
          apartmentId,
          weight: DEMO_FLOOR_WEIGHTS[floor] ?? 1,
        });

        apartmentCount++;
        // The named residents all live in the first building, so only its
        // apartment numbers need to be addressable by number alone.
        if (building.sortOrder === 0) {
          apartmentIdByNumber.set(number, apartmentId);
        }
      }
    }
  }

  await seedApartmentShares(prisma, weighted);

  const allApartmentIds = [...apartmentIdByNumber.values()];

  // Named residents from the design canvas.
  let personCount = 0;
  let registerEntryCount = 0;

  for (const person of DEMO_PEOPLE) {
    const apartmentId = apartmentIdByNumber.get(person.apartmentNumber);
    if (apartmentId === undefined) {
      throw new Error(
        `Demo person ${person.key} references apartment ${person.apartmentNumber}, which the building layout does not contain.`,
      );
    }
    await upsertPerson(prisma, encryption, person, apartmentId);
    personCount++;
    registerEntryCount += await ensureMemberRegisterEntries(
      prisma,
      person,
      apartmentId,
    );
  }

  // Filler residents, so pagination and counts look like a real association.
  const fillerNeeded = DEMO_PERSON_COUNT - DEMO_PEOPLE.length;
  for (let index = 0; index < fillerNeeded; index++) {
    const firstName = FILLER_FIRST_NAMES[index % FILLER_FIRST_NAMES.length];
    const lastName =
      FILLER_LAST_NAMES[
        Math.floor(index / FILLER_FIRST_NAMES.length) % FILLER_LAST_NAMES.length
      ];
    const apartmentId = allApartmentIds[index % allApartmentIds.length];
    if (
      firstName === undefined ||
      lastName === undefined ||
      apartmentId === undefined
    ) {
      continue;
    }

    const person: DemoPerson = {
      key: `filler-${String(index).padStart(3, "0")}`,
      firstName,
      lastName,
      apartmentNumber: "",
      // Filler residents are non-members so the member count stays realistic
      // against the number of apartments.
      role: index % 3 === 0 ? "MEMBER" : "RESIDENT",
      movedInOn: "2023-01-01",
      email:
        `${firstName}.${lastName}${String(index)}@exempel.se`.toLowerCase(),
    };

    await upsertPerson(prisma, encryption, person, apartmentId);
    personCount++;
    registerEntryCount += await ensureMemberRegisterEntries(
      prisma,
      person,
      apartmentId,
    );
  }

  return {
    addresses: DEMO_BUILDINGS.length,
    apartments: apartmentCount,
    persons: personCount,
    memberRegisterEntries: registerEntryCount,
  };
}

async function upsertPerson(
  prisma: PrismaClient,
  encryption: FieldEncryptionService,
  person: DemoPerson,
  apartmentId: string,
): Promise<void> {
  const personId = `seed-person-${person.key}`;

  const email =
    person.email === undefined
      ? null
      : await encryption.encrypt("person.email", person.email);
  const phone =
    person.phone === undefined
      ? null
      : await encryption.encrypt("person.phone", person.phone);
  const identityNumber =
    person.personalIdentityNumber === undefined
      ? null
      : await encryption.encrypt(
          "person.personalIdentityNumber",
          person.personalIdentityNumber,
        );

  const fields = {
    firstName: person.firstName,
    lastName: person.lastName,
    postalStreet: "Storgatan 12",
    postalCode: "11122",
    postalCity: "Stockholm",
    emailCipher: email?.cipher ?? null,
    emailIndex: email?.index ?? null,
    phoneCipher: phone?.cipher ?? null,
    phoneIndex: phone?.index ?? null,
    personalIdentityNumberCipher: identityNumber?.cipher ?? null,
    personalIdentityNumberIndex: identityNumber?.index ?? null,
    protectedPersonalData: person.protectedPersonalData ?? false,
    preferredLocale: person.preferredLocale ?? "sv",
  };

  await prisma.person.upsert({
    where: { id: personId },
    create: { id: personId, ...fields },
    update: fields,
  });

  const residencyId = `seed-residency-${person.key}`;
  const residency = {
    personId,
    apartmentId,
    role: person.role,
    movedInOn: new Date(person.movedInOn),
    movedOutOn:
      person.movedOutOn === undefined ? null : new Date(person.movedOutOn),
  };
  await prisma.residency.upsert({
    where: { id: residencyId },
    create: { id: residencyId, ...residency },
    update: residency,
  });

  if (person.boardPosition !== undefined) {
    const positionId = `seed-position-${person.key}`;
    await prisma.boardPosition.upsert({
      where: { id: positionId },
      create: {
        id: positionId,
        personId,
        position: person.boardPosition,
        electedOn: new Date("2025-05-15"),
      },
      update: { position: person.boardPosition },
    });
  }
}

/**
 * Creates the statutory membership events for a demo member, one event type at
 * a time and only where that type is missing.
 *
 * The member register cannot be updated or deleted, so a naive re-seed would
 * accumulate duplicate entries permanently. Checking first is what makes the
 * seed safe to run twice.
 *
 * The check is per event type rather than "does this person have any entry".
 * A seed interrupted between the ENTRY and the EXIT leaves a count of one, and
 * a whole-person check would then take that as done and leave a moved-out
 * member permanently recorded as still resident - in the one table that can
 * never be corrected by editing.
 */
async function ensureMemberRegisterEntries(
  prisma: PrismaClient,
  person: DemoPerson,
  apartmentId: string,
): Promise<number> {
  if (person.role !== "MEMBER") {
    return 0;
  }

  const personId = `seed-person-${person.key}`;
  const existing = await prisma.memberRegisterEntry.findMany({
    where: { personId },
    select: { eventType: true },
  });
  const present = new Set(existing.map((entry) => entry.eventType));

  const recorded = {
    recordedFirstName: person.firstName,
    recordedLastName: person.lastName,
    recordedPostalStreet: "Storgatan 12",
    recordedPostalCode: "11122",
    recordedPostalCity: "Stockholm",
  };

  const required = [
    { eventType: "ENTRY" as const, eventOn: person.movedInOn },
    ...(person.movedOutOn === undefined
      ? []
      : [{ eventType: "EXIT" as const, eventOn: person.movedOutOn }]),
  ];

  let created = 0;
  for (const event of required) {
    if (present.has(event.eventType)) {
      continue;
    }
    await prisma.memberRegisterEntry.create({
      data: {
        personId,
        apartmentId,
        eventType: event.eventType,
        eventOn: new Date(event.eventOn),
        ...recorded,
      },
    });
    created++;
  }

  return created;
}

/**
 * Writes the demo apartments' participation shares and initial share capitals.
 *
 * After every apartment has been counted, because both figures are a division
 * of one whole and the last apartment absorbs whatever the division leaves
 * over. That is what a stadgar annex does: the figures are stated per apartment
 * and they add to exactly one, rather than each being rounded on its own and
 * the total coming out at 0.99999992.
 *
 * Integer arithmetic throughout - hundred-millionths for the share, ore for the
 * insats - because a demo whose figures are visibly a float away from adding up
 * is a demo that teaches the wrong thing about what this product stores.
 *
 * Nothing in the platform derives a fee from either figure. They are recorded
 * because the apartment register holds them, and the fee screen offers the share
 * as an aid the board accepts or overwrites.
 */
async function seedApartmentShares(
  prisma: PrismaClient,
  weighted: readonly { apartmentId: string; weight: number }[],
): Promise<void> {
  const totalWeight = weighted.reduce(
    (total, apartment) => total + apartment.weight,
    0,
  );
  if (totalWeight === 0) {
    return;
  }

  /** One whole share, in hundred-millionths: the scale of `Decimal(12, 8)`. */
  const SHARE_SCALE = 100_000_000n;
  const totalOre = BigInt(DEMO_TOTAL_INITIAL_SHARE_CAPITAL) * 100n;
  const total = BigInt(totalWeight);

  let shareLeft = SHARE_SCALE;
  let oreLeft = totalOre;

  for (const [index, apartment] of weighted.entries()) {
    const last = index === weighted.length - 1;
    const weight = BigInt(apartment.weight);

    // The last apartment takes what is left, so the column of figures adds to
    // the whole rather than to the whole less a rounding error.
    const share = last ? shareLeft : (SHARE_SCALE * weight) / total;
    const ore = last ? oreLeft : (totalOre * weight) / total;
    shareLeft -= share;
    oreLeft -= ore;

    await prisma.apartment.update({
      where: { id: apartment.apartmentId },
      data: {
        participationShare: formatScaled(share, 8),
        initialShareCapital: formatScaled(ore, 2),
      },
    });
  }
}

/** A scaled integer as the decimal string its column holds. */
function formatScaled(value: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  return `${String(value / scale)}.${String(value % scale).padStart(places, "0")}`;
}
