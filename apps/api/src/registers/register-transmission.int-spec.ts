import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { addLocalDays, formatLocalDay, localDayOf } from "@openbrf/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { AuditAction } from "../generated/prisma/enums";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import { RecordingRegisterTransmission } from "../testing/recording-register-transmission";
import type { RegisterReportQueue } from "./register-report.service";
import type { TransmissionOutcome } from "./register-transmission";
import { REGISTER_TRANSMISSION } from "./register-transmission";
import { RegisterTransmissionService } from "./register-transmission.service";

/**
 * Sending a report to the cooperative housing register, over HTTP against a
 * real database, with the stub on the other side of the port. ADR 0029.
 *
 * The stub validates every report against the schema an adapter maps from, so
 * these tests fail on a report the contract does not allow as well as on a
 * wrong record of what came of it.
 *
 * Four rules are defended here.
 *
 *   **Only Lantmäteriet's receipt discharges a duty.** A rejection leaves the
 *   duty owed, and so does every outcome nobody can read.
 *
 *   **The disclosure is on the log before the report leaves.** An outcome
 *   nobody knows still leaves the entry naming whose number went.
 *
 *   **A report that could not be complete is never sent.** Refused with nothing
 *   recorded and nothing handed over.
 *
 *   **One send per duty at a time.** A second board member pressing send while
 *   the first waits is refused, and Lantmäteriet receives one report.
 *
 *   **No connection is held across the hand-over.** A send completes on a pool
 *   of one connection, and so do several at once.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
const stub = new RecordingRegisterTransmission();

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
const surname = `Sandning${suffix}`;
const addressId = `tx-address-${suffix}`;

const actors = {
  chair: {
    personId: `tx-chair-${suffix}`,
    email: `tx-chair-${suffix}@exempel.se`,
  },
  resident: {
    personId: `tx-resident-${suffix}`,
    email: `tx-resident-${suffix}@exempel.se`,
  },
  holder: {
    personId: `tx-holder-${suffix}`,
    email: `tx-holder-${suffix}@exempel.se`,
    personalIdentityNumber: runIdentityNumber(`${suffix}-tx-holder`),
  },
  protectedHolder: {
    personId: `tx-protected-${suffix}`,
    email: `tx-protected-${suffix}@exempel.se`,
    personalIdentityNumber: runIdentityNumber(`${suffix}-tx-protected`),
  },
  /** A tenant-owner the register holds no personal identity number for. */
  unnumbered: {
    personId: `tx-unnumbered-${suffix}`,
    email: `tx-unnumbered-${suffix}@exempel.se`,
  },
} as const;
const personIds = Object.values(actors).map((actor) => actor.personId);

/** One duty per test, so no test depends on what another left behind. */
const duties = {
  unavailable: `tx-duty-unavailable-${suffix}`,
  grant: `tx-duty-grant-${suffix}`,
  transfer: `tx-duty-transfer-${suffix}`,
  rejected: `tx-duty-rejected-${suffix}`,
  unknown: `tx-duty-unknown-${suffix}`,
  malformed: `tx-duty-malformed-${suffix}`,
  quotedNumber: `tx-duty-quoted-number-${suffix}`,
  implausibleDay: `tx-duty-implausible-day-${suffix}`,
  protectedGrant: `tx-duty-protected-${suffix}`,
  unnumbered: `tx-duty-unnumbered-${suffix}`,
  race: `tx-duty-race-${suffix}`,
  blankName: `tx-duty-blank-name-${suffix}`,
  liveClaim: `tx-duty-live-claim-${suffix}`,
  staleClaim: `tx-duty-stale-claim-${suffix}`,
  onePool: `tx-duty-one-pool-${suffix}`,
  onePoolFirst: `tx-duty-one-pool-first-${suffix}`,
  onePoolSecond: `tx-duty-one-pool-second-${suffix}`,
} as const;

let createdAssociation = false;
let previousOrganizationNumber: string | null = null;
let ipCounter = 0;

