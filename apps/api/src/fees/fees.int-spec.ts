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
import { FeePurgeService } from "./fee-purge.service";
import type {
  FeeNoticeExport,
  FeeNotificationSummary,
} from "./fee-notification.service";
import type { FeeRegister, FeeRow } from "./fee.service";

/**
 * Fees and their notices, against a real database.
 *
 * What a unit test cannot show, and nothing else.
 *
 * **The table refuses a row the service would refuse.** A positive amount, a
 * rate that belongs to its treatment, a period that runs forwards. Those are
 * check constraints, and a constraint has no meaning against a mock - the API
 * refuses each of them first with a reason code, and this is what makes the
 * invariant the table's rather than one function's.
 *
 * **A rate dated forward is accepted here and refused by the charges module.**
 * The one deliberate difference between the two tables, asserted across both
 * endpoints so that relaxing either is a failing test rather than a quiet
 * change of mind.
 *
 * **Recording a rate closes the one before it, in one transaction.** Two rates
 * covering one day would give the apartment two answers to what it pays, and
 * the closing is what makes that impossible rather than unlikely.
 *
 * **A period may be issued once, and the payment references are unique.** Both
 * are database constraints, and the second rests on the first.
 *
 * **A protected holder's name does not reach the document.** The masking rule is
 * the debiting list's read from the other end, and it is asserted through the
 * endpoint against a real protected person rather than against a hand-built row.
 *
 * **The board's capability is the whole gate.** A resident holds nothing here,
 * and neither does the external property manager.
 *
 * **Every fee and notice reaches the data subject access report**, through the
 * residency covering its period. A new store of personal data missing from that
 * document is the one failure it cannot have.
 *
 * **The purge erases on the association's financial year and a legal hold stops
 * it**, for real rows, and it never reaches a rate still in force.
 *
 * **An apartment carrying a fee cannot be removed from the register**, and the
 * refusal names the record in the way rather than surfacing as a foreign key
 * error.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `fee-address-${suffix}`;
const apartmentId = `fee-apartment-${suffix}`;
const secondApartmentId = `fee-apartment-2-${suffix}`;
const emptyApartmentId = `fee-apartment-3-${suffix}`;

const board = {
  personId: `fee-board-${suffix}`,
  email: `fee-board-${suffix}@exempel.se`,
};
const member = {
  personId: `fee-member-${suffix}`,
  email: `fee-member-${suffix}@exempel.se`,
};
/** A holder the register masks, so the document has a name to withhold. */
const skyddad = {
  personId: `fee-skyddad-${suffix}`,
  email: `fee-skyddad-${suffix}@exempel.se`,
};
const manager = {
  personId: `fee-manager-${suffix}`,
  email: `fee-manager-${suffix}@exempel.se`,
};
const actors = [board, member, skyddad, manager];
const personIds = actors.map((actor) => actor.personId);
const apartmentIds = [apartmentId, secondApartmentId, emptyApartmentId];

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
        // 10.50.0.0/16 is this suite's; the others each hold their own second
        // octet, so no suite's requests count against another's rate-limit
        // budget. 10.40.0.1 to 10.40.0.4 are reserved for the screenshot walk's
        // four actors and must never be taken.
        "x-forwarded-for": `10.50.${String(subnet)}.${String(host + 1)}`,
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

function recordFee(
  payload: Record<string, unknown>,
  cookie: string = boardCookie,
) {
  return inject({
    method: "POST",
    url: "/api/fees",
    payload,
    headers: { cookie },
  });
}

/** A rate with everything filled in, so a test states only what it varies. */
function feeOn(overrides: Record<string, unknown> = {}) {
  return {
    apartmentId,
    kind: "ANNUAL_FEE",
    appliesFrom: "2026-01-01",
    monthlyAmount: "3450.50",
    vatTreatment: "EXEMPT",
    ...overrides,
  };
}

