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
import { parseCsv } from "../import/csv";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { AccountingBasisExport } from "./accounting-basis.service";

/**
 * The accounting basis, against a real database.
 *
 * What a unit test cannot show, and nothing else.
 *
 * **Both halves of the period's money arrive in one file**, read through the
 * two modules that own them rather than assembled by hand, with the amounts as
 * the decimal columns render them.
 *
 * **A run is dated by the day its period opens.** The rule decides which export
 * a quarter's notices land in, it is asserted from both sides, and it is what
 * makes consecutive exports count every run exactly once.
 *
 * **A protected person's apartment does not reach the file and their name
 * does**, through the charges module's own masking rather than against a
 * hand-built row - and the fee row for the flat that same person holds names
 * nobody at all, which is what stops the file saying the two things a reader
 * could put back together.
 *
 * **Producing the file writes one audit entry carrying the period and nothing
 * else.** The log is exempt from every purge, so an apartment, a name or a
 * figure in an entry would outlive the rows it described.
 *
 * **The board's two capabilities are the whole gate.** A resident holds
 * neither, and neither does the external property manager. No role holds
 * exactly one of the two, so that the file needs both is the decorator's claim
 * and not a seat's.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `basis-address-${suffix}`;
const apartmentId = `basis-apartment-${suffix}`;
const secondApartmentId = `basis-apartment-2-${suffix}`;

const board = {
  personId: `basis-board-${suffix}`,
  email: `basis-board-${suffix}@exempel.se`,
};
const member = {
  personId: `basis-member-${suffix}`,
  email: `basis-member-${suffix}@exempel.se`,
};
/** A holder the register masks, so a charge row has an apartment to withhold. */
const skyddad = {
  personId: `basis-skyddad-${suffix}`,
  email: `basis-skyddad-${suffix}@exempel.se`,
};
const manager = {
  personId: `basis-manager-${suffix}`,
  email: `basis-manager-${suffix}@exempel.se`,
};
const actors = [board, member, skyddad, manager];
const personIds = actors.map((actor) => actor.personId);
const apartmentIds = [apartmentId, secondApartmentId];

/**
 * A period in the past, because a charge dated forward is refused.
 *
 * 2025 rather than the year the other finance suites write into: every suite
 * shares a worker's database in turn, and a period is the whole of what this
 * export selects on.
 */
const QUARTER = { from: "2025-01-01", to: "2025-03-31" };

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
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
        // 10.51.0.0/16 is this suite's; the others each hold their own second
        // octet, so no suite's requests count against another's rate-limit
        // budget. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot walk's
        // four actors and must never be taken.
        "x-forwarded-for": `10.51.${String(subnet)}.${String(host + 1)}`,
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

function exportBasis(
  period: { from: string; to: string },
  cookie: string = boardCookie,
) {
  return inject({
    method: "POST",
    url: `/api/accounting-basis/export?from=${period.from}&to=${period.to}`,
    headers: { cookie },
  });
}

async function basisFor(period: {
  from: string;
  to: string;
}): Promise<AccountingBasisExport> {
  const response = await exportBasis(period);
  expect(response.statusCode).toBe(200);
  return response.json<AccountingBasisExport>();
}

/** This suite's own rows out of a file every other suite may have written into. */
function ownRows(taken: AccountingBasisExport) {
  return taken.basis.rows.filter(
    (row) =>
      row.paymentReference !== null ||
      row.reason?.startsWith(`basis-${suffix}`) === true,
  );
}

