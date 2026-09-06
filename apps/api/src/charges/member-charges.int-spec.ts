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
import type { DataSubjectReport } from "../retention/data-subject-report";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { DebitingList, DebitingListRow } from "./debiting-list";
import { MemberChargePurgeService } from "./member-charge-purge.service";
import type { DebitingListExport } from "./member-charge.service";

/**
 * Charges to members, against a real database.
 *
 * What a unit test cannot show, and nothing else.
 *
 * **The table refuses a row the service would refuse.** Exactly one of the
 * person and the apartment, a positive amount, a rate that belongs to its
 * treatment. Those are check constraints, and a constraint has no meaning
 * against a mock - the API refuses each of them first with a reason code, and
 * this is what makes the invariant the table's rather than one function's.
 *
 * **The personal identity number scan reaches the reason on the way in and on
 * every later edit.** The reason travels into a file that leaves the
 * association, so a number pasted into it on a correction has to be refused by
 * the same rule that refuses it on the first write, and the refusal names the
 * field it was found in.
 *
 * **A protected person's apartment does not reach the list or the file.** The
 * masking rule is the member register extract's, and it is asserted through the
 * endpoint against a real protected person rather than against a hand-built row.
 *
 * **The board's capability is the whole gate.** A resident holds nothing here -
 * there is no resident-facing half of this module - and neither does the
 * external property manager.
 *
 * **Every charge reaches the data subject access report**, by both routes: the
 * ones naming the person, and the ones put on an apartment while they were
 * living in it. A new store of personal data missing from that document is the
 * one failure it cannot have, so it is asserted here rather than left to the
 * report's own suite.
 *
 * **The purge erases on the charge's own calendar clock and a legal hold stops
 * it**, for a person and for an apartment, for real rows.
 *
 * **An apartment carrying a charge cannot be removed from the register**, and
 * the refusal names the record in the way rather than surfacing as a foreign key
 * error.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `mc-address-${suffix}`;
const apartmentId = `mc-apartment-${suffix}`;
const secondApartmentId = `mc-apartment-2-${suffix}`;

const board = {
  personId: `mc-board-${suffix}`,
  email: `mc-board-${suffix}@exempel.se`,
};
const member = {
  personId: `mc-member-${suffix}`,
  email: `mc-member-${suffix}@exempel.se`,
};
/** A resident the register masks, so the list has an apartment to withhold. */
const skyddad = {
  personId: `mc-skyddad-${suffix}`,
  email: `mc-skyddad-${suffix}@exempel.se`,
};
const manager = {
  personId: `mc-manager-${suffix}`,
  email: `mc-manager-${suffix}@exempel.se`,
};
/**
 * A former member the purge tests own outright.
 *
 * Nothing else charges them, so the count in the purge's audit entry is an
 * exact assertion rather than one about whatever the rest of the file left
 * behind - and a leak in another test surfaces there rather than here.
 */
const gammal = {
  personId: `mc-gammal-${suffix}`,
  email: `mc-gammal-${suffix}@exempel.se`,
};
const actors = [board, member, skyddad, manager, gammal];
const personIds = actors.map((actor) => actor.personId);

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        // 10.42.0.0/16 is this suite's; the others each hold their own second
        // octet, so no suite's requests count against another's rate-limit
        // budget. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot walk's
        // four actors and must never be taken.
        "x-forwarded-for": `10.42.${String(subnet)}.${String(host + 1)}`,
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

/** The whole of a period wide enough to hold every charge this suite records. */
const PERIOD = { from: "2026-01-01", to: "2026-12-31" } as const;

function recordCharge(
  payload: Record<string, unknown>,
  cookie: string = boardCookie,
) {
  return inject({
    method: "POST",
    url: "/api/member-charges",
    payload,
    headers: { cookie },
  });
}

/** A charge with everything filled in, so a test states only what it varies. */
function chargeOn(overrides: Record<string, unknown> = {}) {
  return {
    personId: member.personId,
    chargedOn: "2026-03-05",
    amount: "450.00",
    reason: `Nyckel till cykelrummet ${suffix}`,
    vatTreatment: "EXEMPT",
    ...overrides,
  };
}