async function readRegister(
  on = "2026-06-15",
  cookie: string = boardCookie,
): Promise<FeeRegister> {
  const response = await inject({
    method: "GET",
    url: `/api/fees?on=${on}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<FeeRegister>();
}

/** This suite's own apartments out of a register every other test writes into. */
function ownApartments(register: FeeRegister) {
  return register.apartments.filter((apartment) =>
    apartmentIds.includes(apartment.apartmentId),
  );
}

/**
 * Runs this suite wrote straight into the table, with no notice to find them by.
 *
 * The race tests insert a run inside a transaction of their own to stand in for
 * a second request, and such a run bills nobody. Every other run this suite
 * makes is found through the notices on its own apartments.
 */
const ownRunIds = new Set<string>();

/**
 * Clears every fee and run this suite made, between cases.
 *
 * Scoped to this run's own rows: the runs that billed this suite's apartments
 * and the ones it inserted directly, and never every empty run in the table.
 */
async function clearFees(): Promise<void> {
  const billed = await prisma.feeNotice.findMany({
    where: { apartmentId: { in: apartmentIds } },
    select: { notificationId: true },
    distinct: ["notificationId"],
  });
  const runIds = [
    ...new Set([
      ...billed.map((notice) => notice.notificationId),
      ...ownRunIds,
    ]),
  ];
  await prisma.feeNotice.deleteMany({
    where: { apartmentId: { in: apartmentIds } },
  });
  await prisma.feeNotification.deleteMany({ where: { id: { in: runIds } } });
  ownRunIds.clear();
  await prisma.fee.deleteMany({ where: { apartmentId: { in: apartmentIds } } });
}

/**
 * The month the association's financial year began in before this suite ran,
 * restored when it ends. Several cases change it; the suite hands the database
 * back as it found it rather than as it assumes it was.
 */
let originalStartMonth = 1;

/** Sets the association's financial year for the case that needs it. */
async function setStartMonth(month: number): Promise<void> {
  await prisma.association.update({
    where: { id: 1 },
    data: { financialYearStartMonth: month },
  });
}

/**
 * Long enough for a request already sent to have reached the statement it will
 * wait on. Used only where a test drives two transactions against one lock on
 * purpose, and only after the holder has signalled that it holds the lock.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
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
  const association = await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
    select: { financialYearStartMonth: true },
  });
  originalStartMonth = association.financialYearStartMonth;

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Avgiftsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: {
      id: apartmentId,
      addressId,
      number: "1501",
      floor: 5,
      participationShare: "0.02500000",
      initialShareCapital: "125000.00",
    },
  });
  await prisma.apartment.create({
    data: { id: secondApartmentId, addressId, number: "1502", floor: 5 },
  });
  await prisma.apartment.create({
    data: { id: emptyApartmentId, addressId, number: "1503", floor: 5 },
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
      electedOn: new Date("2026-01-15"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: member.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2026-01-01"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: skyddad.personId,
      apartmentId: secondApartmentId,
      role: "MEMBER",
      movedInOn: new Date("2026-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  boardCookie = await signIn(board.email);
  memberCookie = await signIn(member.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    await clearFees();
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
    await prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    await setStartMonth(originalStartMonth);

    // Audit entries stay: the table is append-only by trigger, and every
    // assertion below selects on this run's own target ids.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("recording a fee", () => {
  it("records a rate and reads it back on the register", async () => {
    const response = await recordFee(feeOn());

    expect(response.statusCode).toBe(201);
    const row = response.json<FeeRow>();
    expect(row).toMatchObject({
      apartmentId,
      kind: "ANNUAL_FEE",
      appliesFrom: "2026-01-01",
      appliesUntil: null,
      // toFixed and not toString: a DECIMAL(14, 2) holding 3450.5 renders as
      // "3450.5" through the latter, and a member pays from this figure.
      monthlyAmount: "3450.50",
      vatTreatment: "EXEMPT",
      vatRatePercent: null,
    });

    const register = await readRegister();
    const apartment = register.apartments.find(
      (entry) => entry.apartmentId === apartmentId,
    );
    expect(apartment?.monthlyAmount).toBe("3450.50");
    // The participation share travels for the screen's aid and nothing derives
    // from it.
    expect(apartment?.participationShare).toBe("0.025");

    await clearFees();
  });

  it("takes a rate dated forward, which a charge is refused for", async () => {
    /*
     * The whole difference between the two tables, asserted across both
     * endpoints. A rate dated forward is the board recording a decision it has
     * taken; a charge dated forward is a claim that something happened which
     * has not.
     */
    const ahead = "2099-01-01";

    const fee = await recordFee(feeOn({ appliesFrom: ahead }));
    expect(fee.statusCode).toBe(201);

    const charge = await inject({
      method: "POST",
      url: "/api/member-charges",
      payload: {
        apartmentId,
        chargedOn: ahead,
        amount: "450.00",
        reason: `Nyckel ${suffix}`,
        vatTreatment: "EXEMPT",
      },
      headers: { cookie: boardCookie },
    });
    expect(charge.statusCode).toBe(422);
    expect(charge.json<{ reason: string }>().reason).toBe("date-in-the-future");

    await clearFees();
  });

  it("closes the rate before it, so no day has two answers", async () => {
    await recordFee(feeOn());
    const second = await recordFee(
      feeOn({ appliesFrom: "2026-07-01", monthlyAmount: "3600.00" }),
    );
    expect(second.statusCode).toBe(201);

    const stored = await prisma.fee.findMany({
      where: { apartmentId, kind: "ANNUAL_FEE" },
      orderBy: [{ appliesFrom: "asc" }],
      select: { appliesFrom: true, appliesUntil: true },
    });
    expect(stored).toHaveLength(2);
    // The day before the new rate begins, so the two meet without overlapping
    // and without a gap.
    expect(stored[0]?.appliesUntil?.toISOString().slice(0, 10)).toBe(
      "2026-06-30",
    );
    expect(stored[1]?.appliesUntil).toBeNull();

    // And the register answers with exactly one rate on any given day.
    const june = await readRegister("2026-06-15");
    expect(
      june.apartments.find((entry) => entry.apartmentId === apartmentId)?.fees,
    ).toHaveLength(1);

    await clearFees();
  });

  it("refuses a rate that starts behind one already recorded", async () => {
    await recordFee(feeOn({ appliesFrom: "2026-07-01" }));
    const behind = await recordFee(feeOn({ appliesFrom: "2026-01-01" }));

    expect(behind.statusCode).toBe(409);
    expect(behind.json<{ reason: string }>().reason).toBe(
      "fee-already-recorded-later",
    );

    await clearFees();
  });

  it("refuses an amount of zero, which the check constraint also would", async () => {
    const response = await recordFee(feeOn({ monthlyAmount: "0.00" }));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "amount-not-positive",
    );
  });

  it("refuses a rate on an exempt fee and a taxable fee with no rate", async () => {
    const withRate = await recordFee(
      feeOn({ vatTreatment: "EXEMPT", vatRatePercent: 25 }),
    );
    expect(withRate.statusCode).toBe(422);
    expect(withRate.json<{ reason: string }>().reason).toBe(
      "vat-rate-not-applicable",
    );

    const without = await recordFee(feeOn({ vatTreatment: "RATE" }));
    expect(without.statusCode).toBe(422);
    expect(without.json<{ reason: string }>().reason).toBe("vat-rate-required");
  });

  it("takes a taxable parking space, which ML 10 kap. 36 § makes taxable", async () => {
    const response = await recordFee(
      feeOn({
        kind: "PARKING_SPACE",
        monthlyAmount: "800.00",
        vatTreatment: "RATE",
        vatRatePercent: 25,
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json<FeeRow>().vatRatePercent).toBe(25);

    await clearFees();
  });
});

describe("two rates for one day", () => {
  it("refuses a rate inside the window of one already closed", async () => {
    /*
     * The sequence that billed a household twice. Recording from July closes
     * the January rate at the end of June; removing the July rate leaves the
     * January rate closed there. A rate recorded from March then fell between
     * the two checks - it starts before no later rate, and the January rate is
     * no longer the open one - and both rates covered March to June, so a run
     * billed both.
     */
    try {
      expect(
        (await recordFee(feeOn({ appliesFrom: "2026-01-01" }))).statusCode,
      ).toBe(201);
      const july = await recordFee(feeOn({ appliesFrom: "2026-07-01" }));
      expect(july.statusCode).toBe(201);
      const removed = await inject({
        method: "DELETE",
        url: `/api/fees/${july.json<FeeRow>().feeId}`,
        headers: { cookie: boardCookie },
      });
      expect(removed.statusCode).toBe(204);

      const march = await recordFee(feeOn({ appliesFrom: "2026-03-01" }));

      expect(march.statusCode).toBe(409);
      expect(march.json<{ reason: string }>().reason).toBe(
        "fee-already-in-force",
      );
      // And the register still has one answer for a day inside that window.
      const april = await readRegister("2026-04-15");
      expect(
        april.apartments.find((entry) => entry.apartmentId === apartmentId)
          ?.fees,
      ).toHaveLength(1);
    } finally {
      await clearFees();
    }
  });

  it("takes a rate from the day after the closed one ends", async () => {
    // The correction the refusal points to, which has to stay open.
    try {
      await recordFee(feeOn({ appliesFrom: "2026-01-01" }));
      const july = await recordFee(feeOn({ appliesFrom: "2026-07-01" }));
      await inject({
        method: "DELETE",
        url: `/api/fees/${july.json<FeeRow>().feeId}`,
        headers: { cookie: boardCookie },
      });

      const response = await recordFee(feeOn({ appliesFrom: "2026-07-01" }));
      expect(response.statusCode).toBe(201);
    } finally {
      await clearFees();
    }
  });

  it("serialises two rates recorded at once for one apartment and kind", async () => {
    /*
     * Check-then-act with nothing in the table to stop it: two requests for the
     * same day both read "nothing later, nothing open" and both insert, and the
     * apartment has two open rates. The transaction below stands in for the
     * first request - it takes the lock the service takes, writes its rate and
     * holds - and the request is sent while it holds. Under the lock the request
     * waits, then reads the committed rate and is refused; without the lock it
     * reads before the commit and writes a second rate.
     */
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = (): void => {
        resolve();
      };
    });
    let holding = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    try {
      const first = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fee-rates:${apartmentId}:ANNUAL_FEE`}))`;
          await tx.fee.create({
            data: {
              apartmentId,
              kind: "ANNUAL_FEE",
              appliesFrom: new Date("2026-03-01"),
              monthlyAmount: "3450.50",
              vatTreatment: "EXEMPT",
              recordedByPersonId: board.personId,
              financialYearStartMonth: 1,
            },
          });
          holding();
          await held;
        },
        { timeout: 20_000 },
      );

      await locked;
      const second = recordFee(feeOn({ appliesFrom: "2026-03-01" }));
      await settle();
      release();
      await first;

      const response = await second;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "fee-already-recorded-later",
      );
      expect(
        await prisma.fee.count({ where: { apartmentId, kind: "ANNUAL_FEE" } }),
      ).toBe(1);
    } finally {
      release();
      await clearFees();
    }
  });
});

describe("who may reach the fees", () => {
  it("refuses a resident and the external property manager", async () => {
    for (const cookie of [memberCookie, managerCookie]) {
      const read = await inject({
        method: "GET",
        url: "/api/fees?on=2026-06-15",
        headers: { cookie },
      });
      expect(read.statusCode).toBe(403);

      const write = await recordFee(feeOn(), cookie);
      expect(write.statusCode).toBe(403);
    }
  });

  it("refuses anybody with no session at all", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/fees?on=2026-06-15",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("issuing a period's notices", () => {
  it("bills each apartment its rate times the months in the period", async () => {
    await recordFee(feeOn());
    await recordFee(
      feeOn({ apartmentId: secondApartmentId, monthlyAmount: "3000.00" }),
    );

    const response = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-03-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const run = response.json<FeeNotificationSummary>();
    expect(run.notices).toBe(2);
    // Three months at 3450.50 and 3000.00, summed in ore.
    expect(run.total).toBe("19351.50");

    const notices = await prisma.feeNotice.findMany({
      where: { notificationId: run.notificationId },
      orderBy: [{ paymentReference: "asc" }],
      select: { apartmentId: true, amount: true, paymentReference: true },
    });
    expect(notices.map((notice) => notice.amount.toFixed(2))).toEqual([
      "10351.50",
      "9000.00",
    ]);
    // Nine digits, and the period's own month at the front.
    for (const notice of notices) {
      expect(notice.paymentReference).toMatch(/^2601\d{5}$/u);
    }

    await clearFees();
  });

  it("refuses a period that is not whole calendar months", async () => {
    await recordFee(feeOn());

    const response = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-15", to: "2026-03-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "period-not-whole-months",
    );

    await clearFees();
  });

  it("refuses a second run over the same period and an overlapping one", async () => {
    await recordFee(feeOn());
    const first = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-03-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);

    const same = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-03-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json<{ reason: string }>().reason).toBe(
      "period-already-issued",
    );

    const overlapping = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-03-01", to: "2026-05-31", dueOn: "2026-03-31" },
      headers: { cookie: boardCookie },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json<{ reason: string }>().reason).toBe(
      "period-overlaps-a-run",
    );

    await clearFees();
  });

  it("refuses a run that would bill nothing at all", async () => {
    // An empty run states that the board issued the period's notices when it
    // issued none, and it would take the period so the real run could never be
    // made.
    const response = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2030-01-01", to: "2030-01-31", dueOn: "2030-01-31" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("nothing-to-bill");
  });

  it("refuses a due date before the period it bills", async () => {
    await recordFee(feeOn());

    const response = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-02-01", to: "2026-02-28", dueOn: "2026-01-01" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "due-before-period",
    );

    await clearFees();
  });

  it("bills only the months a rate was actually in force", async () => {
    // The rate starts in February, so a January-to-March run bills two months
    // and not three.
    await recordFee(feeOn({ appliesFrom: "2026-02-01" }));

    const response = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-03-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<FeeNotificationSummary>().total).toBe("6901.00");

    await clearFees();
  });
});

describe("two runs at once", () => {
  it("serialises two overlapping runs issued together", async () => {
    /*
     * The unique on the period stops two identical runs and nothing else. Two
     * overlapping ones issued at the same moment both read "no run covers these
     * months" and both bill them. The transaction below stands in for the first
     * run - it takes the service's lock, inserts a run over February to April
     * and holds - and a January to March run is issued while it holds. Under
     * the lock the second waits and then sees the first; without it, it bills
     * February and March a second time.
     */
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = (): void => {
        resolve();
      };
    });
    let holding = (): void => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    try {
      await recordFee(feeOn());

      const first = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fee-notifications"}))`;
          const run = await tx.feeNotification.create({
            data: {
              periodFrom: new Date("2026-02-01"),
              periodTo: new Date("2026-04-30"),
              dueOn: new Date("2026-02-28"),
              issuedByPersonId: board.personId,
              financialYearStartMonth: 1,
            },
            select: { id: true },
          });
          ownRunIds.add(run.id);
          holding();
          await held;
        },
        { timeout: 20_000 },
      );

      await locked;
      const second = inject({
        method: "POST",
        url: "/api/fee-notifications",
        payload: { from: "2026-01-01", to: "2026-03-31", dueOn: "2026-01-31" },
        headers: { cookie: boardCookie },
      });
      await settle();
      release();
      await first;

      const response = await second;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "period-overlaps-a-run",
      );
    } finally {
      release();
      await clearFees();
    }
  });
});