function inject(options: {
  method: "GET" | "POST";
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
        // 10.64.0.0/16 is this suite's, so its requests never count against
        // another suite's rate-limit budget.
        "x-forwarded-for": `10.64.0.${String((ipCounter % 250) + 1)}`,
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

/** A calendar day offset from today, as a date column takes it. */
function column(offset: number): Date {
  return new Date(
    `${formatLocalDay(addLocalDays(localDayOf(new Date()), offset))}T00:00:00.000Z`,
  );
}

function today(): string {
  return formatLocalDay(localDayOf(new Date()));
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
      postalStreet: "Aspgatan 7",
      postalCode: "11144",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      personalIdentityNumberCipher: identityNumber?.cipher ?? null,
      personalIdentityNumberIndex: identityNumber?.index ?? null,
      protectedPersonalData: input.protectedPersonalData ?? false,
    },
  });
}

/** An apartment of its own for one duty. */
async function apartment(key: string, number: string): Promise<string> {
  const id = `tx-apartment-${key}-${suffix}`;
  await prisma.apartment.create({
    data: { id, addressId, number, floor: 1 },
  });
  return id;
}

/** A termination three days ago and the duty it opened. */
async function terminationDuty(obligationId: string, number: string) {
  const apartmentId = await apartment(obligationId, number);
  const termination = await prisma.termination.create({
    data: {
      apartmentId,
      kind: "GENERAL_MEETING_DECISION",
      reference: `Stammoprotokoll ${obligationId}`,
      tookEffectOn: column(-3),
    },
  });
  await prisma.registerReportObligation.create({
    data: {
      id: obligationId,
      kind: "TERMINATION",
      apartmentId,
      terminationId: termination.id,
      triggeredOn: column(-3),
      dueOn: column(11),
    },
  });
}

/** A grant to this person two days ago and the duty it opened. */
async function grantDuty(
  obligationId: string,
  number: string,
  toPersonId: string,
) {
  const apartmentId = await apartment(obligationId, number);
  const transfer = await prisma.transfer.create({
    data: {
      apartmentId,
      kind: "GRANT",
      toPersonId,
      transferredOn: column(-2),
      agreementReference: `Upplatelseavtal ${obligationId}`,
    },
  });
  await prisma.registerReportObligation.create({
    data: {
      id: obligationId,
      kind: "GRANT",
      apartmentId,
      transferId: transfer.id,
      triggeredOn: column(-2),
      dueOn: column(12),
    },
  });
}

function transmit(obligationId: string, cookie: string) {
  return inject({
    method: "POST",
    url: "/api/register-reports/transmissions",
    payload: { obligationId },
    headers: { cookie },
  });
}