async function readList(
  period: { from: string; to: string } = PERIOD,
  cookie: string = boardCookie,
): Promise<DebitingList> {
  const response = await inject({
    method: "GET",
    url: `/api/member-charges?from=${period.from}&to=${period.to}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<DebitingList>();
}

/** This suite's own rows out of a list every other test also writes into. */
function ownRows(list: DebitingList): DebitingListRow[] {
  return list.rows.filter((row) => row.reason.endsWith(suffix));
}

let boardCookie = "";
let memberCookie = "";
let skyddadCookie = "";
let managerCookie = "";
let associationCreatedHere = false;

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
  const encryption = app.get(FieldEncryptionService);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { id: true },
  });
  associationCreatedHere = existing === null;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Debiteringsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1401", floor: 5 },
  });
  await prisma.apartment.create({
    data: { id: secondApartmentId, addressId, number: "1402", floor: 5 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...member, firstName: "Astrid", lastName: "Medlem" },
    { ...skyddad, firstName: "Signe", lastName: "Skyddad" },
    { ...manager, firstName: "Frida", lastName: "Forvaltare" },
    { ...gammal, firstName: "Gustav", lastName: "Utflyttad" },
  ]) {
    const email = await encryption.encrypt("person.email", person.email);
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
        protectedPersonalData: person.personId === skyddad.personId,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-01-15"),
    },
  });
  for (const person of [member, skyddad]) {
    await prisma.residency.create({
      data: {
        personId: person.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
    });
  }
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  boardCookie = await signIn(board.email);
  memberCookie = await signIn(member.email);
  skyddadCookie = await signIn(skyddad.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.memberCharge.deleteMany({
      where: {
        OR: [
          { personId: { in: personIds } },
          { apartmentId: { in: [apartmentId, secondApartmentId] } },
        ],
      },
    });
    await prisma.legalHold.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.session.deleteMany({
      where: { user: { personId: { in: personIds } } },
    });
    await prisma.account.deleteMany({
      where: { user: { personId: { in: personIds } } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({
      where: { id: { in: [apartmentId, secondApartmentId] } },
    });
    await prisma.address.deleteMany({ where: { id: addressId } });

    // Audit entries stay: the table is append-only by trigger, and every
    // assertion below selects on this run's own target ids.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("recording a charge", () => {
  it("puts one on a named member and reads it back on the list", async () => {
    const response = await recordCharge(chargeOn());

    expect(response.statusCode).toBe(201);
    const row = response.json<DebitingListRow>();
    expect(row.chargedTo).toMatchObject({
      kind: "person",
      personId: member.personId,
      name: "Astrid Medlem",
    });
    expect(row.amount).toBe("450.00");

    const list = await readList();
    expect(
      list.rows.find((entry) => entry.chargeId === row.chargeId),
    ).toBeDefined();

    await prisma.memberCharge.delete({ where: { id: row.chargeId } });
  });

  it("puts one on an apartment, whoever holds it", async () => {
    const response = await recordCharge(
      chargeOn({
        personId: null,
        apartmentId: secondApartmentId,
        reason: `Vidaredebiterad reparation ${suffix}`,
      }),
    );

    expect(response.statusCode).toBe(201);
    const row = response.json<DebitingListRow>();
    expect(row.chargedTo).toMatchObject({
      kind: "apartment",
      apartmentId: secondApartmentId,
    });
    expect(row.chargedTo.apartment).toEqual({
      state: "visible",
      label: `Debiteringsgatan ${suffix} 1402`,
    });

    await prisma.memberCharge.delete({ where: { id: row.chargeId } });
  });

  it("refuses a charge naming neither a person nor an apartment", async () => {
    const response = await recordCharge(
      chargeOn({ personId: null, apartmentId: null }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("party-required");
  });

  it("refuses a charge naming both", async () => {
    const response = await recordCharge(chargeOn({ apartmentId }));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("party-ambiguous");
  });

  it("refuses a charge dated in the future", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const response = await recordCharge(chargeOn({ chargedOn: tomorrow }));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "date-in-the-future",
    );
  });

  it("refuses a rate on an exempt charge and a rated charge with no rate", async () => {
    const withRate = await recordCharge(chargeOn({ vatRatePercent: 25 }));
    expect(withRate.statusCode).toBe(422);
    expect(withRate.json<{ reason: string }>().reason).toBe(
      "vat-rate-not-applicable",
    );

    const withoutRate = await recordCharge(chargeOn({ vatTreatment: "RATE" }));
    expect(withoutRate.statusCode).toBe(422);
    expect(withoutRate.json<{ reason: string }>().reason).toBe(
      "vat-rate-required",
    );
  });

  it("refuses a credit dressed up as a charge", async () => {
    const response = await recordCharge(chargeOn({ amount: "0.00" }));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "amount-not-positive",
    );
  });

  it("keeps the table's own guard on the party, below the service", async () => {
    /*
     * The check constraint rather than the branch above it. Written straight to
     * the table, which is the one path that does not go through the service, and
     * the case the constraint exists for: a hand-written statement, a later
     * caller, a migration that back-fills.
     */
    await expect(
      prisma.memberCharge.create({
        data: {
          personId: member.personId,
          apartmentId,
          chargedOn: new Date("2026-03-05"),
          amount: "450.00",
          reason: "Bada halva",
          vatTreatment: "EXEMPT",
          recordedByPersonId: board.personId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.memberCharge.create({
        data: {
          chargedOn: new Date("2026-03-05"),
          amount: "450.00",
          reason: "Ingendera",
          vatTreatment: "EXEMPT",
          recordedByPersonId: board.personId,
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps the table's own guard on the rate and the amount", async () => {
    await expect(
      prisma.memberCharge.create({
        data: {
          personId: member.personId,
          chargedOn: new Date("2026-03-05"),
          amount: "450.00",
          reason: "Momsfri med sats",
          vatTreatment: "EXEMPT",
          vatRatePercent: 25,
          recordedByPersonId: board.personId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.memberCharge.create({
        data: {
          personId: member.personId,
          chargedOn: new Date("2026-03-05"),
          amount: "-450.00",
          reason: "Kreditering",
          vatTreatment: "EXEMPT",
          recordedByPersonId: board.personId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("the personal identity number scan", () => {
  it("refuses a reason carrying one, naming the field", async () => {
    const response = await recordCharge(
      chargeOn({ reason: `Nyckel at 811228-9874 ${suffix}` }),
    );

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      reason: string;
      locations: { field: string; offset: number }[];
    }>();
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations).toEqual([{ field: "reason", offset: 10 }]);
    // Never the value: the thing the scan caught is the thing that must not
    // travel back in a response body.
    expect(response.body).not.toContain("811228");
  });

  it("refuses one pasted in on a later edit", async () => {
    /*
     * The half a scan on the create alone would miss, and the one that matters
     * most: the board records a plain charge, then corrects the reason with a
     * paragraph pasted out of an invoice.
     */
    const created = await recordCharge(
      chargeOn({ reason: `Ny tagg ${suffix}` }),
    );
    expect(created.statusCode).toBe(201);
    const chargeId = created.json<DebitingListRow>().chargeId;

    const response = await inject({
      method: "POST",
      url: `/api/member-charges/${chargeId}/correct`,
      payload: { reason: `Ny tagg at 811228-9874 ${suffix}` },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "personal-identity-number",
    );

    const stored = await prisma.memberCharge.findUnique({
      where: { id: chargeId },
      select: { reason: true },
    });
    expect(stored?.reason).toBe(`Ny tagg ${suffix}`);

    await prisma.memberCharge.delete({ where: { id: chargeId } });
  });
});

describe("protected personal data", () => {
  it("withholds the apartment from the list and from the file", async () => {
    const created = await recordCharge(
      chargeOn({
        personId: skyddad.personId,
        reason: `Andrahandsavgift ${suffix}`,
      }),
    );
    expect(created.statusCode).toBe(201);
    const chargeId = created.json<DebitingListRow>().chargeId;

    const list = await readList();
    const row = list.rows.find((entry) => entry.chargeId === chargeId);
    expect(row?.chargedTo).toMatchObject({
      kind: "person",
      name: "Signe Skyddad",
      protectedPersonalData: true,
    });
    expect(row?.chargedTo.apartment).toEqual({ state: "masked" });

    const exported = await inject({
      method: "POST",
      url: `/api/member-charges/export?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: { cookie: boardCookie },
    });
    expect(exported.statusCode).toBe(200);
    const file = exported.json<DebitingListExport>();
    /*
     * Asserted on this person's own line rather than on the whole file, which
     * carries every charge in the period: the rule is about what a protected
     * person's row may say, and a neighbour's apartment on their own row is
     * correct.
     *
     * The name is on the file - a bookkeeper has to know who to invoice - and
     * the link from the name to the door is not.
     */
    const line = file.csv
      .split("\n")
      .find((text) => text.includes(`Andrahandsavgift ${suffix}`));
    expect(line).toContain("Signe Skyddad");
    expect(line).toContain("protected");
    expect(line).not.toContain("1401");

    await prisma.memberCharge.delete({ where: { id: chargeId } });
  });
});

