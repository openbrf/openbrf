import { randomInt } from "node:crypto";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { isValidPersonalIdentityNumber } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { computePurgeDate } from "../retention/purge-date";
import type { AddressBookRow } from "./address-book-view";

/**
 * The address book over HTTP, against a real database.
 *
 * The unit tests in address-book-view.spec.ts pin the masking rules. This suite
 * pins the things a pure function cannot: that the query does not load what the
 * viewer may not see, that the capability guard closes the board's endpoint to a
 * resident, that a reveal and its audit entry commit together, and that a blind
 * index really is equality-only. A mock of any of those would prove nothing -
 * the point is that the actual query, the actual guard and the actual cipher
 * behave as the matrix says.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let retentionDays: number;

/**
 * A token unique to this run, in letters only.
 *
 * Fixture ids, names and email addresses carry it so that one run's rows cannot
 * be taken for another's. It holds no digit, because a search term is matched
 * against apartment numbers by prefix as well as against names and blind
 * indexes: a digit inside a fixture email address would let a search for that
 * address also return rows this suite never created, and against a register
 * carrying the demo data, enough of them to fill the page. Base 26 leaves q to
 * z unused, so mapping the digits onto those letters keeps the token unique:
 * it carries the whole clock reading, which no two runs on one machine share.
 *
 * A fixture value that normalizes to digits is drawn separately, below, because
 * its format has no room for a reading this long.
 */
const suffix = process.hrtime
  .bigint()
  .toString(26)
  .replace(/\d/g, (digit) => "qrstuvwxyz".charAt(Number(digit)));

/**
 * The subscriber digits of this run's phone numbers.
 *
 * A phone number and a personal identity number reach their blind indexes
 * through normalizers that keep the digits and drop everything else, so the
 * letters above normalize away and cannot keep two runs' numbers apart. The
 * demo register holds fixed numbers of both kinds, and a fixture equal to one
 * of those collides on the first seeded database it meets.
 *
 * Unlike the token above, these values cannot carry a whole clock reading: the
 * format bounds them. A Swedish mobile number is 07X plus seven subscriber
 * digits, and this takes all seven, drawn rather than derived from the clock so
 * that runs an exact interval apart cannot land on the same value. Seven digits
 * is what the format has, so two runs carry the same numbers about once in ten
 * million; nothing coordinates between runs to rule that out. Each run deletes
 * its own rows, so the pair has to be a run overlapping with the leftovers of
 * one that died before its cleanup, and what it would look like is a second row
 * in the phone searches below.
 */
const phoneDigits = String(randomInt(10_000_000)).padStart(7, "0");

/**
 * A synthetic personal identity number for this run.
 *
 * This format holds less than it looks. The check digit is determined by the
 * nine digits before it, and a date has to be one that existed, so the room is
 * the birth date and the three-digit serial: 65 years x 12 months x 28 days x
 * 1000 serials, near enough 22 million numbers, which is the same order as the
 * phone numbers above. Days stop at 28 so that every draw is a date that
 * existed without month-length arithmetic; the 8 per cent of dates that gives
 * up costs about a tenth of a bit.
 *
 * The check digit comes from the production validator rather than a second Luhn
 * implementation here, so the fixture is exactly as valid as what the register
 * accepts. Luhn admits one check digit for any nine-digit prefix, so the loop
 * always finds it.
 */
function personalIdentityNumberForThisRun(): string {
  const year = String(1940 + randomInt(65));
  const month = String(1 + randomInt(12)).padStart(2, "0");
  const day = String(1 + randomInt(28)).padStart(2, "0");
  const serial = String(randomInt(1000)).padStart(3, "0");
  const birthDate = `${year}${month}${day}`;

  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${birthDate}-${serial}${String(checkDigit)}`;
    if (isValidPersonalIdentityNumber(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No check digit completes ${birthDate}-${serial}.`);
}

const PASSWORD = "a-long-enough-password";
const surname = `Boklund${suffix}`;

const addressId = `ab-address-${suffix}`;
const apartments = {
  first: `ab-apartment-a-${suffix}`,
  second: `ab-apartment-b-${suffix}`,
  third: `ab-apartment-c-${suffix}`,
};

