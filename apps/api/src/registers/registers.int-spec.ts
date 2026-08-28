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
import { loadEnvForIntegrationTests } from "../testing/integration-env";
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
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
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
    /** Synthetic and checksum-valid, as the demo fixtures are. */
    personalIdentityNumber: "121212-1212",
  },
  protectedMember: {
    personId: `reg-protected-${suffix}`,
    email: `reg-protected-${suffix}@exempel.se`,
    personalIdentityNumber: "811228-9874",
  },
  formerMember: {
    personId: `reg-former-${suffix}`,
    email: `reg-former-${suffix}@exempel.se`,
  },
  resident: {
    personId: `reg-resident-${suffix}`,
    email: `reg-resident-${suffix}@exempel.se`,
  },
} as const;

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
        "x-forwarded-for": `10.6.0.${String(ipCounter % 250)}`,
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

  await prisma.lienNote.create({
    data: {
      apartmentId: apartments.held,
      creditor: `Bokbanken ${suffix}`,
      notedOn: new Date("2019-06-15T00:00:00.000Z"),
      amount: "1500000.00",
    },
  });

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
  // The statutory archive is append-only, so the register entries, transfers
  // and lien notes this suite wrote stay. Their apartments and persons stay
  // with them: a foreign key from an undeletable row is what keeps the archive
  // readable, and deleting around it is exactly what the guards prevent.
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
    expect(body).not.toContain("121212-1212");
    expect(body).not.toContain("1212121212");
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
    expect(response.body).not.toContain("121212-1212");
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
    // answer the only question worth asking afterwards.
    expect(entries[0]?.context).toMatchObject({
      fields: ["personalIdentityNumber"],
      personIds: [actors.member.personId],
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
    expect(extract.rows[0]?.holders[0]?.personalIdentityNumber).toEqual({
      state: "visible",
      value: actors.member.personalIdentityNumber,
    });
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
