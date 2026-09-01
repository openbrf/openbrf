import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  addLocalDays,
  formatLocalDay,
  localDayOf,
} from "../bookings/stockholm-calendar";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import type { ApartmentRegisterExtract } from "./apartment-register.service";
import type { MemberRegisterExtract } from "./member-register.service";

/**
 * The two statutory registers over HTTP, against a real database.
 *
 * What this suite defends is the separation and the field lists, both of which
 * are legal rather than aesthetic:
 *
 *   The member register extract is public on request, so it must never carry a
 *   personal identity number - and no parameter may add one.
 *
 *   The apartment register is confidential, so a resident who holds nothing
 *   must not reach it, a tenant-owner must reach their own entry and only
 *   theirs, and every copy carrying identity numbers must land in the audit
 *   log naming who took it.
 *
 *   The three dates the cooperative housing register reports run on - a
 *   termination, the membership decision behind a transfer, and the property
 *   designation - are recordable, audited, and refused where the register could
 *   only hold a date nobody decided on (Lag (2026:484) 3 kap.).
 *
 *   Each of those dates that opens a reporting window enters the obligation
 *   ledger in the same transaction as the register write, counted from the day
 *   the statute names and no other, and the register write disappears if the
 *   deadline cannot be entered.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
const surname = `Regman${suffix}`;

const addressId = `reg-address-${suffix}`;
const apartments = {
  held: `reg-apartment-a-${suffix}`,
  other: `reg-apartment-b-${suffix}`,
};

const actors = {
  board: {
    personId: `reg-board-${suffix}`,
    email: `reg-board-${suffix}@exempel.se`,
  },
  member: {
    personId: `reg-member-${suffix}`,
    email: `reg-member-${suffix}@exempel.se`,
    /*
     * Per run, and checksum-valid. These were literals, and two of the three
     * were numbers the demo data also holds - a blind index makes that the
     * answer to a lookup about somebody else's person, and this suite leaves
     * rows behind that the register keeps.
     */
    personalIdentityNumber: runIdentityNumber(`${suffix}-member`),
  },
  protectedMember: {
    personId: `reg-protected-${suffix}`,
    email: `reg-protected-${suffix}@exempel.se`,
    personalIdentityNumber: runIdentityNumber(`${suffix}-protected`),
  },
  /**
   * Held the same apartment before the current member. Carries a number of
   * their own, so a holder's own extract has something it must refuse.
   */
  formerMember: {
    personId: `reg-former-${suffix}`,
    email: `reg-former-${suffix}@exempel.se`,
    personalIdentityNumber: runIdentityNumber(`${suffix}-former`),
  },
  resident: {
    personId: `reg-resident-${suffix}`,
    email: `reg-resident-${suffix}@exempel.se`,
  },
} as const;

const personIds = Object.values(actors).map((actor) => actor.personId);

/**
 * The transfer this suite records a membership decision against.
 *
 * Its own id rather than the one the fixture writes, because the fixture's
 * transfer is read by the extract assertions and a date recorded on it would
 * change what those see. A transfer row cannot be deleted, so it stays behind
 * with the archive like everything else this suite writes.
 */
const UNDECIDED_TRANSFER_ID = `reg-transfer-undecided-${suffix}`;

/**
 * A second one, for the refusals.
 *
 * The already-recorded conflict is checked before the date is, which is the
 * right order - telling a board its date is wrong when the real answer is that
 * the deadline is already set would be a misleading refusal. It also means a
 * refusal test cannot reuse a transfer a successful test has completed.
 */
const REFUSED_TRANSFER_ID = `reg-transfer-refused-${suffix}`;

/**
 * Whether this suite created the association singleton, and what it held.
 *
 * The test template carries no association, but suites share one database per
 * worker and the first-boot suite asserts on its absence. So this one puts it
 * back the way it found it: removed if this suite made it, and with its
 * designation restored if it did not.
 */
let createdAssociation = false;
let previousDesignation: string | null = null;

/**
 * The same, for the association facts row this suite writes prose into.
 *
 * association_facts is service tier and purgeable, not the append-only archive,
 * so a row left behind here is a leftover rather than the exception the law
 * requires. Its id is fixed at 1 like the singleton above, and the value this
 * suite writes carries the run's suffix, so without this every run would
 * overwrite the last and any suite reading association facts would see a value
 * no fixture of its own wrote.
 */
let createdAssociationFacts = false;
let previousFactsDesignation: string | null = null;

let ipCounter = 0;
/**
 * Every shape the stored twelve digits can reach a page as.
 *
 * A masking assertion that names only the stored form goes green while a view
 * prints the conventional YYMMDD-NNNC one - which is the shape a person reads,
 * and therefore the shape a leak most likely takes. The fixture used to be
 * written with the hyphen, so naming the stored form alone happened to cover it;
 * with a generated twelve-digit number it no longer does.
 */
function writtenForms(identityNumber: string): string[] {
  const short = identityNumber.slice(2);
  return [
    identityNumber,
    `${identityNumber.slice(0, 8)}-${identityNumber.slice(8)}`,
    short,
    `${short.slice(0, 6)}-${short.slice(6)}`,
  ];
}

/** Fails if a personal identity number reaches the body in any written form. */
function expectNoIdentityNumber(body: string, identityNumber: string): void {
  for (const form of writtenForms(identityNumber)) {
    expect(body).not.toContain(form);
  }
}

/**
 * The calendar date a `@db.Date` column holds, as "YYYY-MM-DD".
 *
 * Read as UTC, which is what a date column is written and read back as. Slicing
 * a locally anchored instant would answer the previous day for part of the year,
 * and every date these assertions are about is the start or the end of a
 * statutory window.
 */