const actors = {
  board: {
    personId: `ab-board-${suffix}`,
    email: `ab-board-${suffix}@exempel.se`,
  },
  resident: {
    personId: `ab-resident-${suffix}`,
    email: `ab-resident-${suffix}@exempel.se`,
    /** As a resident writes it, which is the shape the ciphertext keeps. */
    phone: `070-${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 5)} ${phoneDigits.slice(5, 7)}`,
    /** The same number for a caller abroad: both must land on one index. */
    phoneInternational: `+4670${phoneDigits}`,
    /** Synthetic and checksum-valid, as the demo fixtures are. */
    personalIdentityNumber: personalIdentityNumberForThisRun(),
  },
  protectedPerson: {
    personId: `ab-protected-${suffix}`,
    email: `ab-protected-${suffix}@exempel.se`,
    phone: `072-${phoneDigits.slice(0, 3)} ${phoneDigits.slice(3, 5)} ${phoneDigits.slice(5, 7)}`,
    /** Synthetic and checksum-valid, as the demo fixtures are. */
    personalIdentityNumber: personalIdentityNumberForThisRun(),
  },
  movedOut: {
    personId: `ab-moved-out-${suffix}`,
    email: `ab-moved-out-${suffix}@exempel.se`,
  },
  external: {
    personId: `ab-external-${suffix}`,
    email: `ab-external-${suffix}@exempel.se`,
  },
} as const;

const MOVED_OUT_ON = new Date("2020-01-01T00:00:00.000Z");

const personIds = Object.values(actors).map((actor) => actor.personId);

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": `10.4.0.${String(ipCounter % 250)}`,
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

async function createPerson(input: {
  personId: string;
  firstName: string;
  email?: string;
  phone?: string;
  personalIdentityNumber?: string;
  protectedPersonalData?: boolean;
}): Promise<void> {
  const email =
    input.email === undefined
      ? null
      : await encryption.encrypt("person.email", input.email);
  const phone =
    input.phone === undefined
      ? null
      : await encryption.encrypt("person.phone", input.phone);
  const identityNumber =
    input.personalIdentityNumber === undefined
      ? null
      : await encryption.encrypt(
          "person.personalIdentityNumber",
          input.personalIdentityNumber,
        );

  await prisma.person.create({
    data: {
      id: input.personId,
      firstName: input.firstName,
      lastName: surname,
      postalStreet: "Storgatan 12",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email?.cipher ?? null,
      emailIndex: email?.index ?? null,
      phoneCipher: phone?.cipher ?? null,
      phoneIndex: phone?.index ?? null,
      personalIdentityNumberCipher: identityNumber?.cipher ?? null,
      personalIdentityNumberIndex: identityNumber?.index ?? null,
      protectedPersonalData: input.protectedPersonalData ?? false,
      preferredLocale: "sv",
    },
  });
}

/** The board's own view of the fixture address. */
async function boardRows(
  cookie: string,
  query = "",
): Promise<{ statusCode: number; body: string; rows: AddressBookRow[] }> {
  const response = await inject({
    method: "GET",
    url: `/api/address-book?addressId=${addressId}${query}`,
    headers: { cookie },
  });
  const body = response.body;
  const rows =
    response.statusCode === 200
      ? (JSON.parse(body) as { rows: AddressBookRow[] }).rows
      : [];
  return { statusCode: response.statusCode, body, rows };
}

function rowFor(rows: AddressBookRow[], personId: string): AddressBookRow {
  const row = rows.find((candidate) => candidate.personId === personId);
  if (row === undefined) {
    throw new Error(`No row for person ${personId}`);
  }
  return row;
}

/**
 * The persons a page returned, sorted.
 *
 * A search assertion names the whole set of rows the term may return, because
 * one that only looks for the row it expects passes just as happily on a page
 * that was never filtered. Sorted, because the order rows arrive in is a
 * separate rule with its own test.
 */