async function entries(obligationId: string, action: AuditAction) {
  return prisma.auditLogEntry.findMany({
    where: {
      action,
      targetKind: "registerReportObligation",
      targetId: obligationId,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function dutyOnQueue(obligationId: string, cookie: string) {
  const response = await inject({
    method: "GET",
    url: "/api/register-reports",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  const queue = JSON.parse(response.body) as RegisterReportQueue;
  const duty = queue.duties.find((candidate) => candidate.id === obligationId);
  expect(duty).toBeDefined();
  return duty;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(REGISTER_TRANSMISSION)
    .useValue(stub)
    .compile();
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
      street: "Sandningsvagen",
      number: suffix,
      postalCode: "11144",
      city: "Stockholm",
      sortOrder: 953,
    },
  });

  await createPerson({ ...actors.chair, firstName: "Bea" });
  await createPerson({ ...actors.resident, firstName: "Rita" });
  await createPerson({ ...actors.holder, firstName: "Mira" });
  await createPerson({
    ...actors.protectedHolder,
    firstName: "Petra",
    protectedPersonalData: true,
  });
  await createPerson({ ...actors.unnumbered, firstName: "Uno" });

  await terminationDuty(duties.unavailable, "1100");
  await grantDuty(duties.grant, "1101", actors.holder.personId);
  await terminationDuty(duties.rejected, "1102");
  await terminationDuty(duties.unknown, "1103");
  await terminationDuty(duties.malformed, "1104");
  await grantDuty(
    duties.protectedGrant,
    "1105",
    actors.protectedHolder.personId,
  );
  await grantDuty(duties.unnumbered, "1106", actors.unnumbered.personId);
  await terminationDuty(duties.race, "1107");
  await terminationDuty(duties.quotedNumber, "1109");
  await terminationDuty(duties.implausibleDay, "1110");
  await grantDuty(duties.blankName, "1111", actors.holder.personId);
  await terminationDuty(duties.liveClaim, "1112");
  await terminationDuty(duties.staleClaim, "1113");
  await grantDuty(duties.onePool, "1114", actors.holder.personId);
  await grantDuty(duties.onePoolFirst, "1115", actors.holder.personId);
  await terminationDuty(duties.onePoolSecond, "1116");

  // An övergång to somebody already a member, which runs from the övergång.
  const transferApartment = await apartment(duties.transfer, "1108");
  const transfer = await prisma.transfer.create({
    data: {
      apartmentId: transferApartment,
      kind: "TRANSFER",
      toPersonId: actors.holder.personId,
      transferredOn: column(-1),
      reportBasis: "ALREADY_MEMBER",
      agreementReference: `Overlatelseavtal ${duties.transfer}`,
    },
  });
  await prisma.registerReportObligation.create({
    data: {
      id: duties.transfer,
      kind: "TRANSFER",
      apartmentId: transferApartment,
      transferId: transfer.id,
      triggeredOn: column(-1),
      dueOn: column(13),
    },
  });

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { organizationNumber: true },
  });
  if (association === null) {
    await prisma.association.create({
      data: {
        id: 1,
        name: `Brf Sandning ${suffix}`,
        organizationNumber: "769600-0101",
      },
    });
    createdAssociation = true;
  } else {
    previousOrganizationNumber = association.organizationNumber;
    await prisma.association.update({
      where: { id: 1 },
      data: { organizationNumber: "769600-0101" },
    });
  }

  await prisma.boardPosition.create({
    data: {
      personId: actors.chair.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15T00:00:00.000Z"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [actors.chair, actors.resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
}, 180_000);

afterEach(() => {
  stub.reset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: { organizationNumber: previousOrganizationNumber },
    });
  }
  // The statutory archive is append-only, so the transfers, the terminations,
  // the obligations and every audit entry this suite wrote stay, and their
  // apartments and persons stay with them.
  await app.close();
});

describe("who may send a report", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/transmissions",
      payload: { obligationId: duties.grant },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, and hands nothing over", async () => {
    const response = await transmit(
      duties.grant,
      await signIn(actors.resident.email),
    );

    expect(response.statusCode).toBe(403);
    expect(stub.submitted).toHaveLength(0);
  });
});

describe("an instance with nothing on the other side of the port", () => {
  it("refuses before it reads, decrypts or records anything", async () => {
    stub.available = false;
    const decrypt = vi.spyOn(encryption, "decrypt");

    const response = await transmit(
      duties.unavailable,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      reason: "transmission-not-available",
    });
    expect(stub.submitted).toHaveLength(0);
    expect(decrypt).not.toHaveBeenCalled();
    expect(
      await entries(duties.unavailable, "REGISTER_REPORT_TRANSMITTED"),
    ).toHaveLength(0);
  });
});