function isoDay(column: Date | null | undefined): string | null {
  return column === null || column === undefined
    ? null
    : column.toISOString().slice(0, 10);
}

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
        // 10.32.0.0/16 is this suite's; the others each hold their own second
        // octet, so one suite's requests never count against another's
        // rate-limit budget.
        "x-forwarded-for": `10.32.0.${String(ipCounter % 250)}`,
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
  email: string;
  personalIdentityNumber?: string;
  protectedPersonalData?: boolean;
}): Promise<void> {
  const email = await encryption.encrypt("person.email", input.email);
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
      postalStreet: "Bokgatan 1",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      personalIdentityNumberCipher: identityNumber?.cipher ?? null,
      personalIdentityNumberIndex: identityNumber?.index ?? null,
      protectedPersonalData: input.protectedPersonalData ?? false,
      preferredLocale: "sv",
    },
  });
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

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Regstigen",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 910,
    },
  });
  await prisma.apartment.createMany({
    data: [
      {
        id: apartments.held,
        addressId,
        number: "1101",
        floor: 1,
        participationShare: "0.02380952",
        initialShareCapital: "125000.00",
      },
      {
        id: apartments.other,
        addressId,
        number: "1102",
        floor: 1,
        participationShare: "0.01190476",
        initialShareCapital: "98000.00",
      },
    ],
  });

  await createPerson({
    personId: actors.board.personId,
    firstName: "Bea",
    email: actors.board.email,
  });
  await createPerson({
    personId: actors.member.personId,
    firstName: "Mira",
    email: actors.member.email,
    personalIdentityNumber: actors.member.personalIdentityNumber,
  });
  await createPerson({
    personId: actors.protectedMember.personId,
    firstName: "Petra",
    email: actors.protectedMember.email,
    personalIdentityNumber: actors.protectedMember.personalIdentityNumber,
    protectedPersonalData: true,
  });
  await createPerson({
    personId: actors.formerMember.personId,
    firstName: "Frida",
    email: actors.formerMember.email,
    personalIdentityNumber: actors.formerMember.personalIdentityNumber,
  });
  await createPerson({
    personId: actors.resident.personId,
    firstName: "Rita",
    email: actors.resident.email,
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: actors.member.personId,
        apartmentId: apartments.held,
        role: "MEMBER",
        movedInOn: new Date("2019-06-01T00:00:00.000Z"),
      },
      {
        personId: actors.protectedMember.personId,
        apartmentId: apartments.other,
        role: "MEMBER",
        movedInOn: new Date("2021-02-01T00:00:00.000Z"),
      },
      {
        personId: actors.resident.personId,
        apartmentId: apartments.other,
        role: "RESIDENT",
        movedInOn: new Date("2021-02-01T00:00:00.000Z"),
      },
      {
        personId: actors.formerMember.personId,
        apartmentId: apartments.held,
        role: "MEMBER",
        movedInOn: new Date("2012-01-01T00:00:00.000Z"),
        movedOutOn: new Date("2019-05-31T00:00:00.000Z"),
      },
    ],
  });

  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: actors.member.personId,
        apartmentId: apartments.held,
        eventType: "ENTRY",
        eventOn: new Date("2019-06-01T00:00:00.000Z"),
        recordedFirstName: "Mira",
        recordedLastName: surname,
        recordedPostalStreet: "Bokgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: actors.protectedMember.personId,
        apartmentId: apartments.other,
        eventType: "ENTRY",
        eventOn: new Date("2021-02-01T00:00:00.000Z"),
        recordedFirstName: "Petra",
        recordedLastName: surname,
        recordedPostalStreet: "Bokgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: actors.formerMember.personId,
        apartmentId: apartments.held,
        eventType: "ENTRY",
        eventOn: new Date("2012-01-01T00:00:00.000Z"),
        recordedFirstName: "Frida",
        recordedLastName: surname,
        recordedPostalStreet: "Gamla vagen 4",
        recordedPostalCode: "11133",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: actors.formerMember.personId,
        apartmentId: apartments.held,
        eventType: "EXIT",
        eventOn: new Date("2019-05-31T00:00:00.000Z"),
        recordedFirstName: "Frida",
        recordedLastName: surname,
        recordedPostalStreet: "Gamla vagen 4",
        recordedPostalCode: "11133",
        recordedPostalCity: "Stockholm",
      },
    ],
  });

  await prisma.transfer.create({
    data: {
      apartmentId: apartments.held,
      fromPersonId: actors.formerMember.personId,
      toPersonId: actors.member.personId,
      transferredOn: new Date("2019-06-01T00:00:00.000Z"),
      price: "3450000.00",
      agreementReference: `Overlatelseavtal ${suffix}`,
    },
  });

  await prisma.transfer.createMany({
    data: [
      {
        id: UNDECIDED_TRANSFER_ID,
        apartmentId: apartments.other,
        fromPersonId: null,
        toPersonId: actors.protectedMember.personId,
        transferredOn: new Date("2021-02-01T00:00:00.000Z"),
        // No membershipDecidedOn: the state every transfer recorded before
        // that column existed is in, and the one the board is asked to
        // complete.
        agreementReference: `Upplatelseavtal ${suffix}`,
      },
      {
        id: REFUSED_TRANSFER_ID,
        apartmentId: apartments.other,
        fromPersonId: actors.protectedMember.personId,
        toPersonId: actors.resident.personId,
        transferredOn: new Date("2022-05-01T00:00:00.000Z"),
        agreementReference: `Overlatelseavtal ${suffix}`,
      },
    ],
  });

  await prisma.lienNote.create({
    data: {
      apartmentId: apartments.held,
      creditor: `Bokbanken ${suffix}`,
      notedOn: new Date("2019-06-15T00:00:00.000Z"),
      amount: "1500000.00",
    },
  });

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { propertyDesignation: true },
  });
  if (association === null) {
    await prisma.association.create({
      data: { id: 1, name: `Brf Registret ${suffix}` },
    });
    createdAssociation = true;
  } else {
    previousDesignation = association.propertyDesignation;
  }

  const facts = await prisma.associationFacts.findUnique({
    where: { id: 1 },
    select: { propertyDesignation: true },
  });
  if (facts === null) {
    createdAssociationFacts = true;
  } else {
    previousFactsDesignation = facts.propertyDesignation;
  }

  await prisma.boardPosition.create({
    data: {
      personId: actors.board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15T00:00:00.000Z"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.board, actors.member, actors.resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterAll(async () => {
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.lienNote.updateMany({
    where: { apartmentId: { in: Object.values(apartments) } },
    data: { releasedOn: new Date() },
  });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: { propertyDesignation: previousDesignation },
    });
  }
  if (createdAssociationFacts) {
    await prisma.associationFacts.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.associationFacts.updateMany({
      where: { id: 1 },
      data: { propertyDesignation: previousFactsDesignation },
    });
  }
  // The statutory archive is append-only, so the register entries, transfers,
  // terminations, lien notes and reporting obligations this suite wrote stay.
  // Their apartments and persons stay with them: a foreign key from an
  // undeletable row is what keeps the archive readable, and deleting around it
  // is exactly what the guards prevent.
  await app.close();
});