function personIdsIn(rows: readonly { personId: string }[]): string[] {
  return rows.map((row) => row.personId).toSorted();
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);

  // Read the policy rather than setting it: the association row is a singleton
  // this suite has no business rewriting.
  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { retentionDaysAfterMoveOut: true },
  });
  retentionDays = association?.retentionDaysAfterMoveOut ?? 365;

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Bokgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 900,
    },
  });
  for (const [index, id] of Object.values(apartments).entries()) {
    await prisma.apartment.create({
      data: {
        id,
        addressId,
        number: String(1001 + index),
        floor: 0,
        participationShare: "0.02380952",
        // Apartment register content, confidential. Set here on purpose: the
        // address book must not return it, and a null would prove nothing.
        initialShareCapital: "125000.00",
      },
    });
  }

  await createPerson({
    personId: actors.board.personId,
    firstName: "Bea",
    email: actors.board.email,
  });
  await createPerson({
    personId: actors.resident.personId,
    firstName: "Rita",
    email: actors.resident.email,
    phone: actors.resident.phone,
    personalIdentityNumber: actors.resident.personalIdentityNumber,
  });
  await createPerson({
    personId: actors.protectedPerson.personId,
    firstName: "Petra",
    email: actors.protectedPerson.email,
    phone: actors.protectedPerson.phone,
    personalIdentityNumber: actors.protectedPerson.personalIdentityNumber,
    protectedPersonalData: true,
  });
  await createPerson({
    personId: actors.movedOut.personId,
    firstName: "Ulla",
    email: actors.movedOut.email,
  });
  await createPerson({
    personId: actors.external.personId,
    firstName: "Xenia",
    email: actors.external.email,
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: actors.board.personId,
        apartmentId: apartments.first,
        role: "MEMBER",
        movedInOn: new Date("2019-06-01T00:00:00.000Z"),
      },
      {
        personId: actors.resident.personId,
        apartmentId: apartments.second,
        role: "RESIDENT",
        movedInOn: new Date("2022-11-15T00:00:00.000Z"),
      },
      {
        personId: actors.protectedPerson.personId,
        apartmentId: apartments.second,
        role: "RESIDENT",
        movedInOn: new Date("2022-11-15T00:00:00.000Z"),
      },
      {
        personId: actors.movedOut.personId,
        apartmentId: apartments.third,
        role: "MEMBER",
        movedInOn: new Date("2015-02-01T00:00:00.000Z"),
        movedOutOn: MOVED_OUT_ON,
      },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: actors.board.personId,
        position: "CHAIR",
        electedOn: new Date("2025-05-15T00:00:00.000Z"),
      },
      {
        // An external board member: a person with no apartment at all.
        personId: actors.external.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2025-05-15T00:00:00.000Z"),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.board, actors.resident, actors.protectedPerson]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
  // The audit log is append-only by design, so entries this suite wrote stay.
  // They reference the actor by plain id rather than by foreign key precisely so
  // the register can be cleaned up without the log vetoing it.
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({
    where: { id: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { lastName: surname } });
  await prisma.apartment.deleteMany({ where: { addressId } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
});

describe("who may open the board's address book", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/address-book",
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, who has no addressBook:read", async () => {
    const cookie = await signIn(actors.resident.email);
    const { statusCode } = await boardRows(cookie);

    expect(statusCode).toBe(403);
  });

  it("admits a board member", async () => {
    const cookie = await signIn(actors.board.email);
    const { statusCode } = await boardRows(cookie);

    expect(statusCode).toBe(200);
  });
});