describe("the document", () => {
  it("withholds a protected holder's name and never the apartment", async () => {
    await recordFee(feeOn());
    await recordFee(
      feeOn({ apartmentId: secondApartmentId, monthlyAmount: "3000.00" }),
    );
    const run = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-01-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });
    const notificationId = run.json<FeeNotificationSummary>().notificationId;

    const response = await inject({
      method: "POST",
      url: `/api/fee-notifications/${notificationId}/document`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    const produced = response.json<FeeNoticeExport>();

    const masked = produced.document.rows.find((row) =>
      row.apartment.endsWith("1502"),
    );
    expect(masked?.holders).toEqual({ state: "withheld" });
    // The flat is on the row either way: it is the party the fee is fixed on,
    // and withholding it would empty the notice of the thing it is about.
    expect(masked?.apartment).toBe(`Avgiftsgatan ${suffix} 1502`);
    expect(produced.csv).not.toContain("Signe");
    expect(produced.csv).toContain("protected");

    const visible = produced.document.rows.find((row) =>
      row.apartment.endsWith("1501"),
    );
    expect(visible?.holders).toEqual({
      state: "visible",
      names: ["Astrid Medlem"],
    });

    await clearFees();
  });

  it("records who produced it, and what they took", async () => {
    await recordFee(feeOn());
    const run = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-01-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });
    const notificationId = run.json<FeeNotificationSummary>().notificationId;

    await inject({
      method: "POST",
      url: `/api/fee-notifications/${notificationId}/document`,
      headers: { cookie: boardCookie },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "FEE_NOTIFICATION_EXPORTED",
        targetId: notificationId,
      },
      select: { actorPersonId: true, context: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorPersonId).toBe(board.personId);
    // Which run was taken and nothing it held.
    expect(JSON.stringify(entries[0]?.context)).not.toContain("3450");

    await clearFees();
  });

  it("is refused to a resident and to the property manager", async () => {
    await recordFee(feeOn());
    const run = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-01-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });
    const notificationId = run.json<FeeNotificationSummary>().notificationId;

    for (const cookie of [memberCookie, managerCookie]) {
      const response = await inject({
        method: "POST",
        url: `/api/fee-notifications/${notificationId}/document`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(403);
    }

    await clearFees();
  });
});