describe("a report Lantmäteriet received", () => {
  it("discharges the duty on Lantmäteriet's day, with its reference", async () => {
    const cookie = await signIn(actors.chair.email);
    // A day that is not today, so a service that wrote its own clock's day
    // instead of the receipt's would fail.
    const receivedOn = formatLocalDay(addLocalDays(localDayOf(new Date()), -1));
    stub.receiveNext(receivedOn);

    const response = await transmit(duties.grant, cookie);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      obligationId: duties.grant,
      outcome: "received",
      reportedOn: receivedOn,
      reference: "LM-STUB-000001",
    });

    const duty = await dutyOnQueue(duties.grant, cookie);
    expect(duty?.state).toBe("reported");
    expect(duty?.reportedOn).toBe(receivedOn);

    const made = await entries(duties.grant, "REGISTER_REPORT_MADE");
    expect(made).toHaveLength(1);
    expect(made[0]?.actorPersonId).toBe(actors.chair.personId);
    expect(made[0]?.context).toMatchObject({
      kind: "GRANT",
      reportedOn: receivedOn,
      via: "transmission",
      reference: "LM-STUB-000001",
    });
  });

  it("records the disclosure, before the receipt, naming whose number went", async () => {
    const transmitted = await entries(
      duties.grant,
      "REGISTER_REPORT_TRANSMITTED",
    );
    const made = await entries(duties.grant, "REGISTER_REPORT_MADE");
    const revealed = await prisma.auditLogEntry.findMany({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        targetKind: "registerReportObligation",
        targetId: duties.grant,
      },
    });

    expect(transmitted).toHaveLength(1);
    expect(transmitted[0]?.context).toMatchObject({
      recipient: "bostadsrattsregistret",
      personIds: [actors.holder.personId],
      protectedPersonIds: [],
    });
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.context).toMatchObject({
      via: "register-transmission",
      personIds: [actors.holder.personId],
    });
    expect(
      (transmitted[0]?.createdAt.getTime() ?? Infinity) <=
        (made[0]?.createdAt.getTime() ?? 0),
    ).toBe(true);
    // An entry records facts about the act and never a value it carried.
    expect(JSON.stringify(transmitted[0]?.context)).not.toContain(
      actors.holder.personalIdentityNumber.replace("-", ""),
    );
  });

  it("puts the disclosure on the holder's own access report", async () => {
    const report = await app.get(DataSubjectReportService).generate({
      personId: actors.holder.personId,
      actorPersonId: actors.chair.personId,
    });

    expect(
      report.auditEntries.some(
        (entry) => entry.action === "REGISTER_REPORT_TRANSMITTED",
      ),
    ).toBe(true);
  });

  it("refuses a second send of a duty already reported, and hands nothing over", async () => {
    const response = await transmit(
      duties.grant,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      reason: "report-already-recorded",
    });
    expect(stub.submitted).toHaveLength(0);
  });
});