describe("the board's view", () => {
  it("shows contact details of a person who is not protected", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie);
    const row = rowFor(rows, actors.resident.personId);

    expect(row.contact).toEqual({
      state: "visible",
      email: actors.resident.email,
      phone: actors.resident.phone,
    });
  });

  it("masks a protected person and sends no plaintext at all", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows, body } = await boardRows(cookie);
    const row = rowFor(rows, actors.protectedPerson.personId);

    expect(row.contact).toEqual({
      state: "masked",
      hasEmail: true,
      hasPhone: true,
    });
    // The service does not decrypt a protected person's ciphers, so the values
    // are not merely hidden by the mapper: they never entered the process.
    expect(body).not.toContain(actors.protectedPerson.email);
    expect(body).not.toContain(actors.protectedPerson.phone);
    expect(row.signs).toContain("PROTECTED");
  });

  it("does not decrypt a protected person's ciphertext at all", async () => {
    // Masking at the mapper would hide the value; not decrypting means the
    // plaintext never exists in this process, so it cannot be logged, traced or
    // serialised by a later mistake either.
    const stored = await prisma.person.findUniqueOrThrow({
      where: { id: actors.protectedPerson.personId },
      select: { emailCipher: true, phoneCipher: true },
    });
    const plain = await prisma.person.findUniqueOrThrow({
      where: { id: actors.resident.personId },
      select: { emailCipher: true },
    });
    const cookie = await signIn(actors.board.email);
    const decrypt = vi.spyOn(encryption, "decrypt");

    try {
      await boardRows(cookie);
      const decrypted = decrypt.mock.calls.map(([, cipher]) => cipher);

      expect(decrypted).not.toContain(stored.emailCipher);
      expect(decrypted).not.toContain(stored.phoneCipher);
      // The positive half, so a spy that recorded nothing cannot pass this.
      expect(decrypted).toContain(plain.emailCipher);
    } finally {
      decrypt.mockRestore();
    }
  });

  it("never sends a personal identity number in a list", async () => {
    const cookie = await signIn(actors.board.email);
    const { body } = await boardRows(cookie);

    expect(body).not.toContain("personalIdentityNumber");
    for (const actor of [actors.resident, actors.protectedPerson]) {
      expect(body).not.toContain(actor.personalIdentityNumber);
      // The normalized twelve digits, which is the form an index or a careless
      // serializer would carry.
      expect(body).not.toContain(actor.personalIdentityNumber.replace("-", ""));
    }
  });

  it("never sends apartment register content: no liens, no initial share capital", async () => {
    // The apartment register (lagenhetsforteckning, BRL 9 kap.) is a separate
    // confidential document. Blending it into the address book would put share
    // capital in front of every board member's screen share.
    const cookie = await signIn(actors.board.email);
    const { body } = await boardRows(cookie);

    expect(body).not.toContain("initialShareCapital");
    expect(body).not.toContain("125000");
    expect(body).not.toContain("lienNote");
  });

  it("marks a moved-out residency and shows the derived purge date", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie);
    const row = rowFor(rows, actors.movedOut.personId);

    const expected = computePurgeDate(MOVED_OUT_ON, retentionDays);
    expect(row.signs).toContain("MOVED_OUT");
    expect(row.purgeOn).toBe(expected?.toISOString().slice(0, 10));
  });

  it("orders rows by apartment number, the way the name board reads", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie);
    const numbers = rows.map((row) => row.apartment?.number ?? "");

    expect(numbers).toEqual([...numbers].sort());
  });

  it("shows a trust sign for the chair", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie);

    expect(rowFor(rows, actors.board.personId).signs).toContain("CHAIR");
  });
});