describe("removing a rate", () => {
  it("removes one recorded in error", async () => {
    const created = await recordFee(feeOn());
    const feeId = created.json<FeeRow>().feeId;

    const response = await inject({
      method: "DELETE",
      url: `/api/fees/${feeId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(204);
    expect(await prisma.fee.findUnique({ where: { id: feeId } })).toBeNull();
  });

  it("refuses to remove one a run has already billed", async () => {
    // The notice is the basis for money the association asked for, and
    // bokforingslagen 7 kap. 1 § forbids altering preserved
    // rakenskapsinformation.
    const created = await recordFee(feeOn());
    const feeId = created.json<FeeRow>().feeId;
    await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-01-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });

    const response = await inject({
      method: "DELETE",
      url: `/api/fees/${feeId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("fee-notified");

    await clearFees();
  });
});

describe("the apartment register", () => {
  it("refuses to remove an apartment carrying a fee, by name", async () => {
    await recordFee(feeOn({ apartmentId: emptyApartmentId }));

    const response = await inject({
      method: "DELETE",
      url: `/api/apartments/${emptyApartmentId}`,
      headers: { cookie: boardCookie },
    });

    // The refusal names the record in the way rather than surfacing as a
    // foreign key error.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("apartment-in-use");

    await clearFees();
  });

  it("records the participation share and the initial share capital", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/apartment-shares",
      payload: {
        apartments: [
          {
            apartmentId: secondApartmentId,
            participationShare: "0.03125",
            initialShareCapital: "150000.00",
          },
        ],
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ recorded: number }>().recorded).toBe(1);

    const stored = await prisma.apartment.findUnique({
      where: { id: secondApartmentId },
      select: { participationShare: true, initialShareCapital: true },
    });
    expect(stored?.participationShare?.toString()).toBe("0.03125");
    expect(stored?.initialShareCapital?.toFixed(2)).toBe("150000.00");

    // The entry names the fields and never the figures: the insats is
    // confidential to this register and the log is exempt from every purge.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "APARTMENT_SHARES_RECORDED",
        targetId: secondApartmentId,
      },
      select: { context: true },
    });
    expect(entries.length).toBeGreaterThan(0);
    const context = JSON.stringify(entries.at(-1)?.context);
    expect(context).toContain("participationShare");
    expect(context).not.toContain("150000");
  });

  it("writes nothing for an apartment resubmitted unchanged", async () => {
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "APARTMENT_SHARES_RECORDED",
        targetId: secondApartmentId,
      },
    });

    await inject({
      method: "POST",
      url: "/api/apartment-register/apartment-shares",
      payload: {
        apartments: [
          {
            apartmentId: secondApartmentId,
            // The column renders its full scale, so the same figure comes back
            // spelled differently. An entry here would say an act happened that
            // did not.
            participationShare: "0.03125000",
            initialShareCapital: "150000.00",
          },
        ],
      },
      headers: { cookie: boardCookie },
    });

    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "APARTMENT_SHARES_RECORDED",
          targetId: secondApartmentId,
        },
      }),
    ).toBe(before);
  });

  it("refuses a batch naming one apartment twice, and writes nothing", async () => {
    /*
     * Two rows for one apartment have no single answer to what its figures now
     * are. Applied in turn, the later would silently win and the log would carry
     * two entries for one change to a confidential statutory register.
     */
    const before = await prisma.apartment.findUnique({
      where: { id: apartmentId },
      select: { participationShare: true, initialShareCapital: true },
    });
    const entries = await prisma.auditLogEntry.count({
      where: { action: "APARTMENT_SHARES_RECORDED", targetId: apartmentId },
    });

    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/apartment-shares",
      payload: {
        apartments: [
          {
            apartmentId,
            participationShare: "0.04",
            initialShareCapital: "140000.00",
          },
          {
            apartmentId,
            participationShare: "0.05",
            initialShareCapital: "150000.00",
          },
        ],
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-listed-twice",
    );
    const after = await prisma.apartment.findUnique({
      where: { id: apartmentId },
      select: { participationShare: true, initialShareCapital: true },
    });
    expect(after?.participationShare?.toString()).toBe(
      before?.participationShare?.toString(),
    );
    expect(after?.initialShareCapital?.toFixed(2)).toBe(
      before?.initialShareCapital?.toFixed(2),
    );
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "APARTMENT_SHARES_RECORDED", targetId: apartmentId },
      }),
    ).toBe(entries);
  });

  it("is refused to a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/apartment-shares",
      payload: {
        apartments: [
          {
            apartmentId,
            participationShare: "0.05",
            initialShareCapital: null,
          },
        ],
      },
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the data subject access report", () => {
  it("carries the fees and the notices of a flat this person lived in", async () => {
    await recordFee(feeOn());
    await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2026-01-01", to: "2026-01-31", dueOn: "2026-01-31" },
      headers: { cookie: boardCookie },
    });

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${member.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<DataSubjectReport>();

    const fee = report.fees.find((entry) => entry.apartment.endsWith("1501"));
    expect(fee?.monthlyAmount).toBe("3450.50");
    // Null while the rate is in force: no preservation period has run out on a
    // fact that is still true.
    expect(fee?.erasableFrom).toBeNull();

    const notice = report.feeNotices.find((entry) =>
      entry.apartment.endsWith("1501"),
    );
    expect(notice?.amount).toBe("3450.50");
    expect(notice?.paymentReference).toMatch(/^\d{9}$/u);
    // Anchored on the end of the period the notice billed, seven years on.
    expect(notice?.erasableFrom).toBe("2034-01-01");

    await clearFees();
  });
});