describe("what a report carries", () => {
  it("names a transfer's acquirer by the number, in its twelve-digit form", async () => {
    stub.receiveNext(today());

    const response = await transmit(
      duties.transfer,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(200);
    expect(stub.submitted).toHaveLength(1);
    expect(stub.submitted[0]).toMatchObject({
      reference: duties.transfer,
      association: { organizationNumber: "769600-0101" },
      apartment: { number: "1108" },
      event: {
        kind: "TRANSFER",
        reportBasis: "ALREADY_MEMBER",
        membershipDecidedOn: null,
        acquirer: {
          kind: "PERSON",
          name: `Mira ${surname}`,
          personalIdentityNumber: actors.holder.personalIdentityNumber.replace(
            "-",
            "",
          ),
          protectedPersonalData: false,
        },
      },
    });
  });

  it("withholds a protected tenant-owner's address and records them as protected", async () => {
    stub.receiveNext(today());

    const response = await transmit(
      duties.protectedGrant,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(200);
    expect(stub.submitted[0]?.event).toMatchObject({
      kind: "GRANT",
      tenantOwner: { postalAddress: null, protectedPersonalData: true },
    });
    const transmitted = await entries(
      duties.protectedGrant,
      "REGISTER_REPORT_TRANSMITTED",
    );
    expect(transmitted[0]?.context).toMatchObject({
      personIds: [actors.protectedHolder.personId],
      protectedPersonIds: [actors.protectedHolder.personId],
    });
  });

  it("is refused, with nothing recorded and nothing sent, where the tenant-owner has no number", async () => {
    const response = await transmit(
      duties.unnumbered,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      reason: "tenant-owner-identity-number-missing",
    });
    expect(stub.submitted).toHaveLength(0);
    expect(
      await entries(duties.unnumbered, "REGISTER_REPORT_TRANSMITTED"),
    ).toHaveLength(0);
  });

  it("is refused, with nothing recorded and nothing sent, where the association's name is only spaces", async () => {
    /*
     * The settings store a name as typed. Trimmed, this one renders as an
     * empty name the schema refuses, and before the schema was checked here
     * the disclosure was committed and the report handed over regardless.
     */
    const { name } = await prisma.association.findUniqueOrThrow({
      where: { id: 1 },
      select: { name: true },
    });
    await prisma.association.update({
      where: { id: 1 },
      data: { name: "   " },
    });
    try {
      const response = await transmit(
        duties.blankName,
        await signIn(actors.chair.email),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        reason: "association-name-missing",
      });
      // Nor does the answer carry anything the report would have.
      expect(response.body).not.toContain(
        actors.holder.personalIdentityNumber.replace("-", ""),
      );
    } finally {
      await prisma.association.update({ where: { id: 1 }, data: { name } });
    }
    expect(stub.submitted).toHaveLength(0);
    expect(
      await entries(duties.blankName, "REGISTER_REPORT_TRANSMITTED"),
    ).toHaveLength(0);
    expect(
      await entries(duties.blankName, "PROTECTED_DATA_REVEALED"),
    ).toHaveLength(0);
  });

  it("answers an unknown duty as absent", async () => {
    const response = await transmit(
      `tx-no-such-duty-${suffix}`,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(404);
    expect(stub.submitted).toHaveLength(0);
  });
});

describe("a report Lantmäteriet rejected", () => {
  it("leaves the duty owed and records the reasons", async () => {
    const cookie = await signIn(actors.chair.email);
    stub.rejectNext("ORGNR_OKAND");

    const response = await transmit(duties.rejected, cookie);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      obligationId: duties.rejected,
      outcome: "rejected",
      reasons: ["ORGNR_OKAND"],
    });
    const duty = await dutyOnQueue(duties.rejected, cookie);
    expect(duty?.state).toBe("due");
    expect(duty?.reportedOn).toBe(null);
    expect(await entries(duties.rejected, "REGISTER_REPORT_MADE")).toHaveLength(
      0,
    );
    const rejected = await entries(duties.rejected, "REGISTER_REPORT_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.context).toMatchObject({ reasons: ["ORGNR_OKAND"] });
  });

  it("can be sent again, and discharged by the receipt that follows", async () => {
    const cookie = await signIn(actors.chair.email);
    stub.receiveNext(today());

    const response = await transmit(duties.rejected, cookie);

    expect(response.statusCode).toBe(200);
    expect((await dutyOnQueue(duties.rejected, cookie))?.state).toBe(
      "reported",
    );
  });
});