describe("who may read the member register", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/member-register",
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/member-register",
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("admits a board member", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/member-register",
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("the member register extract", () => {
  async function extract(scope: "current" | "all"): Promise<{
    body: string;
    value: MemberRegisterExtract;
  }> {
    const response = await inject({
      method: "GET",
      url: `/api/member-register?scope=${scope}`,
      headers: { cookie: await signIn(actors.board.email) },
    });
    return {
      body: response.body,
      value: JSON.parse(response.body) as MemberRegisterExtract,
    };
  }

  it("never carries a personal identity number", async () => {
    // The extract is public on request. There is no caller, parameter or role
    // that adds one: the query does not select the column.
    const { body } = await extract("all");

    expect(body).not.toContain("personalIdentityNumber");
    expectNoIdentityNumber(body, actors.member.personalIdentityNumber);
  });

  it("carries no apartment register content either", async () => {
    const { body } = await extract("all");

    expect(body).not.toContain("initialShareCapital");
    expect(body).not.toContain("125000");
    expect(body).not.toContain("lien");
  });

  it("lists a current member with the statutory fields", async () => {
    const { value } = await extract("current");
    const row = value.rows.find(
      (candidate) => candidate.personId === actors.member.personId,
    );

    expect(row).toBeDefined();
    expect(row?.enteredOn).toBe("2019-06-01");
    expect(row?.exitedOn).toBeNull();
    expect(row?.postalAddress).toEqual({
      state: "visible",
      street: "Bokgatan 1",
      postalCode: "11122",
      city: "Stockholm",
    });
    expect(row?.apartments.map((apartment) => apartment.number)).toEqual([
      "1101",
    ]);
  });

  it("leaves an ended membership out of the current list and shows it in the full one", async () => {
    const current = await extract("current");
    const all = await extract("all");

    expect(current.value.rows.map((row) => row.personId)).not.toContain(
      actors.formerMember.personId,
    );

    const former = all.value.rows.find(
      (row) => row.personId === actors.formerMember.personId,
    );
    expect(former?.enteredOn).toBe("2012-01-01");
    expect(former?.exitedOn).toBe("2019-05-31");
    // An ended membership prints the address recorded at the time, so the
    // archive stays truthful about someone who has since moved.
    expect(former?.postalAddress).toEqual({
      state: "visible",
      street: "Gamla vagen 4",
      postalCode: "11133",
      city: "Stockholm",
    });
  });

  it("masks a protected member's postal address", async () => {
    const { value, body } = await extract("all");
    const row = value.rows.find(
      (candidate) => candidate.personId === actors.protectedMember.personId,
    );

    // The name stays: the register is a list of members and the statute
    // compels it. Where they live is what protection withholds.
    expect(row?.protectedPersonalData).toBe(true);
    expect(row?.postalAddress).toEqual({
      state: "masked",
      alternativePostalAddress: null,
    });
    expect(body).not.toContain(actors.protectedMember.email);
  });

  it("names the housing cooperative the extract is from", async () => {
    const { value } = await extract("current");

    expect(typeof value.housingCooperative.name).toBe("string");
    expect(value.generatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("writes an audit entry for every extract taken", async () => {
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        actorPersonId: actors.board.personId,
      },
    });

    await extract("current");

    const after = await prisma.auditLogEntry.findMany({
      where: {
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        actorPersonId: actors.board.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(after.length).toBe(before + 1);
    expect(after[0]?.context).toMatchObject({ scope: "current" });
  });
});

describe("who may read the apartment register", () => {
  it("refuses a resident who holds no tenant-ownership", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register",
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses even a tenant-owner the whole register", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register",
      headers: { cookie: await signIn(actors.member.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("admits the board", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register",
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("the apartment register extract", () => {
  async function boardExtract(query = ""): Promise<ApartmentRegisterExtract> {
    const response = await inject({
      method: "GET",
      url: `/api/apartment-register${query}`,
      headers: { cookie: await signIn(actors.board.email) },
    });
    return JSON.parse(response.body) as ApartmentRegisterExtract;
  }

  it("carries the statutory field list", async () => {
    const extract = await boardExtract(`?apartmentId=${apartments.held}`);
    const row = extract.rows[0];

    expect(row?.designation).toContain("1101");
    expect(row?.initialShareCapital).toBe("125000");
    expect(row?.participationShare).toBe("0.02380952");
    expect(row?.holders.map((holder) => holder.personId)).toContain(
      actors.member.personId,
    );
    expect(row?.liens[0]?.notedOn).toBe("2019-06-15");
    expect(row?.transfers[0]?.agreementReference).toBe(
      `Overlatelseavtal ${suffix}`,
    );
  });

  it("masks the personal identity number by default", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/apartment-register?apartmentId=${apartments.held}`,
      headers: { cookie: await signIn(actors.board.email) },
    });
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    const holder = extract.rows[0]?.holders.find(
      (candidate) => candidate.personId === actors.member.personId,
    );

    expect(extract.identityNumbersIncluded).toBe(false);
    expect(holder?.personalIdentityNumber).toEqual({
      state: "masked",
      hasValue: true,
    });
    expectNoIdentityNumber(response.body, actors.member.personalIdentityNumber);
  });

  it("returns the numbers on the full statutory extract and logs who took it", async () => {
    const cookie = await signIn(actors.board.email);
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.board.personId,
        targetKind: "apartmentRegister",
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/reveal",
      payload: { apartmentId: apartments.held },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    const holder = extract.rows[0]?.holders.find(
      (candidate) => candidate.personId === actors.member.personId,
    );
    expect(extract.identityNumbersIncluded).toBe(true);
    expect(holder?.personalIdentityNumber).toEqual({
      state: "visible",
      value: actors.member.personalIdentityNumber,
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.board.personId,
        targetKind: "apartmentRegister",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entries.length).toBe(before + 1);
    // The entry names whose numbers the copy disclosed. A count would not
    // answer the only question worth asking afterwards. The board's copy is
    // the whole statutory document, so it names the previous holder too.
    expect(entries[0]?.context).toMatchObject({
      fields: ["personalIdentityNumber"],
      personIds: [actors.member.personId, actors.formerMember.personId],
    });
  });

  it("marks a protected holder so the copy is handled accordingly", async () => {
    const extract = await boardExtract(`?apartmentId=${apartments.other}`);
    const holder = extract.rows[0]?.holders.find(
      (candidate) => candidate.personId === actors.protectedMember.personId,
    );

    expect(holder?.protectedPersonalData).toBe(true);
  });

  it("carries no member register content", async () => {
    // The two documents are read under different rules and are never blended.
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register",
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.body).not.toContain("enteredOn");
    expect(response.body).not.toContain("exitedOn");
  });
});

describe("a tenant-owner's own entry", () => {
  it("returns the apartment they hold", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register/mine",
      headers: { cookie: await signIn(actors.member.email) },
    });

    expect(response.statusCode).toBe(200);
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    expect(extract.audience).toBe("holder");
    expect(extract.rows.map((row) => row.apartmentId)).toEqual([
      apartments.held,
    ]);
  });

  it("answers as if an apartment they do not hold did not exist", async () => {
    // A refusal on a specific apartment id would confirm to someone with no
    // right to know that the apartment exists.
    const response = await inject({
      method: "GET",
      url: `/api/apartment-register/mine?apartmentId=${apartments.other}`,
      headers: { cookie: await signIn(actors.member.email) },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns nothing at all to a resident who holds no tenant-ownership", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register/mine",
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(200);
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    expect(extract.rows).toEqual([]);
  });

  it("gives the holder their own identity number without the board's capability", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/mine/reveal",
      payload: {},
      headers: { cookie: await signIn(actors.member.email) },
    });

    expect(response.statusCode).toBe(200);
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    const own = extract.rows[0]?.holders.find(
      (holder) => holder.personId === actors.member.personId,
    );
    expect(own?.personalIdentityNumber).toEqual({
      state: "visible",
      value: actors.member.personalIdentityNumber,
    });
  });

  it("masks the previous holder's identity number on that same copy", async () => {
    // The apartment lists every holder it has ever had. The route carries no
    // protectedData:reveal precisely because the number being disclosed is the
    // caller's own, and that is only true while somebody else's stays masked.
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/mine/reveal",
      payload: {},
      headers: { cookie: await signIn(actors.member.email) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(
      actors.formerMember.personalIdentityNumber,
    );
    const extract = JSON.parse(response.body) as ApartmentRegisterExtract;
    const former = extract.rows[0]?.holders.find(
      (holder) => holder.personId === actors.formerMember.personId,
    );
    expect(former?.personalIdentityNumber).toEqual({
      state: "masked",
      hasValue: true,
    });
  });

  it("names only the holder's own number in the audit entry", async () => {
    const entriesBefore = await prisma.auditLogEntry.count({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.member.personId,
      },
    });

    await inject({
      method: "POST",
      url: "/api/apartment-register/mine/reveal",
      payload: {},
      headers: { cookie: await signIn(actors.member.email) },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.member.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entries.length).toBe(entriesBefore + 1);
    expect(entries[0]?.context).toMatchObject({
      personIds: [actors.member.personId],
    });
  });
});

describe("why a full extract was taken", () => {
  it("records the stated reason on the audit entry", async () => {
    // The reason a disclosure was made is the other half of the question a
    // data protection officer asks, so it is stored rather than validated and
    // dropped.
    const reason = `Overlatelse ${suffix}`;
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/reveal",
      payload: { apartmentId: apartments.held, reason },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(200);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.board.personId,
        targetKind: "apartmentRegister",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.context).toMatchObject({ reason });
  });

  it("says so when no reason was given", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/reveal",
      payload: { apartmentId: apartments.held },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(200);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.board.personId,
        targetKind: "apartmentRegister",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.context).toMatchObject({ reason: null });
  });
});

describe("recording a lien note", () => {
  it("is refused for a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/liens",
      payload: {
        apartmentId: apartments.held,
        creditor: "Nej",
        notedOn: "2026-01-01",
      },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("records it and shows it in the extract", async () => {
    const cookie = await signIn(actors.board.email);
    const created = await inject({
      method: "POST",
      url: "/api/apartment-register/liens",
      payload: {
        apartmentId: apartments.other,
        creditor: `Sparbanken ${suffix}`,
        notedOn: "2026-03-14",
        amount: "900000.00",
      },
      headers: { cookie },
    });

    expect(created.statusCode).toBe(201);
    const lien = JSON.parse(created.body) as { id: string; notedOn: string };
    expect(lien.notedOn).toBe("2026-03-14");

    const released = await inject({
      method: "POST",
      url: "/api/apartment-register/liens/release",
      payload: { lienId: lien.id, releasedOn: "2026-06-01" },
      headers: { cookie },
    });

    expect(released.statusCode).toBe(200);
    // Released rather than removed: the runtime role holds no DELETE on this
    // table, and a lien that was once recorded is part of the history.
    expect(JSON.parse(released.body) as { releasedOn: string }).toMatchObject({
      releasedOn: "2026-06-01",
    });
  });

  it("writes an audit entry for the note and for the release", async () => {
    // Changing the apartment register is logged like reading it. The record
    // covers changes as well as accesses, and a lien note carries a statutory
    // date of record on a row nobody can delete.
    const cookie = await signIn(actors.board.email);
    const created = await inject({
      method: "POST",
      url: "/api/apartment-register/liens",
      payload: {
        apartmentId: apartments.other,
        creditor: `Loggbanken ${suffix}`,
        notedOn: "2026-04-01",
      },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(201);
    const lien = JSON.parse(created.body) as { id: string };

    const noted = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "APARTMENT_REGISTER_LIEN_NOTED",
        targetKind: "lienNote",
        targetId: lien.id,
      },
    });
    expect(noted.actorPersonId).toBe(actors.board.personId);
    expect(noted.context).toMatchObject({
      apartmentId: apartments.other,
      notedOn: "2026-04-01",
    });

    const released = await inject({
      method: "POST",
      url: "/api/apartment-register/liens/release",
      payload: { lienId: lien.id, releasedOn: "2026-05-02" },
      headers: { cookie },
    });
    expect(released.statusCode).toBe(200);

    const releaseEntry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "APARTMENT_REGISTER_LIEN_RELEASED",
        targetKind: "lienNote",
        targetId: lien.id,
      },
    });
    expect(releaseEntry.actorPersonId).toBe(actors.board.personId);
    expect(releaseEntry.context).toMatchObject({ releasedOn: "2026-05-02" });
  });

  it("refuses a second release rather than rewriting the recorded date", async () => {
    // The release date is the statutory date of record on a row the database
    // will not let anyone delete. Overwriting it would lose the recorded date
    // with nothing left saying what it had been.
    const cookie = await signIn(actors.board.email);
    const created = await inject({
      method: "POST",
      url: "/api/apartment-register/liens",
      payload: {
        apartmentId: apartments.other,
        creditor: `Tvabanken ${suffix}`,
        notedOn: "2026-04-02",
      },
      headers: { cookie },
    });
    const lien = JSON.parse(created.body) as { id: string };

    const first = await inject({
      method: "POST",
      url: "/api/apartment-register/liens/release",
      payload: { lienId: lien.id, releasedOn: "2026-05-03" },
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await inject({
      method: "POST",
      url: "/api/apartment-register/liens/release",
      payload: { lienId: lien.id, releasedOn: "2026-09-30" },
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect((JSON.parse(second.body) as { reason: string }).reason).toBe(
      "lien-already-released",
    );

    const stored = await prisma.lienNote.findUniqueOrThrow({
      where: { id: lien.id },
      select: { releasedOn: true },
    });
    expect(stored.releasedOn?.toISOString().slice(0, 10)).toBe("2026-05-03");
  });
});

/**
 * A tenant-ownership that has ceased (upphorande).
 *
 * The event Lag (2026:484) 3 kap. 4 § makes the association report to the
 * cooperative housing register within two weeks. Nothing in this train computes
 * that window; what these tests defend is that the day it starts from is
 * recorded, audited, and impossible to state as a day nobody has reached.
 */
describe("recording a termination", () => {
  it("is refused for a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.held,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: "2026-01-01",
        reference: "Nej",
      },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("records it, shows it in the extract and writes the audit entry", async () => {
    const cookie = await signIn(actors.board.email);
    const created = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.other,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: "2026-02-18",
        reference: `Stammoprotokoll ${suffix}`,
      },
      headers: { cookie },
    });

    expect(created.statusCode).toBe(201);
    const termination = JSON.parse(created.body) as {
      id: string;
      kind: string;
      tookEffectOn: string;
    };
    expect(termination.tookEffectOn).toBe("2026-02-18");
    expect(termination.kind).toBe("GENERAL_MEETING_DECISION");

    const read = await inject({
      method: "GET",
      url: `/api/apartment-register?apartmentId=${apartments.other}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const extract = JSON.parse(read.body) as ApartmentRegisterExtract;
    // On the extract, not merely in the table: an entry listing holders and
    // transfers with nothing saying the right itself ended reads as though the
    // apartment were still held.
    expect(extract.rows[0]?.terminations).toEqual([
      {
        id: termination.id,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: "2026-02-18",
        reference: `Stammoprotokoll ${suffix}`,
      },
    ]);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "APARTMENT_REGISTER_TERMINATION_RECORDED",
        targetKind: "termination",
        targetId: termination.id,
      },
    });
    expect(entry.actorPersonId).toBe(actors.board.personId);
    expect(entry.context).toMatchObject({
      apartmentId: apartments.other,
      kind: "GENERAL_MEETING_DECISION",
      tookEffectOn: "2026-02-18",
    });

    /*
     * And the deadline, entered by the same transaction.
     *
     * Lag (2026:484) 3 kap. 4 § gives two weeks from the day the bostadsratt
     * ceased - tookEffectOn - and never from the day the board typed it in.
     * This termination was recorded today and dated the 18th of February 2026,
     * so a window counted from createdAt would fall in a different year
     * entirely.
     */
    const obligation = await prisma.registerReportObligation.findFirstOrThrow({
      where: { terminationId: termination.id },
      include: { termination: { select: { tookEffectOn: true } } },
    });

    expect(obligation.kind).toBe("TERMINATION");
    expect(obligation.apartmentId).toBe(apartments.other);
    expect(obligation.transferId).toBeNull();
    expect(isoDay(obligation.triggeredOn)).toBe("2026-02-18");
    expect(isoDay(obligation.dueOn)).toBe("2026-03-04");
    expect(isoDay(obligation.termination?.tookEffectOn)).toBe("2026-02-18");

    const deadlineEntry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "REGISTER_REPORT_OBLIGATION_RECORDED",
        targetKind: "registerReportObligation",
        targetId: obligation.id,
      },
    });
    expect(deadlineEntry.actorPersonId).toBe(actors.board.personId);
    expect(deadlineEntry.context).toMatchObject({
      kind: "TERMINATION",
      apartmentId: apartments.other,
      terminationId: termination.id,
      triggeredOn: "2026-02-18",
      dueOn: "2026-03-04",
    });
  });

  it("refuses a date that has not arrived", async () => {
    // A tenant-ownership that has not ceased cannot be reported as having
    // ceased, and the row could not be corrected afterwards.
    /*
     * Tomorrow on the association's calendar, not on UTC's. Sliced off an
     * instant, this reads yesterday's date for the first hour or two of every
     * Stockholm day - so between local midnight and 02:00 the "future" date
     * this sends is today, the guard rightly accepts it, and the test fails for
     * a reason that has nothing to do with what it is about. Which is the very
     * confusion the guard under test exists to prevent.
     */
    const tomorrow = formatLocalDay(addLocalDays(localDayOf(new Date()), 1));
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.held,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: tomorrow,
        reference: "Imorgon",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "date-in-the-future",
    );
  });

  it("refuses a day the calendar does not have", async () => {
    // The route's pattern accepts the shape, so this is the service refusing
    // the date rather than the schema refusing the string. Date.parse would
    // have answered the 2nd of March.
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.held,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: "2026-02-30",
        reference: "Finns inte",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "date-not-a-calendar-date",
    );
  });

  it("refuses a reference that is only whitespace", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.held,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: "2026-01-05",
        reference: "   ",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a ground that is not one of the two the statute distinguishes", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.held,
        kind: "BOARD_DECIDED",
        tookEffectOn: "2026-01-05",
        reference: "Hittepa",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
  });

  it("cannot be rewritten or removed once recorded", async () => {
    const cookie = await signIn(actors.board.email);
    const created = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.other,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: "2026-03-02",
        reference: `Kopeavtal ${suffix}`,
      },
      headers: { cookie },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    // Asked through the application's own client, which is how a bug in an
    // admin screen would ask. The database refuses either way, and the runtime
    // role holds no UPDATE or DELETE on this table at all.
    await expect(
      prisma.termination.update({
        where: { id },
        data: { tookEffectOn: new Date("2020-01-01T00:00:00.000Z") },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
    await expect(prisma.termination.delete({ where: { id } })).rejects.toThrow(
      /OPENBRF_STATUTORY_ARCHIVE/,
    );
  });
});

/**
 * The day the association decided on an acquirer's membership.
 *
 * Lag (2026:484) 3 kap. 3 § andra stycket runs the transfer report's two weeks
 * from this date rather than from the transfer, and it is minuted by the board
 * and nowhere else in this database. A transfer recorded without it cannot be
 * repaired later, which is why it is recordable now and not with the reporting
 * screen.
 */
describe("recording the membership decision behind a transfer", () => {
  it("is refused for a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: {
        transferId: UNDECIDED_TRANSFER_ID,
        membershipDecidedOn: "2021-01-14",
      },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("records it on the transfer and writes the audit entry", async () => {
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: {
        transferId: UNDECIDED_TRANSFER_ID,
        // Before the transfer, which is the ordinary order: the board approves
        // membership when it meets and the transfer completes on the
        // tilltradesdag. Nothing refuses that, because the statute does not.
        membershipDecidedOn: "2021-01-14",
      },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(
      JSON.parse(response.body) as { membershipDecidedOn: string },
    ).toMatchObject({ membershipDecidedOn: "2021-01-14" });

    const read = await inject({
      method: "GET",
      url: `/api/apartment-register?apartmentId=${apartments.other}`,
      headers: { cookie },
    });
    const extract = JSON.parse(read.body) as ApartmentRegisterExtract;
    const transfer = extract.rows[0]?.transfers.find(
      (candidate) => candidate.id === UNDECIDED_TRANSFER_ID,
    );
    expect(transfer?.membershipDecidedOn).toBe("2021-01-14");

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED",
        targetKind: "transfer",
        targetId: UNDECIDED_TRANSFER_ID,
      },
    });
    expect(entry.actorPersonId).toBe(actors.board.personId);
    expect(entry.context).toMatchObject({
      apartmentId: apartments.other,
      membershipDecidedOn: "2021-01-14",
      transferredOn: "2021-02-01",
    });

    /*
     * And the deadline, entered by the same transaction and counted from the
     * decision.
     *
     * The whole content of this assertion is which of the transfer's two dates
     * the window runs from. Lag (2026:484) 3 kap. 3 § andra stycket runs it from
     * the day the association decided on membership - the 14th of January, so
     * the 28th - and the transfer completed on the 1st of February, which would
     * give the 15th. Both are plausible-looking dates on a screen; only one is
     * the statutory one, and it is the earlier of the two, so counting from the
     * wrong date would state a deadline after the duty had already lapsed.
     */
    const obligation = await prisma.registerReportObligation.findFirstOrThrow({
      where: { transferId: UNDECIDED_TRANSFER_ID },
    });

    expect(obligation.kind).toBe("TRANSFER");
    expect(obligation.apartmentId).toBe(apartments.other);
    expect(obligation.terminationId).toBeNull();
    expect(isoDay(obligation.triggeredOn)).toBe("2021-01-14");
    expect(isoDay(obligation.dueOn)).toBe("2021-01-28");

    const deadlineEntry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "REGISTER_REPORT_OBLIGATION_RECORDED",
        targetKind: "registerReportObligation",
        targetId: obligation.id,
      },
    });
    expect(deadlineEntry.actorPersonId).toBe(actors.board.personId);
    expect(deadlineEntry.context).toMatchObject({
      kind: "TRANSFER",
      apartmentId: apartments.other,
      transferId: UNDECIDED_TRANSFER_ID,
      triggeredOn: "2021-01-14",
      dueOn: "2021-01-28",
    });
  });

  it("leaves a transfer with no recorded decision out of the ledger", async () => {
    // Not an omission. 3 kap. 3 § andra stycket runs the window from the
    // membership decision, so a transfer whose decision the board has not
    // recorded has no day to count from and no deadline to state. The fixture's
    // own transfer is the case: it carries none and never gets one here.
    const undecided = await prisma.transfer.findFirstOrThrow({
      where: { apartmentId: apartments.held, membershipDecidedOn: null },
      select: { id: true },
    });

    await expect(
      prisma.registerReportObligation.findUnique({
        where: { transferId: undecided.id },
      }),
    ).resolves.toBeNull();
  });

  it("refuses a second recording rather than moving the deadline", async () => {
    // The transfer table keeps UPDATE, so the database would accept a second
    // value. This date is the start of a statutory window, and overwriting it
    // would move a deadline with nothing left saying where it had been.
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: {
        transferId: UNDECIDED_TRANSFER_ID,
        membershipDecidedOn: "2021-06-30",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "membership-decision-already-recorded",
    );

    const stored = await prisma.transfer.findUniqueOrThrow({
      where: { id: UNDECIDED_TRANSFER_ID },
      select: { membershipDecidedOn: true },
    });
    expect(stored.membershipDecidedOn?.toISOString().slice(0, 10)).toBe(
      "2021-01-14",
    );
  });

  it("refuses a date that has not arrived", async () => {
    /*
     * Tomorrow on the association's calendar, not on UTC's. Sliced off an
     * instant, this reads yesterday's date for the first hour or two of every
     * Stockholm day - so between local midnight and 02:00 the "future" date
     * this sends is today, the guard rightly accepts it, and the test fails for
     * a reason that has nothing to do with what it is about. Which is the very
     * confusion the guard under test exists to prevent.
     */
    const tomorrow = formatLocalDay(addLocalDays(localDayOf(new Date()), 1));
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: {
        transferId: REFUSED_TRANSFER_ID,
        membershipDecidedOn: tomorrow,
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { reason: string }).reason).toBe(
      "date-in-the-future",
    );
  });

  it("answers a transfer it does not hold as if it did not exist", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: {
        transferId: `no-such-transfer-${suffix}`,
        membershipDecidedOn: "2021-01-14",
      },
      headers: { cookie: await signIn(actors.board.email) },
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * The register event and its deadline are one write.
 *
 * The whole reason the ledger is written by the register service rather than by
 * a job that scans for events afterwards: a scan can be missing a row, and the
 * row that goes missing is a statutory deadline nobody notices is absent. So the
 * two writes have to be one transaction, and what proves that is not the code
 * reading as though it were - it is the register write disappearing when the
 * ledger insert fails.
 *
 * Forced by putting a trigger on the ledger that refuses every insert, which
 * only this suite can do because it connects as the schema owner. Driven over
 * HTTP like everything else here, and that matters twice over: an endpoint
 * answering 201 while the deadline never landed is the same defect as an
 * unawaited insert, and both would pass a test that only read the database.
 */
describe("the obligation ledger and the event it is about", () => {
  /*
   * Named per run, like every fixture id in this file.
   *
   * A fixed name collides across concurrent runs: the second CREATE TRIGGER
   * fails, its cleanup drops the trigger anyway, and the first run then gets a
   * 201 where it expects the write to have been refused - a pass turning into a
   * failure in the other run, for a reason neither test mentions.
   */
  const REFUSE_INSERTS = `openbrf_test_refuse_obligation_insert_${suffix}`;

  /**
   * Refuses this suite's obligation inserts, for as long as the callback runs.
   *
   * Restricted by apartment rather than left table-wide. The trigger is on a
   * shared table, so an unconditional one refuses every connection's insert
   * while it exists - including the other suites that write register events -
   * and the WHEN clause keeps the refusal to the rows these two tests cause.
   *
   * CREATE OR REPLACE on the function, because the two tests below each install
   * and drop it: a run that died between them would otherwise leave the second
   * failing on a duplicate rather than on what it asserts.
   */
  async function withLedgerRefusingInserts(
    body: () => Promise<void>,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${REFUSE_INSERTS}()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'refused by the test';
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${REFUSE_INSERTS}
        BEFORE INSERT ON "register_report_obligation"
        FOR EACH ROW
        WHEN (NEW."apartmentId" IN ('${apartments.held}', '${apartments.other}'))
        EXECUTE FUNCTION ${REFUSE_INSERTS}()
    `);
    try {
      await body();
    } finally {
      // In a finally, because a failure here would leave the ledger unable to
      // accept an insert for every later suite sharing this worker's database.
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER ${REFUSE_INSERTS} ON "register_report_obligation"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${REFUSE_INSERTS}()`);
    }
  }

  it("rolls the termination back when the deadline cannot be entered", async () => {
    const reference = `Stammoprotokoll rollback ${suffix}`;

    await withLedgerRefusingInserts(async () => {
      const response = await inject({
        method: "POST",
        url: "/api/apartment-register/terminations",
        payload: {
          apartmentId: apartments.other,
          kind: "GENERAL_MEETING_DECISION",
          tookEffectOn: "2026-03-11",
          reference,
        },
        headers: { cookie: await signIn(actors.board.email) },
      });

      // Not a 201. A board told the termination was recorded, on an instance
      // where the deadline was not, would have no reason to look again - and the
      // row cannot be deleted, so there would be nothing to do about it.
      expect(response.statusCode).toBe(500);
    });

    // And nothing was written. A termination is append-only, so one committed
    // here would stay for good.
    await expect(
      prisma.termination.findFirst({ where: { reference } }),
    ).resolves.toBeNull();
  });

  it("rolls the membership decision back when the deadline cannot be entered", async () => {
    await withLedgerRefusingInserts(async () => {
      const response = await inject({
        method: "POST",
        url: "/api/apartment-register/membership-decision",
        payload: {
          transferId: REFUSED_TRANSFER_ID,
          membershipDecidedOn: "2022-04-04",
        },
        headers: { cookie: await signIn(actors.board.email) },
      });

      expect(response.statusCode).toBe(500);
    });

    // The date is claimed conditionally and refused a second time, so a value
    // committed without its deadline could never be completed: the transfer
    // would carry the start of a statutory window that the ledger has no row
    // for and no way to gain one.
    const transfer = await prisma.transfer.findUniqueOrThrow({
      where: { id: REFUSED_TRANSFER_ID },
      select: { membershipDecidedOn: true },
    });
    expect(transfer.membershipDecidedOn).toBeNull();
    await expect(
      prisma.registerReportObligation.findUnique({
        where: { transferId: REFUSED_TRANSFER_ID },
      }),
    ).resolves.toBeNull();
  });
});