describe("who may reach the module at all", () => {
  it.each([
    ["a member", () => memberCookie],
    ["a protected resident", () => skyddadCookie],
    ["the external property manager", () => managerCookie],
  ])("refuses %s the list", async (_who, cookie) => {
    const response = await inject({
      method: "GET",
      url: `/api/member-charges?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: { cookie: cookie() },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a member recording a charge on themselves", async () => {
    const response = await recordCharge(chargeOn(), memberCookie);

    expect(response.statusCode).toBe(403);
  });
});

describe("the export", () => {
  it("writes an entry naming the period and the board member who took it", async () => {
    const created = await recordCharge(
      chargeOn({ reason: `Nyckelbricka ${suffix}` }),
    );
    expect(created.statusCode).toBe(201);
    const chargeId = created.json<DebitingListRow>().chargeId;

    const before = await prisma.auditLogEntry.count({
      where: {
        action: "DEBITING_LIST_EXPORTED",
        actorPersonId: board.personId,
      },
    });

    const response = await inject({
      method: "POST",
      url: `/api/member-charges/export?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    const file = response.json<DebitingListExport>();
    expect(file.fileName).toBe(
      `debiteringslangd-${PERIOD.from}-${PERIOD.to}.csv`,
    );
    expect(file.csv).toContain(`Nyckelbricka ${suffix}`);

    const after = await prisma.auditLogEntry.count({
      where: {
        action: "DEBITING_LIST_EXPORTED",
        actorPersonId: board.personId,
      },
    });
    expect(after).toBe(before + 1);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "DEBITING_LIST_EXPORTED",
        actorPersonId: board.personId,
      },
      orderBy: [{ createdAt: "desc" }],
      select: { context: true },
    });
    expect(entry?.context).toMatchObject({ from: PERIOD.from, to: PERIOD.to });
    // No name and no figure: the copy is the file, not the log.
    expect(JSON.stringify(entry?.context)).not.toContain("Astrid");

    await prisma.memberCharge.delete({ where: { id: chargeId } });
  });

  it("reads the list without writing an entry", async () => {
    // Reading the charges is the board working in its own instance. What carries
    // an entry is the copy that leaves the association.
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "DEBITING_LIST_EXPORTED",
        actorPersonId: board.personId,
      },
    });

    await readList();

    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "DEBITING_LIST_EXPORTED",
          actorPersonId: board.personId,
        },
      }),
    ).toBe(before);
  });
});