describe("a report whose outcome nobody knows", () => {
  it("leaves the duty owed, keeps the disclosure, and logs no number", async () => {
    const cookie = await signIn(actors.chair.email);
    const warn = vi.spyOn(Logger.prototype, "warn");
    // An adapter's error quoting the request it failed on, which is the shape
    // that makes logging an error's message a disclosure.
    stub.failNext(
      new Error(
        `upstream refused ${actors.holder.personalIdentityNumber} after send`,
      ),
    );

    const response = await transmit(duties.unknown, cookie);

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({
      reason: "transmission-outcome-unknown",
    });
    expect((await dutyOnQueue(duties.unknown, cookie))?.state).toBe("due");
    expect(await entries(duties.unknown, "REGISTER_REPORT_MADE")).toHaveLength(
      0,
    );
    expect(
      await entries(duties.unknown, "REGISTER_REPORT_TRANSMITTED"),
    ).toHaveLength(1);

    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(duties.unknown);
    expect(logged).not.toContain(actors.holder.personalIdentityNumber);
  });

  it("treats an answer that cannot be read as unknown, never as a receipt", async () => {
    const cookie = await signIn(actors.chair.email);
    stub.answerNext(() =>
      Promise.resolve({
        outcome: "received",
        // Not on the calendar. Written onto an append-only log as a statutory
        // date, it would be a day nobody could correct.
        receivedOn: "2026-02-30",
        reference: "LM-1",
      }),
    );

    const response = await transmit(duties.malformed, cookie);

    expect(response.statusCode).toBe(502);
    expect(
      await entries(duties.malformed, "REGISTER_REPORT_MADE"),
    ).toHaveLength(0);
    expect((await dutyOnQueue(duties.malformed, cookie))?.state).toBe("due");
  });

  it("treats a rejection quoting a number as unknown, and neither records nor logs it", async () => {
    const cookie = await signIn(actors.chair.email);
    const digits = actors.holder.personalIdentityNumber.replace("-", "");
    const log = vi.spyOn(Logger.prototype, "log");
    const warn = vi.spyOn(Logger.prototype, "warn");
    stub.rejectNext(`PNR_${digits}`);

    const response = await transmit(duties.quotedNumber, cookie);

    expect(response.statusCode).toBe(502);
    expect(
      await entries(duties.quotedNumber, "REGISTER_REPORT_REJECTED"),
    ).toHaveLength(0);
    const logged = [...log.mock.calls, ...warn.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain(duties.quotedNumber);
    expect(logged).not.toContain(digits);
  });

  it("treats a receipt on a day the report cannot have come in on as unknown", async () => {
    const cookie = await signIn(actors.chair.email);
    // A default an adapter might fall back to, which as the earliest entry on
    // an append-only log could never be corrected.
    stub.receiveNext("1970-01-01");

    const response = await transmit(duties.implausibleDay, cookie);

    expect(response.statusCode).toBe(502);
    expect(
      await entries(duties.implausibleDay, "REGISTER_REPORT_MADE"),
    ).toHaveLength(0);
    expect((await dutyOnQueue(duties.implausibleDay, cookie))?.state).toBe(
      "due",
    );
  });
});

describe("two board members sending one report at once", () => {
  it("refuses the second while the first waits, and Lantmäteriet receives one", async () => {
    const cookie = await signIn(actors.chair.email);
    let release: (outcome: TransmissionOutcome) => void = () => undefined;
    stub.answerNext(
      () =>
        new Promise<TransmissionOutcome>((resolve) => {
          release = resolve;
        }),
    );

    const first = transmit(duties.race, cookie);
    // The first holds the lock once the stub has its report.
    await vi.waitFor(
      () => {
        expect(stub.submitted).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    const second = await transmit(duties.race, cookie);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({
      reason: "transmission-in-progress",
    });

    release({ outcome: "received", receivedOn: today(), reference: "LM-RACE" });
    expect((await first).statusCode).toBe(200);
    expect(stub.submitted).toHaveLength(1);
    expect(await entries(duties.race, "REGISTER_REPORT_MADE")).toHaveLength(1);
    // Let go once the send ended.
    expect(
      await prisma.registerTransmissionClaim.count({
        where: { obligationId: duties.race },
      }),
    ).toBe(0);
  });

  it("refuses a send while a claim another process holds is live, recording nothing", async () => {
    await prisma.registerTransmissionClaim.create({
      data: {
        obligationId: duties.liveClaim,
        token: "another-process",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      const response = await transmit(
        duties.liveClaim,
        await signIn(actors.chair.email),
      );

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        reason: "transmission-in-progress",
      });
      expect(stub.submitted).toHaveLength(0);
      expect(
        await entries(duties.liveClaim, "REGISTER_REPORT_TRANSMITTED"),
      ).toHaveLength(0);
      // Not this send's to let go.
      expect(
        await prisma.registerTransmissionClaim.findUnique({
          where: { obligationId: duties.liveClaim },
        }),
      ).toMatchObject({ token: "another-process" });
    } finally {
      await prisma.registerTransmissionClaim.deleteMany({
        where: { obligationId: duties.liveClaim },
      });
    }
  });

  it("takes over a claim a process that died left behind, once it has expired", async () => {
    await prisma.registerTransmissionClaim.create({
      data: {
        obligationId: duties.staleClaim,
        token: "a-process-that-died",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    stub.receiveNext(today());

    const response = await transmit(
      duties.staleClaim,
      await signIn(actors.chair.email),
    );

    expect(response.statusCode).toBe(200);
    expect(stub.submitted).toHaveLength(1);
    expect(
      await prisma.registerTransmissionClaim.count({
        where: { obligationId: duties.staleClaim },
      }),
    ).toBe(0);
  });
});

describe("a pool of one connection", () => {
  /*
   * OPENBRF_DATABASE_POOL_SIZE may be 1. A send that held its connection
   * across the hand-over, and committed the disclosure on another, waited for
   * itself until its transaction expired. The service is built here on a
   * client of its own with one connection, beside the application's.
   */
  let onePool: PrismaService;
  let service: RegisterTransmissionService;

  beforeAll(async () => {
    onePool = new PrismaService({
      ...loadEnvForIntegrationTests(),
      OPENBRF_DATABASE_POOL_SIZE: 1,
    });
    await onePool.$connect();
    service = new RegisterTransmissionService(
      onePool,
      encryption,
      new AuditLogService(onePool),
      stub,
    );
  });

  afterAll(async () => {
    await onePool.$disconnect();
  });

  /** Holds the stub's next answer until the test lets it go. */
  function heldAnswer(): (outcome: TransmissionOutcome) => void {
    let release: (outcome: TransmissionOutcome) => void = () => undefined;
    stub.answerNext(
      () =>
        new Promise<TransmissionOutcome>((resolve) => {
          release = resolve;
        }),
    );
    return (outcome) => {
      release(outcome);
    };
  }

  it("sends a report, and leaves the connection free while it waits for the answer", async () => {
    const answer = heldAnswer();

    const sent = service.transmit({
      actorPersonId: actors.chair.personId,
      obligationId: duties.onePool,
    });
    await vi.waitFor(
      () => {
        expect(stub.submitted).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    // The one connection answers somebody else while the send waits.
    await expect(onePool.$queryRaw`SELECT 1 AS free`).resolves.toEqual([
      { free: 1 },
    ]);

    answer({ outcome: "received", receivedOn: today(), reference: "LM-ONE" });
    await expect(sent).resolves.toMatchObject({ outcome: "received" });
    expect(
      await entries(duties.onePool, "REGISTER_REPORT_TRANSMITTED"),
    ).toHaveLength(1);
    expect(
      await entries(duties.onePool, "PROTECTED_DATA_REVEALED"),
    ).toHaveLength(1);
    expect(await entries(duties.onePool, "REGISTER_REPORT_MADE")).toHaveLength(
      1,
    );
  });

  it("sends two reports at once, and refuses a third for a duty already on its way", async () => {
    const answerFirst = heldAnswer();
    const answerSecond = heldAnswer();

    const first = service.transmit({
      actorPersonId: actors.chair.personId,
      obligationId: duties.onePoolFirst,
    });
    const second = service.transmit({
      actorPersonId: actors.chair.personId,
      obligationId: duties.onePoolSecond,
    });
    // Both waiting on Lantmäteriet at once, on one connection between them.
    await vi.waitFor(
      () => {
        expect(stub.submitted).toHaveLength(2);
      },
      { timeout: 10_000 },
    );

    await expect(
      service.transmit({
        actorPersonId: actors.chair.personId,
        obligationId: duties.onePoolFirst,
      }),
    ).rejects.toMatchObject({ reason: "transmission-in-progress" });

    // Either may have reached the stub first, so both are answered alike.
    answerFirst({
      outcome: "received",
      receivedOn: today(),
      reference: "LM-ONE-A",
    });
    answerSecond({
      outcome: "received",
      receivedOn: today(),
      reference: "LM-ONE-B",
    });
    await expect(first).resolves.toMatchObject({ outcome: "received" });
    await expect(second).resolves.toMatchObject({ outcome: "received" });
    expect(stub.submitted).toHaveLength(2);
    expect(
      await prisma.registerTransmissionClaim.count({
        where: {
          obligationId: { in: [duties.onePoolFirst, duties.onePoolSecond] },
        },
      }),
    ).toBe(0);
  });
});
