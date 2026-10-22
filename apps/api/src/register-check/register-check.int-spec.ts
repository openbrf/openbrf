import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runPhone,
  runSuffix,
} from "../testing/integration-env";
import {
  RegisterCheckService,
  withheldFromDevices,
} from "./register-check.service";

/**
 * The register check of ADR 0032 against a real database: a name, an email
 * address, a phone number and an apartment number the register holds are each
 * found in published text, the last three through the blind indexes rather
 * than by decrypting anything, and a person with protected personal data is
 * found without being shown.
 *
 * The check reads the whole register, and other suites share the database, so
 * every name and address here is this run's own, written in letters only, and
 * a text expected to pass holds no digit another suite's apartment could
 * number.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaService;
let encryption: FieldEncryptionService;
let check: RegisterCheckService;

const suffix = runSuffix();
/** The suffix in letters, so that it stays inside one word of a name. */
const tag = suffix.replace(/\d/g, (digit) => "abcdefghij"[Number(digit)] ?? "");

const ids = {
  resident: `register-check-resident-${suffix}`,
  hidden: `register-check-hidden-${suffix}`,
  address: `register-check-address-${suffix}`,
  apartment: `register-check-apartment-${suffix}`,
};

const RESIDENT = {
  givenName: `Yrsa${tag}`,
  familyName: `Zorvik${tag}`,
  email: `yrsa.${tag}@example.se`,
  phone: runPhone(`register-check-${suffix}`),
};
const HIDDEN = {
  givenName: `Ilse${tag}`,
  familyName: `Hemlig${tag}`,
  email: `ilse.${tag}@example.se`,
};
/** Up to seven digits from the suffix, as an apartment number. */
const APARTMENT_NUMBER = String(
  Number.parseInt(suffix.slice(-6), 36) % 10_000_000,
);

beforeAll(async () => {
  prisma = new PrismaService(env);
  await prisma.$connect();
  encryption = new FieldEncryptionService(env);
  check = new RegisterCheckService(prisma, encryption);

  const email = (value: string) => encryption.encrypt("person.email", value);
  const residentEmail = await email(RESIDENT.email);
  const residentPhone = await encryption.encrypt(
    "person.phone",
    RESIDENT.phone,
  );
  const hiddenEmail = await email(HIDDEN.email);
  await prisma.person.create({
    data: {
      id: ids.resident,
      firstName: RESIDENT.givenName,
      lastName: RESIDENT.familyName,
      emailCipher: residentEmail.cipher,
      emailIndex: residentEmail.index,
      phoneCipher: residentPhone.cipher,
      phoneIndex: residentPhone.index,
    },
  });
  await prisma.person.create({
    data: {
      id: ids.hidden,
      firstName: HIDDEN.givenName,
      lastName: HIDDEN.familyName,
      emailCipher: hiddenEmail.cipher,
      emailIndex: hiddenEmail.index,
      protectedPersonalData: true,
    },
  });
  await prisma.address.create({
    data: {
      id: ids.address,
      street: `Kontrollgatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Staden",
    },
  });
  await prisma.apartment.create({
    data: {
      id: ids.apartment,
      addressId: ids.address,
      number: APARTMENT_NUMBER,
    },
  });
});

afterAll(async () => {
  try {
    await prisma.apartment.deleteMany({ where: { id: ids.apartment } });
    await prisma.address.deleteMany({ where: { id: ids.address } });
    await prisma.person.deleteMany({
      where: { id: { in: [ids.resident, ids.hidden] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

/** The one item's matches, as the editor would show them. */
async function shown(text: string) {
  const [matches = []] = await check.matches([[text]]);
  return withheldFromDevices(matches);
}

describe("RegisterCheckService", () => {
  it("passes text that names nobody the register holds", async () => {
    await expect(shown("Städdag på gården, alla är välkomna.")).resolves.toBe(
      null,
    );
  });

  it("finds a resident's family name and given name", async () => {
    await expect(
      shown(`Tack till ${RESIDENT.familyName.toLowerCase()} för grillen.`),
    ).resolves.toEqual({
      words: [RESIDENT.familyName.toLowerCase()],
      unshownWords: false,
    });
    await expect(shown(`${RESIDENT.givenName}s cykel`)).resolves.toEqual({
      words: [`${RESIDENT.givenName}s`],
      unshownWords: false,
    });
  });

  it("finds an email address the register holds, whatever its case", async () => {
    await expect(
      shown(`Frågor till ${RESIDENT.email.toUpperCase()}.`),
    ).resolves.toEqual({
      words: [RESIDENT.email.toUpperCase()],
      unshownWords: false,
    });
  });

  it("finds a phone number the register holds, however it is spaced", async () => {
    // +4676 1234567 written the way a notice would: 076-123 45 67.
    const national = `0${RESIDENT.phone.slice(3)}`;
    const spaced = `${national.slice(0, 3)}-${national.slice(3, 6)} ${national.slice(6, 8)} ${national.slice(8)}`;

    const result = await shown(`Ring ${spaced} vid frågor.`);

    expect(result?.words).toEqual([national]);
  });

  it("finds an apartment number the register holds", async () => {
    await expect(
      shown(`Nyckeln till lgh ${APARTMENT_NUMBER}.`),
    ).resolves.toEqual({ words: [APARTMENT_NUMBER], unshownWords: false });
  });

  it("finds a person with protected personal data, and does not show the words", async () => {
    await expect(
      shown(`Välkommen ${HIDDEN.givenName} ${HIDDEN.familyName}!`),
    ).resolves.toEqual({ words: [], unshownWords: true });
    await expect(shown(`Mejla ${HIDDEN.email}`)).resolves.toEqual({
      words: [],
      unshownWords: true,
    });
  });

  it("checks several items against one read of the register", async () => {
    const register = await check.load();

    await expect(
      register.passes([
        ["Städdag på gården", null],
        ["Städdag", `Hos ${RESIDENT.familyName}`],
        [null, ""],
      ]),
    ).resolves.toEqual([true, false, true]);
  });
});