describe("correcting and removing", () => {
  it("records which fields moved and nothing else", async () => {
    const created = await recordCharge(
      chargeOn({ reason: `Portkod ${suffix}` }),
    );
    const chargeId = created.json<DebitingListRow>().chargeId;

    const corrected = await inject({
      method: "POST",
      url: `/api/member-charges/${chargeId}/correct`,
      // The whole row posted back, with one figure changed. An entry naming six
      // fields would make the log unreadable exactly where it is needed.
      payload: {
        chargedOn: "2026-03-05",
        amount: "500.00",
        reason: `Portkod ${suffix}`,
        vatTreatment: "EXEMPT",
      },
      headers: { cookie: boardCookie },
    });

    expect(corrected.statusCode).toBe(200);
    expect(corrected.json<DebitingListRow>().amount).toBe("500.00");

    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "MEMBER_CHARGE_CORRECTED", targetId: chargeId },
      select: { context: true, targetPersonId: true },
    });
    expect(entry?.targetPersonId).toBe(member.personId);
    expect(entry?.context).toEqual({ fields: ["amount"] });

    await prisma.memberCharge.delete({ where: { id: chargeId } });
  });

  it("refuses a hand-over dated before the charge", async () => {
    const response = await recordCharge(
      chargeOn({ handedToManagerOn: "2026-03-04" }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "handed-over-before-charge",
    );
  });

  it("removes a charge and leaves the entry saying it existed", async () => {
    const created = await recordCharge(
      chargeOn({ reason: `Felaktig debitering ${suffix}` }),
    );
    const chargeId = created.json<DebitingListRow>().chargeId;

    const removed = await inject({
      method: "DELETE",
      url: `/api/member-charges/${chargeId}`,
      headers: { cookie: boardCookie },
    });
    expect(removed.statusCode).toBe(204);

    expect(
      await prisma.memberCharge.findUnique({ where: { id: chargeId } }),
    ).toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "MEMBER_CHARGE_REMOVED", targetId: chargeId },
      }),
    ).toBe(1);
  });
});