let boardCookie = "";
let memberCookie = "";
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
    create: { id: 1, name: "Brf Eksemplet", organizationNumber: "769600-1234" },
    update: {},
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Bokforingsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "2501", floor: 5 },
  });
  await prisma.apartment.create({
    data: { id: secondApartmentId, addressId, number: "2502", floor: 5 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...member, firstName: "Astrid", lastName: "Medlem" },
    { ...skyddad, firstName: "Signe", lastName: "Skyddad" },
    { ...manager, firstName: "Frida", lastName: "Forvaltare" },
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
      electedOn: new Date("2024-01-15"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: member.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2024-01-01"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: skyddad.personId,
      apartmentId: secondApartmentId,
      role: "MEMBER",
      movedInOn: new Date("2024-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  boardCookie = await signIn(board.email);
  memberCookie = await signIn(member.email);
  managerCookie = await signIn(manager.email);

  // The period's money, recorded through the endpoints that own it so that what
  // this suite exports is what a board would have produced.
  for (const [apartment, monthlyAmount] of [
    [apartmentId, "3450.50"],
    [secondApartmentId, "2000.00"],
  ] as const) {
    const fee = await inject({
      method: "POST",
      url: "/api/fees",
      payload: {
        apartmentId: apartment,
        kind: "ANNUAL_FEE",
        appliesFrom: QUARTER.from,
        monthlyAmount,
        vatTreatment: "EXEMPT",
      },
      headers: { cookie: boardCookie },
    });
    expect(fee.statusCode).toBe(201);
  }

  const run = await inject({
    method: "POST",
    url: "/api/fee-notifications",
    payload: { ...QUARTER, dueOn: "2025-01-31" },
    headers: { cookie: boardCookie },
  });
  expect(run.statusCode).toBe(201);

  for (const charge of [
    {
      personId: member.personId,
      amount: "450.00",
      reason: `basis-${suffix} nyckel till cykelrummet`,
      vatTreatment: "EXEMPT",
    },
    {
      personId: skyddad.personId,
      amount: "125.00",
      reason: `basis-${suffix} tvattstugetagg`,
      vatTreatment: "RATE",
      vatRatePercent: 25,
    },
    {
      apartmentId,
      amount: "900.00",
      reason: `basis-${suffix} stamspolning`,
      vatTreatment: "EXEMPT",
    },
  ]) {
    const response = await inject({
      method: "POST",
      url: "/api/member-charges",
      payload: { chargedOn: "2025-02-14", ...charge },
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(201);
  }
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.memberCharge.deleteMany({
      where: {
        OR: [
          { personId: { in: personIds } },
          { apartmentId: { in: apartmentIds } },
        ],
      },
    });
    await prisma.feeNotice.deleteMany({
      where: { apartmentId: { in: apartmentIds } },
    });
    await prisma.feeNotification.deleteMany({
      where: { notices: { none: {} } },
    });
    await prisma.fee.deleteMany({
      where: { apartmentId: { in: apartmentIds } },
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
    await prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } });
    await prisma.address.deleteMany({ where: { id: addressId } });

    // Audit entries stay: the table is append-only by trigger, and the
    // assertion below selects on this run's own actor.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("the file", () => {
  it("carries both halves of the period's money", async () => {
    const taken = await basisFor({ from: "2025-01-01", to: "2025-12-31" });

    const fees = ownRows(taken).filter((row) => row.kind === "FEE_NOTICE");
    const charges = ownRows(taken).filter(
      (row) => row.kind === "MEMBER_CHARGE",
    );
    expect(fees).toHaveLength(2);
    expect(charges).toHaveLength(3);

    // Three months at the rate in force on each month's first day, which is the
    // multiplication the whole fee model is stated per month for.
    expect(
      fees
        .map((row) => row.amount)
        .sort((first, second) => first.localeCompare(second)),
    ).toEqual(["10351.50", "6000.00"]);
    expect(taken.basis.feeTotal).toBe("16351.50");
    expect(taken.basis.chargeTotal).toBe("1475.00");
    expect(taken.basis.total).toBe("17826.50");

    expect(taken.fileName).toBe("bokforingsunderlag-2025-01-01-2025-12-31.csv");
    expect(taken.csv.startsWith("﻿")).toBe(true);
  });

  it("states each fee row against the run's own period", async () => {
    const taken = await basisFor({ from: "2025-01-01", to: "2025-12-31" });
    const fee = ownRows(taken).find((row) => row.kind === "FEE_NOTICE");

    expect(fee?.from).toBe(QUARTER.from);
    expect(fee?.to).toBe(QUARTER.to);
    // A charge falls on one day and states it as both ends.
    const charge = ownRows(taken).find((row) => row.kind === "MEMBER_CHARGE");
    expect(charge?.from).toBe("2025-02-14");
    expect(charge?.to).toBe("2025-02-14");
  });

  it("serialises the rows in the header's own order", async () => {
    const taken = await basisFor({ from: "2025-01-01", to: "2025-12-31" });
    const rows = parseCsv(taken.csv, ";").rows;
    const header = rows[0] ?? [];

    expect(header[0]).toBe("kind");
    const written = rows
      .slice(1)
      .filter((row) => row[header.indexOf("paymentReference")] !== "");
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(row).toHaveLength(header.length);
      expect(row[header.indexOf("kind")]).toBe("FEE_NOTICE");
      expect(row[header.indexOf("name")]).toBe("");
    }
  });
});

describe("which export a run lands in", () => {
  it("takes a run whose period opens inside the export period, whole", async () => {
    // One month asked for, a quarter's notices answered with: the amount is
    // what was billed for the run, and this product apportions none.
    const taken = await basisFor({ from: "2025-01-01", to: "2025-01-31" });
    const fees = ownRows(taken).filter((row) => row.kind === "FEE_NOTICE");

    expect(fees).toHaveLength(2);
    expect(taken.basis.feeTotal).toBe("16351.50");
  });

  it("leaves out a run that opened before the export period", async () => {
    // The same quarter's notices, asked for from February: the run opened in
    // January and belongs to January's export, so nothing of it is counted
    // twice.
    const taken = await basisFor({ from: "2025-02-01", to: "2025-12-31" });

    expect(ownRows(taken).filter((row) => row.kind === "FEE_NOTICE")).toEqual(
      [],
    );
    expect(taken.basis.feeTotal).toBe("0.00");
    // The charge dated in February is still there, on its own day's rule.
    expect(
      ownRows(taken).filter((row) => row.kind === "MEMBER_CHARGE"),
    ).toHaveLength(3);
  });
});

describe("a protected person", () => {
  it("is named on their charge and their apartment is withheld", async () => {
    const taken = await basisFor({ from: "2025-01-01", to: "2025-12-31" });
    const row = ownRows(taken).find((entry) =>
      entry.reason?.endsWith("tvattstugetagg"),
    );

    expect(row?.name).toBe("Signe Skyddad");
    expect(row?.apartment).toEqual({ state: "withheld" });
  });

  it("is not named at all on the fee row for the flat they hold", async () => {
    /*
     * The property the whole file rests on. A fee row that named its holders
     * would withhold this person's name and print their apartment, while the
     * charge row above prints their name and withholds their apartment - and a
     * reader holding both could put the name back against the door.
     */
    const taken = await basisFor({ from: "2025-01-01", to: "2025-12-31" });
    const rows = ownRows(taken).filter((row) => row.kind === "FEE_NOTICE");

    expect(rows.map((row) => row.name)).toEqual([null, null]);
    expect(rows.map((row) => row.apartment)).toEqual([
      { state: "visible", label: `Bokforingsgatan ${suffix} 2501` },
      { state: "visible", label: `Bokforingsgatan ${suffix} 2502` },
    ]);
  });
});

describe("the audit entry", () => {
  it("records the period and nothing the file held", async () => {
    await basisFor(QUARTER);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "ACCOUNTING_BASIS_EXPORTED",
        actorPersonId: board.personId,
      },
      orderBy: { createdAt: "desc" },
      select: { context: true, targetPersonId: true, channel: true },
    });

    expect(entry?.channel).toBe("WEB");
    expect(entry?.targetPersonId).toBeNull();
    expect(entry?.context).toEqual({ from: QUARTER.from, to: QUARTER.to });
  });
});

describe("who may take it", () => {
  it("refuses a resident", async () => {
    const response = await exportBasis(QUARTER, memberCookie);

    expect(response.statusCode).toBe(403);
  });

  it("refuses the external property manager", async () => {
    // What the association charges its own members is the board's business
    // with them, on the same reading both halves already state.
    const response = await exportBasis(QUARTER, managerCookie);

    expect(response.statusCode).toBe(403);
  });
});

describe("the period", () => {
  it("refuses one that ends before it begins", async () => {
    const response = await exportBasis({
      from: "2025-03-31",
      to: "2025-01-01",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("range-invalid");
  });
});