describe("the erasure date an access report states", () => {
  it("is counted from the financial year the run was issued under", async () => {
    /*
     * The date on the report is a promise to a named person, so it has to be
     * the one the purge will act on - and it must not move when the setting
     * does. A June 2026 run issued while the year ran from May is preserved
     * from the end of 2027 and erasable on 1 January 2035. Read off the setting
     * after the association moved to the calendar year, it would state 2034.
     */
    try {
      await setStartMonth(5);
      await recordFee(feeOn({ appliesFrom: "2026-06-01" }));
      const run = await inject({
        method: "POST",
        url: "/api/fee-notifications",
        payload: { from: "2026-06-01", to: "2026-06-30", dueOn: "2026-06-30" },
        headers: { cookie: boardCookie },
      });
      expect(run.statusCode).toBe(201);
      await setStartMonth(1);

      const response = await inject({
        method: "POST",
        url: `/api/data-subject-reports/persons/${member.personId}`,
        headers: { cookie: boardCookie },
      });
      expect(response.statusCode).toBe(200);
      const notice = response
        .json<DataSubjectReport>()
        .feeNotices.find((entry) => entry.periodFrom === "2026-06-01");
      expect(notice?.erasableFrom).toBe("2035-01-01");
    } finally {
      await setStartMonth(originalStartMonth);
      await clearFees();
    }
  });
});