describe("the register keeps an apartment a charge names", () => {
  it("refuses to remove it, and says which record stands in the way", async () => {
    const created = await recordCharge(
      chargeOn({
        personId: null,
        apartmentId: secondApartmentId,
        reason: `Trapphusstadning ${suffix}`,
      }),
    );
    const chargeId = created.json<DebitingListRow>().chargeId;

    const response = await inject({
      method: "DELETE",
      url: `/api/apartments/${secondApartmentId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("apartment-in-use");

    await prisma.memberCharge.delete({ where: { id: chargeId } });
  });
});

describe("the data subject access report", () => {
  it("carries the charges naming the person and those on their apartment", async () => {
    const own = await recordCharge(
      chargeOn({ reason: `Egen debitering ${suffix}` }),
    );
    const theirs = await recordCharge(
      chargeOn({
        personId: null,
        apartmentId,
        chargedOn: "2026-06-01",
        reason: `Lagenhetens debitering ${suffix}`,
      }),
    );
    /*
     * The previous household's, dated before this person moved in on the 1st of
     * January 2026. It must not reach their report: that is a third party's
     * finances on a document the association hands over.
     */
    const previous = await recordCharge(
      chargeOn({
        personId: null,
        apartmentId,
        chargedOn: "2026-01-01",
        reason: `Foregaende hushall ${suffix}`,
      }),
    );
    await prisma.memberCharge.update({
      where: { id: previous.json<DebitingListRow>().chargeId },
      data: { chargedOn: new Date("2025-12-31") },
    });

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${member.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    const report = response.json<DataSubjectReport>();
    const charges = report.memberCharges.filter((charge) =>
      charge.reason.endsWith(suffix),
    );
    expect(charges.map((charge) => charge.reason).sort()).toEqual([
      `Egen debitering ${suffix}`,
      `Lagenhetens debitering ${suffix}`,
    ]);

    const ownCharge = charges.find((charge) => charge.basis === "person");
    expect(ownCharge?.erasableFrom).toBe("2034-01-01");
    expect(ownCharge?.apartment).toBeNull();

    const apartmentCharge = charges.find(
      (charge) => charge.basis === "apartment",
    );
    expect(apartmentCharge?.apartment).toBe(`Debiteringsgatan ${suffix} 1401`);

    await prisma.memberCharge.deleteMany({
      where: {
        id: {
          in: [
            own.json<DebitingListRow>().chargeId,
            theirs.json<DebitingListRow>().chargeId,
            previous.json<DebitingListRow>().chargeId,
          ],
        },
      },
    });
  });
});

describe("the purge", () => {
  /** A charge written straight in, dated back beyond the window. */
  async function agedCharge(options: {
    personId?: string;
    apartmentId?: string;
    chargedOn: string;
  }): Promise<string> {
    const charge = await prisma.memberCharge.create({
      data: {
        personId: options.personId ?? null,
        apartmentId: options.apartmentId ?? null,
        chargedOn: new Date(options.chargedOn),
        amount: "120.00",
        reason: `Gammal debitering ${suffix}`,
        vatTreatment: "EXEMPT",
        recordedByPersonId: board.personId,
      },
      select: { id: true },
    });
    return charge.id;
  }

  it("erases a charge whose seven calendar years have run out", async () => {
    const stale = await agedCharge({
      personId: gammal.personId,
      chargedOn: "2026-03-05",
    });
    const fresh = await agedCharge({
      personId: gammal.personId,
      chargedOn: "2027-03-05",
    });

    const purge = app.get(MemberChargePurgeService);
    // The first morning of 2034: everything dated in 2026 has fallen out and
    // nothing from 2027 has.
    await purge.run(new Date("2034-01-01T03:17:00.000+01:00"));

    expect(
      await prisma.memberCharge.findUnique({ where: { id: stale } }),
    ).toBeNull();
    expect(
      await prisma.memberCharge.findUnique({ where: { id: fresh } }),
    ).not.toBeNull();

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "memberCharge",
        targetPersonId: gammal.personId,
      },
      orderBy: [{ createdAt: "desc" }],
      select: { context: true, actorPersonId: true },
    });
    // Nobody clicked it: the job ran because a date arrived.
    expect(entry?.actorPersonId).toBeNull();
    expect(entry?.context).toMatchObject({ charges: 1, party: "person" });

    await prisma.memberCharge.delete({ where: { id: fresh } });
  });

  it("is stopped by a legal hold against the person charged", async () => {
    const held = await agedCharge({
      personId: member.personId,
      chargedOn: "2026-04-05",
    });
    const hold = await prisma.legalHold.create({
      data: {
        personId: member.personId,
        reason: "Tvist om debitering",
        placedByPersonId: board.personId,
      },
      select: { id: true },
    });

    const purge = app.get(MemberChargePurgeService);
    await purge.run(new Date("2034-01-01T03:17:00.000+01:00"));

    expect(
      await prisma.memberCharge.findUnique({ where: { id: held } }),
    ).not.toBeNull();

    await prisma.legalHold.delete({ where: { id: hold.id } });
    await prisma.memberCharge.delete({ where: { id: held } });
  });

  it("is stopped for an apartment by a hold against anyone who lived there", async () => {
    /*
     * A charge on the flat names nobody, so the hold has to be read through the
     * residencies. Ever, and not only now: the charge is from a year that has
     * closed, and the household disputing it may have moved out since.
     */
    const held = await agedCharge({
      apartmentId,
      chargedOn: "2026-05-05",
    });
    const hold = await prisma.legalHold.create({
      data: {
        personId: member.personId,
        reason: "Tvist om vidaredebiterad reparation",
        placedByPersonId: board.personId,
      },
      select: { id: true },
    });

    const purge = app.get(MemberChargePurgeService);
    await purge.run(new Date("2034-01-01T03:17:00.000+01:00"));

    expect(
      await prisma.memberCharge.findUnique({ where: { id: held } }),
    ).not.toBeNull();

    await prisma.legalHold.delete({ where: { id: hold.id } });

    // Released, the same run reaches it.
    await purge.run(new Date("2034-01-01T03:17:00.000+01:00"));
    expect(
      await prisma.memberCharge.findUnique({ where: { id: held } }),
    ).toBeNull();
  });
});

describe("the list itself", () => {
  it("totals what was charged, and carries no payment anywhere", async () => {
    const first = await recordCharge(
      chargeOn({ amount: "1570.10", reason: `Summa ett ${suffix}` }),
    );
    const second = await recordCharge(
      chargeOn({ amount: "1570.20", reason: `Summa tva ${suffix}` }),
    );
    const third = await recordCharge(
      chargeOn({ amount: "1572.70", reason: `Summa tre ${suffix}` }),
    );

    const list = await readList({ from: "2026-03-05", to: "2026-03-05" });
    const rows = ownRows(list);
    expect(rows).toHaveLength(3);
    // Added in ore. As numbers with a decimal point these three come to one ore
    // short, and this figure is what the bookkeeper reconciles against.
    expect(list.total).toBe("4713.00");

    /*
     * The decision this module exists under, asserted rather than trusted to
     * review: the payload carries no payment, no balance and no status, so a
     * field added later fails here rather than reaching a screen.
     */
    const payload = JSON.stringify(list).toLowerCase();
    for (const word of [
      "paid",
      "balance",
      "outstanding",
      "settled",
      "status",
    ]) {
      expect(payload).not.toContain(word);
    }

    await prisma.memberCharge.deleteMany({
      where: {
        id: {
          in: [first, second, third].map(
            (response) => response.json<DebitingListRow>().chargeId,
          ),
        },
      },
    });
  });

  it("refuses a period that runs backwards", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/member-charges?from=2026-12-31&to=2026-01-01",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("range-invalid");
  });
});