describe("the on-board filters", () => {
  it("lists only current tenant-owners under members", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie, "&filter=members");
    const ids = rows.map((row) => row.personId);

    expect(ids).toContain(actors.board.personId);
    // A member who moved out is no longer a current member.
    expect(ids).not.toContain(actors.movedOut.personId);
    expect(ids).not.toContain(actors.resident.personId);
  });

  it("lists only ended residencies under moved out", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(cookie, "&filter=movedOut");

    expect(rows.map((row) => row.personId)).toEqual([actors.movedOut.personId]);
  });

  it("finds an external board member, who holds no apartment", async () => {
    // Exit criterion 3 requires an external board member with no apartment to
    // exist in the register, so the board view has to be able to show one.
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book?filter=board&search=${surname}`,
      headers: { cookie },
    });
    const { rows } = JSON.parse(response.body) as { rows: AddressBookRow[] };

    // The surname belongs to this run, so the two fixture people who hold a
    // position are the whole page. A list of every board member in the register
    // would contain this one too, and prove nothing about the search.
    expect(personIdsIn(rows)).toEqual(
      [actors.board.personId, actors.external.personId].toSorted(),
    );
    const external = rowFor(rows, actors.external.personId);
    expect(external.apartment).toBeNull();
    expect(external.signs).toEqual(["BOARD_MEMBER"]);
  });
});

describe("search", () => {
  /** Everyone this suite gave an apartment at the fixture address. */
  const atTheAddress = [
    actors.board.personId,
    actors.resident.personId,
    actors.protectedPerson.personId,
    actors.movedOut.personId,
  ].toSorted();

  it("matches a name incrementally", async () => {
    const cookie = await signIn(actors.board.email);

    // Everyone at this address carries the fixture surname, so a prefix of it
    // reaches all of them.
    const { rows } = await boardRows(cookie, `&search=${surname.slice(0, 6)}`);
    expect(personIdsIn(rows)).toEqual(atTheAddress);

    // A single first name narrows the same page to one row: a query that had
    // stopped narrowing would return the other three as well.
    const narrowed = await boardRows(cookie, "&search=Rita");
    expect(personIdsIn(narrowed.rows)).toEqual([actors.resident.personId]);
  });

  it("matches an apartment number incrementally", async () => {
    const cookie = await signIn(actors.board.email);

    // "100" is a prefix of all three fixture apartments.
    const { rows } = await boardRows(cookie, "&search=100");
    expect(personIdsIn(rows)).toEqual(atTheAddress);

    // The whole number reaches the two people who live in that apartment; the
    // neighbours in 1001 and 1003 are what a query that had stopped narrowing
    // would add.
    const narrowed = await boardRows(cookie, "&search=1002");
    expect(personIdsIn(narrowed.rows)).toEqual(
      [actors.resident.personId, actors.protectedPerson.personId].toSorted(),
    );
  });

  it("matches an email only on the complete address, through the blind index", async () => {
    const cookie = await signIn(actors.board.email);

    // An address belongs to one person, so one row is the whole answer.
    const whole = await boardRows(
      cookie,
      `&search=${encodeURIComponent(actors.resident.email)}`,
    );
    expect(personIdsIn(whole.rows)).toEqual([actors.resident.personId]);

    // A blind index answers equality and nothing else (ADR 0002). A fragment
    // finding nothing is the documented behaviour, not a bug - the UI says so.
    // It matches no name part and no apartment number either, so the empty page
    // is the complete result rather than one that merely hides this person.
    const fragment = await boardRows(
      cookie,
      `&search=${encodeURIComponent(actors.resident.email.slice(0, 12))}`,
    );
    expect(personIdsIn(fragment.rows)).toEqual([]);
  });

  it("matches a phone number written in a different shape", async () => {
    // The ciphertext holds the number as entered; the index holds the
    // normalized form, so "+4670..." finds a row stored as "070-...".
    const cookie = await signIn(actors.board.email);
    const { rows } = await boardRows(
      cookie,
      `&search=${encodeURIComponent(actors.resident.phoneInternational)}`,
    );

    expect(personIdsIn(rows)).toEqual([actors.resident.personId]);
  });
});

describe("the resident-facing directory", () => {
  it("is open to a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it("contains no contact data whatsoever", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie },
    });

    // Contact data is board-only (settled 2026-08-27): the column is absent,
    // not masked, so there is nothing for a client bug to reveal.
    expect(response.body).not.toContain("contact");
    expect(response.body).not.toContain(actors.resident.email);
    expect(response.body).not.toContain(actors.resident.phone);
    expect(response.body).not.toContain("purgeOn");
  });

  it("excludes a person with protected personal data entirely", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie },
    });
    const { rows } = JSON.parse(response.body) as {
      rows: { personId: string }[];
    };

    expect(rows.map((row) => row.personId)).not.toContain(
      actors.protectedPerson.personId,
    );
    expect(rows.map((row) => row.personId)).toContain(actors.resident.personId);
  });

  it("does not count a protected person towards the page either", async () => {
    // The exclusion has to happen in the query, not only in the mapper. A
    // protected person filtered out after the page was cut would leave a
    // resident with short pages and a total that does not match what they can
    // see - and would have loaded the row in the first place.
    const boardCookie = await signIn(actors.board.email);
    const residentCookie = await signIn(actors.resident.email);

    const board = await inject({
      method: "GET",
      url: `/api/address-book?addressId=${addressId}`,
      headers: { cookie: boardCookie },
    });
    const directory = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie: residentCookie },
    });

    const boardPage = JSON.parse(board.body) as {
      total: number;
      counts: { all: number };
      rows: { protectedPersonalData: boolean }[];
    };
    const residentPage = JSON.parse(directory.body) as {
      total: number;
      counts: { all: number };
      rows: unknown[];
    };

    // Derived rather than assumed. Another suite in this file flips the flag on
    // a second person at the same address and clears it again, so a hard-coded
    // delta of one would make this test depend on declaration order and fail
    // under --sequence.shuffle for a reason unrelated to the rule it defends.
    const protectedRows = boardPage.rows.filter(
      (row) => row.protectedPersonalData,
    ).length;

    expect(protectedRows).toBeGreaterThan(0);
    expect(residentPage.total).toBe(boardPage.total - protectedRows);
    expect(residentPage.counts.all).toBe(boardPage.counts.all - protectedRows);
    expect(residentPage.rows).toHaveLength(residentPage.total);
  });

  it("does not count a protected person in the header stats either", async () => {
    // The head count has to follow the same rule as the rows: a resident whose
    // board lists three names must not read "four persons" above them, because
    // the difference is exactly the protected people being hidden from them.
    const residentCookie = await signIn(actors.resident.email);
    const boardCookie = await signIn(actors.board.email);

    const directory = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie: residentCookie },
    });
    const board = await inject({
      method: "GET",
      url: `/api/address-book?addressId=${addressId}`,
      headers: { cookie: boardCookie },
    });

    const residentStats = (
      JSON.parse(directory.body) as { stats: { persons: number } }
    ).stats;
    const boardBody = JSON.parse(board.body) as {
      stats: { persons: number };
      rows: {
        personId: string;
        protectedPersonalData: boolean;
        signs: string[];
      }[];
    };

    // Derived, for the same reason as the test above. The head count counts
    // distinct persons whose residency is current, so the delta is the set of
    // protected persons who still live here - a protected row that has moved
    // out is in neither count and must not be subtracted from one of them.
    const hidden = new Set(
      boardBody.rows
        .filter(
          (row) =>
            row.protectedPersonalData && !row.signs.includes("MOVED_OUT"),
        )
        .map((row) => row.personId),
    );

    expect(hidden.size).toBeGreaterThan(0);
    expect(residentStats.persons).toBe(boardBody.stats.persons - hidden.size);
  });

  it("does not surface a protected person through search either", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}&search=Petra`,
      headers: { cookie },
    });
    const { rows } = JSON.parse(response.body) as {
      rows: { personId: string }[];
    };

    expect(rows).toEqual([]);
  });

  it("does not answer a contact-data question through the blind index", async () => {
    // Contact data is board-only, and so is the ability to test a value against
    // the register. An equality match on the blind index answers "is this number
    // on file for this person" from the presence of a row, without the value
    // ever appearing in the response - which is the board-only fact the absent
    // contact column exists to withhold. The same probe against a protected
    // person's number would be answered by the absence of one.
    //
    // Eleven digits cannot prefix-match a four-digit apartment number and match
    // no name part, so the phone blind index is the only route by which this
    // term can return a row. That is what makes the board's answer and the
    // resident's answer differ here.
    const term = encodeURIComponent(actors.resident.phoneInternational);

    const board = await inject({
      method: "GET",
      url: `/api/address-book?search=${term}`,
      headers: { cookie: await signIn(actors.board.email) },
    });
    const directory = await inject({
      method: "GET",
      url: `/api/resident-directory?search=${term}`,
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(
      personIdsIn(
        (JSON.parse(board.body) as { rows: { personId: string }[] }).rows,
      ),
    ).toEqual([actors.resident.personId]);
    expect(directory.statusCode).toBe(200);
    expect(
      (JSON.parse(directory.body) as { rows: unknown[]; total: number }).rows,
    ).toEqual([]);
    expect((JSON.parse(directory.body) as { total: number }).total).toBe(0);
  });

  it("shows a protected person their own entry", async () => {
    // Hiding it from them would read as the register having lost them, and
    // disclosing their own name to themselves discloses nothing.
    const cookie = await signIn(actors.protectedPerson.email);
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?addressId=${addressId}`,
      headers: { cookie },
    });
    const { rows } = JSON.parse(response.body) as {
      rows: { personId: string }[];
    };

    expect(rows.map((row) => row.personId)).toContain(
      actors.protectedPerson.personId,
    );
  });
});

describe("revealing a masked field", () => {
  it("is refused for a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.protectedPerson.personId}/reveal`,
      payload: { fields: ["email"] },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns the value to the board and logs the reveal in the same breath", async () => {
    const cookie = await signIn(actors.board.email);
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        targetPersonId: actors.protectedPerson.personId,
      },
    });

    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.protectedPerson.personId}/reveal`,
      payload: { fields: ["email", "phone"], reason: "Move-out paperwork" },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({
      email: actors.protectedPerson.email,
      phone: actors.protectedPerson.phone,
    });

    const after = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        targetPersonId: actors.protectedPerson.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(after).toHaveLength(before + 1);
    expect(after[0]?.actorPersonId).toBe(actors.board.personId);
    expect(after[0]?.context).toMatchObject({
      fields: ["email", "phone"],
      protectedPersonalData: true,
    });
  });

  it("reveals and logs an identity number on a person who is NOT protected", async () => {
    // The identity number is masked for everyone, protected flag or not, so a
    // reveal is the only route to one and every one of them is audited.
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.resident.personId}/reveal`,
      payload: { fields: ["personalIdentityNumber"] },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({
      personalIdentityNumber: actors.resident.personalIdentityNumber,
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        targetPersonId: actors.resident.personId,
      },
    });
    expect(entries[0]?.context).toMatchObject({
      fields: ["personalIdentityNumber"],
      protectedPersonalData: false,
    });
  });

  it("cannot be padded into an audit entry that overstates the reveal", async () => {
    // The entry recording who saw a personal identity number is the evidence a
    // supervisory authority asks for, so the caller must not be able to inflate
    // it. A repeated field is decrypted once and logged once; asking for more
    // fields than exist is refused rather than truncated.
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.resident.personId}/reveal`,
      payload: {
        fields: Array.from({ length: 50 }, () => "personalIdentityNumber"),
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);

    const deduplicated = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.resident.personId}/reveal`,
      payload: {
        fields: ["personalIdentityNumber", "personalIdentityNumber"],
      },
      headers: { cookie },
    });

    expect(deduplicated.statusCode).toBe(200);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        targetPersonId: actors.resident.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(entries[0]?.context).toMatchObject({
      fields: ["personalIdentityNumber"],
    });
  });

  it("refuses to reveal a field that is not masked", async () => {
    // An audit log padded with reveals of data the board already sees is an
    // audit log nobody reads.
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${actors.resident.personId}/reveal`,
      payload: { fields: ["email"] },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(422);
    const failure = JSON.parse(response.body) as { reason: string };
    expect(failure.reason).toBe("field-not-masked");
  });

  it("writes no audit entry when the person does not exist", async () => {
    const cookie = await signIn(actors.board.email);
    const missing = `ab-missing-${suffix}`;
    const response = await inject({
      method: "POST",
      url: `/api/address-book/persons/${missing}/reveal`,
      payload: { fields: ["personalIdentityNumber"] },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(
      await prisma.auditLogEntry.count({ where: { targetPersonId: missing } }),
    ).toBe(0);
  });
});

describe("the person view", () => {
  it("masks a protected person's postal address and offers the alternative", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${actors.protectedPerson.personId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const detail = JSON.parse(response.body) as {
      postalAddress: unknown;
    };
    expect(detail.postalAddress).toEqual({
      state: "masked",
      alternativePostalAddress: null,
    });
    expect(response.body).not.toContain("Storgatan 12");
    expect(response.body).not.toContain(actors.protectedPerson.email);
  });

  it("reports that an identity number exists without sending it", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${actors.protectedPerson.personId}`,
      headers: { cookie },
    });
    const detail = JSON.parse(response.body) as {
      hasPersonalIdentityNumber: boolean;
    };

    expect(detail.hasPersonalIdentityNumber).toBe(true);
    // Not even the birth date half of it, which a partial serialisation of the
    // field would carry.
    expect(response.body).not.toContain(
      actors.protectedPerson.personalIdentityNumber.slice(0, 8),
    );
  });

  it("derives membership from a current member residency", async () => {
    const cookie = await signIn(actors.board.email);
    const [member, movedOut] = await Promise.all(
      [actors.board.personId, actors.movedOut.personId].map(
        async (personId) => {
          const response = await inject({
            method: "GET",
            url: `/api/address-book/persons/${personId}`,
            headers: { cookie },
          });
          return JSON.parse(response.body) as { isMember: boolean };
        },
      ),
    );

    expect(member?.isMember).toBe(true);
    // Membership ends with the last member residency; the statutory exit entry
    // is what records it, not a flag on the person.
    expect(movedOut?.isMember).toBe(false);
  });

  it("is closed to a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${actors.board.personId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the protected personal data flag", () => {
  it("is audited when the board sets it", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "PATCH",
      url: `/api/address-book/persons/${actors.movedOut.personId}/protected-personal-data`,
      payload: { protectedPersonalData: true, reason: "Court order" },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_FLAG_CHANGED",
        targetPersonId: actors.movedOut.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(entries[0]?.context).toMatchObject({
      protectedPersonalData: true,
      previous: false,
    });
  });

  it("masks that person everywhere once set", async () => {
    const cookie = await signIn(actors.board.email);
    const { rows, body } = await boardRows(cookie, "&filter=movedOut");

    expect(rowFor(rows, actors.movedOut.personId).contact.state).toBe("masked");
    expect(body).not.toContain(actors.movedOut.email);
  });

  it("is audited when the board clears it again", async () => {
    const cookie = await signIn(actors.board.email);
    await inject({
      method: "PATCH",
      url: `/api/address-book/persons/${actors.movedOut.personId}/protected-personal-data`,
      payload: { protectedPersonalData: false },
      headers: { cookie },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_FLAG_CHANGED",
        targetPersonId: actors.movedOut.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    // Clearing the flag unmasks a person everywhere, so it is the direction the
    // log most needs to carry.
    expect(entries[0]?.context).toMatchObject({
      protectedPersonalData: false,
      previous: true,
    });
  });

  it("is refused for a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "PATCH",
      url: `/api/address-book/persons/${actors.board.personId}/protected-personal-data`,
      payload: { protectedPersonalData: true },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("adding a person", () => {
  it("stores contact data encrypted and searchable through the blind index", async () => {
    const cookie = await signIn(actors.board.email);
    const email = `ab-added-${suffix}@exempel.se`;

    const created = await inject({
      method: "POST",
      url: "/api/address-book/persons",
      payload: {
        firstName: "Nils",
        lastName: surname,
        email,
        phone: `073${phoneDigits}`,
      },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(201);
    const { personId } = JSON.parse(created.body) as { personId: string };

    const stored = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { emailCipher: true, emailIndex: true },
    });
    expect(stored.emailCipher).not.toContain(email);
    expect(stored.emailIndex).not.toBeNull();

    const found = await inject({
      method: "GET",
      url: `/api/address-book?search=${encodeURIComponent(email)}`,
      headers: { cookie },
    });
    const { rows } = JSON.parse(found.body) as { rows: AddressBookRow[] };
    // The address is unique to this run, so a search of the whole register
    // returns this person and nobody else. Finding the person merely among the
    // rows would pass on a page the term never filtered, and would fail on a
    // register large enough to push the new row off that page.
    expect(personIdsIn(rows)).toEqual([personId]);
  });

  it("refuses a personal identity number that fails its own checksum", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: "/api/address-book/persons",
      payload: {
        firstName: "Fel",
        lastName: surname,
        personalIdentityNumber: "811228-9875",
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    const failure = JSON.parse(response.body) as { reason: string };
    expect(failure.reason).toBe("invalid-personal-identity-number");
  });

  it("is refused for a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "POST",
      url: "/api/address-book/persons",
      payload: { firstName: "Nej", lastName: surname },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the apartment view", () => {
  it("carries residents and history but no apartment register content", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book/apartments/${apartments.second}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const detail = JSON.parse(response.body) as {
      number: string;
      participationShare: string | null;
      residents: { personId: string }[];
    };
    expect(detail.number).toBe("1002");
    expect(detail.residents.map((resident) => resident.personId)).toContain(
      actors.resident.personId,
    );
    // Participation share drives fee allocation and belongs here; initial share
    // capital and lien notes are apartment register content and do not.
    expect(detail.participationShare).toBe("0.02380952");
    expect(response.body).not.toContain("initialShareCapital");
    expect(response.body).not.toContain("125000");
    expect(response.body).not.toContain("lien");
  });

  it("is closed to a resident", async () => {
    const cookie = await signIn(actors.resident.email);
    const response = await inject({
      method: "GET",
      url: `/api/address-book/apartments/${apartments.second}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});