/**
 * The association's authoritative property designation.
 *
 * The register the association reports into holds data about the
 * bostadsrattslagenhet (Lag (2026:484) 2 kap. 1 § forsta stycket 1), which the
 * association has to supply (Lag (2026:485) 3 §) except where it can be taken
 * from fastighetsregistret or lagenhetsregistret instead (6 §) - registers keyed
 * on this designation.
 */
describe("the association's property designation", () => {
  it("is refused for a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/property-designation",
      payload: { propertyDesignation: "Nej 1" },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("is recorded, appears on the extract, and is logged with what it replaced", async () => {
    const cookie = await signIn(actors.board.email);

    const first = await inject({
      method: "POST",
      url: "/api/apartment-register/property-designation",
      payload: { propertyDesignation: `Talgoxen ${suffix}` },
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const read = await inject({
      method: "GET",
      url: "/api/apartment-register",
      headers: { cookie },
    });
    const extract = JSON.parse(read.body) as ApartmentRegisterExtract;
    expect(extract.housingCooperative.propertyDesignation).toBe(
      `Talgoxen ${suffix}`,
    );

    // Corrected in place, unlike everything else in this train: a
    // fastighetsbildning renames a property, so the designation is the current
    // name and not a dated event. Which is why the entry has to carry both
    // values - "it was wrong for a year" is a question only the log can answer.
    const second = await inject({
      method: "POST",
      url: "/api/apartment-register/property-designation",
      payload: { propertyDesignation: `Notvackan ${suffix}` },
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "ASSOCIATION_PROPERTY_DESIGNATION_RECORDED",
        actorPersonId: actors.board.personId,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(entries[0]?.context).toMatchObject({
      from: `Talgoxen ${suffix}`,
      to: `Notvackan ${suffix}`,
    });
  });

  it("does not touch the prose the board publishes to a broker", async () => {
    // Two fields with one name, on purpose. association_facts is published
    // prose and its model comment forbids statutory data being derived from
    // it; this one is the register's. Writing one must not write the other.
    const facts = await prisma.associationFacts.upsert({
      where: { id: 1 },
      create: { id: 1, propertyDesignation: `Maklarprosan ${suffix}` },
      update: { propertyDesignation: `Maklarprosan ${suffix}` },
      select: { propertyDesignation: true },
    });
    expect(facts.propertyDesignation).toBe(`Maklarprosan ${suffix}`);

    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/property-designation",
      payload: { propertyDesignation: `Registret ${suffix}` },
      headers: { cookie: await signIn(actors.board.email) },
    });
    expect(response.statusCode).toBe(200);

    const after = await prisma.associationFacts.findUniqueOrThrow({
      where: { id: 1 },
      select: { propertyDesignation: true },
    });
    expect(after.propertyDesignation).toBe(`Maklarprosan ${suffix}`);
  });

  it("clears rather than stores an empty designation", async () => {
    // The register states a designation or says none is recorded. An empty
    // string is neither, and would print as a blank on a statutory document.
    const cookie = await signIn(actors.board.email);
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/property-designation",
      payload: { propertyDesignation: "   " },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(
      JSON.parse(response.body) as { propertyDesignation: string | null },
    ).toEqual({ propertyDesignation: null });
  });
});

describe("the member register archive itself", () => {
  it("cannot be rewritten, whatever the application asks", async () => {
    const entry = await prisma.memberRegisterEntry.findFirstOrThrow({
      where: { personId: actors.formerMember.personId, eventType: "EXIT" },
    });

    await expect(
      prisma.memberRegisterEntry.update({
        where: { id: entry.id },
        data: { eventOn: new Date("2020-01-01T00:00:00.000Z") },
      }),
    ).rejects.toThrow();
  });
});