describe("the purge", () => {
  it("erases a rate that has ended and leaves one in force", async () => {
    await recordFee(feeOn({ appliesFrom: "2020-01-01" }));
    await recordFee(feeOn({ appliesFrom: "2020-07-01" }));

    const standing = await prisma.fee.findFirst({
      where: { apartmentId, appliesUntil: null },
      select: { id: true },
    });
    expect(standing).not.toBeNull();

    const purge = app.get(FeePurgeService);
    const summary = await purge.run(new Date("2029-01-02T12:00:00.000+01:00"));

    expect(summary.feesDeleted).toBeGreaterThan(0);
    // The ended rate went; the one still applying did not, at any age.
    expect(
      await prisma.fee.findUnique({ where: { id: standing?.id ?? "" } }),
    ).not.toBeNull();

    await clearFees();
  });

  it("follows the financial year each row was kept in, not today's", async () => {
    /*
     * The correction this pull request makes, and the stamp that keeps it. On a
     * year running from the 1st of May, June 2021 falls in the year that ends
     * in April 2022, so a rate ending then and the run billing that month are
     * preserved from the end of 2022.
     *
     * Then the association moves its year back to the calendar year. That
     * changes the books kept from now on and not the ones that closed in 2022:
     * read off today's setting, the rows would be erasable from 2029 - a year
     * before bokforingslagen 7 kap. 2 § allows, and a year before the date an
     * access report stated. Each row carries the month it was written under,
     * and the purge reads that.
     */
    try {
      await setStartMonth(5);
      await recordFee(feeOn({ appliesFrom: "2021-06-01" }));
      const run = await inject({
        method: "POST",
        url: "/api/fee-notifications",
        payload: { from: "2021-06-01", to: "2021-06-30", dueOn: "2021-06-30" },
        headers: { cookie: boardCookie },
      });
      expect(run.statusCode).toBe(201);
      await recordFee(feeOn({ appliesFrom: "2021-07-01" }));

      await setStartMonth(1);

      const stamped = await prisma.fee.findMany({
        where: { apartmentId },
        select: { financialYearStartMonth: true },
      });
      expect(stamped.map((fee) => fee.financialYearStartMonth)).toEqual([5, 5]);

      const purge = app.get(FeePurgeService);

      // On the calendar year's reckoning both rows would be gone by now.
      const early = await purge.run(new Date("2029-06-01T12:00:00.000+02:00"));
      expect(early.feesDeleted).toBe(0);
      expect(early.noticesDeleted).toBe(0);

      const later = await purge.run(new Date("2030-06-01T12:00:00.000+02:00"));
      expect(later.feesDeleted).toBeGreaterThan(0);
      expect(later.noticesDeleted).toBeGreaterThan(0);
    } finally {
      await setStartMonth(originalStartMonth);
      await clearFees();
    }
  });

  it("is stopped by a legal hold against anybody who lived there", async () => {
    await recordFee(feeOn({ appliesFrom: "2020-01-01" }));
    await recordFee(feeOn({ appliesFrom: "2020-07-01" }));
    const hold = await prisma.legalHold.create({
      data: {
        personId: member.personId,
        reason: `Tvist ${suffix}`,
        placedByPersonId: board.personId,
      },
    });

    const purge = app.get(FeePurgeService);
    const summary = await purge.run(new Date("2029-01-02T12:00:00.000+01:00"));

    expect(summary.feesDeleted).toBe(0);
    expect(await prisma.fee.count({ where: { apartmentId } })).toBeGreaterThan(
      0,
    );

    await prisma.legalHold.delete({ where: { id: hold.id } });
    await clearFees();
  });

  it("erases a notice and the run once nothing of it is left", async () => {
    await recordFee(feeOn({ appliesFrom: "2020-01-01" }));
    const run = await inject({
      method: "POST",
      url: "/api/fee-notifications",
      payload: { from: "2020-01-01", to: "2020-01-31", dueOn: "2020-01-31" },
      headers: { cookie: boardCookie },
    });
    const notificationId = run.json<FeeNotificationSummary>().notificationId;

    const purge = app.get(FeePurgeService);
    const summary = await purge.run(new Date("2029-01-02T12:00:00.000+01:00"));

    expect(summary.noticesDeleted).toBeGreaterThan(0);
    expect(
      await prisma.feeNotification.findUnique({
        where: { id: notificationId },
      }),
    ).toBeNull();

    // One entry per apartment, naming the counts and never a figure.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "SERVICE_DATA_PURGED", targetId: apartmentId },
      select: { context: true, targetPersonId: true },
    });
    expect(entries.length).toBeGreaterThan(0);
    // No subject: which of the apartment's residents that would be is a
    // question the log must not answer by guessing.
    expect(entries.at(-1)?.targetPersonId).toBeNull();
    expect(JSON.stringify(entries.at(-1)?.context)).not.toContain("3450");

    await clearFees();
  });
});

describe("the fee register read", () => {
  it("lists every apartment, including one with no fee at all", async () => {
    // A board's question is as often "which flats have I not set a fee for" as
    // "what does this one pay".
    const register = await readRegister();
    const empty = ownApartments(register).find(
      (apartment) => apartment.apartmentId === emptyApartmentId,
    );

    expect(empty?.fees).toEqual([]);
    expect(empty?.monthlyAmount).toBe("0.00");
  });
});
