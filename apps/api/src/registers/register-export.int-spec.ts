import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import {
  addLocalDays,
  formatLocalDay,
  localDayOf,
} from "../bookings/stockholm-calendar";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { RegisterReportMailerService } from "./register-report-mailer.service";
import { MailService, type SendMailInput } from "../mail/mail.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import type { InitialSupply } from "./initial-supply.service";
import type { RegisterReportQueue } from "./register-report.service";

/**
 * Reporting to the cooperative housing register, over HTTP against a real
 * database.
 *
 * Three things are defended here, and each of them is a rule rather than a
 * behaviour.
 *
 *   **A passed deadline is a state of its own.** Lag (2026:484) 3 kap. 10 § lets
 *   Lantmateriet order a late report in under penalty of a fine, so a duty whose
 *   fortnight has run out must never come back as one still inside its window.
 *
 *   **Discharging a duty writes no register row.** The obligation ledger is
 *   append-only on both of the statutory tier's mechanisms, so recording that a
 *   report was made has to leave the row untouched and put the fact in the audit
 *   log - which is checked by reading the row back as well as by reading the log.
 *
 *   **The initial supply is an audited disclosure.** It is the second operation
 *   in the product that decrypts a personal identity number, so it is refused
 *   without the capability, it writes both of its entries in the transaction that
 *   produced the file, and no log line carries a number.
 *
 * The notification is checked on the same reading as the booking and move mail:
 * the seam is MailService.send, everything up to it runs for real, and a mail
 * server that refuses must not take the register write with it.
 */

loadEnvForIntegrationTests();
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let mail: MailService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
const surname = `Anmalan${suffix}`;

const addressId = `rep-address-${suffix}`;
const apartments = {
  terminated: `rep-apartment-a-${suffix}`,
  transferred: `rep-apartment-b-${suffix}`,
  protected: `rep-apartment-c-${suffix}`,
};

const actors = {
  /** Records the register events, and the recipient the messages are read on. */
  chair: {
    personId: `rep-chair-${suffix}`,
    email: `rep-chair-${suffix}@exempel.se`,
    locale: "sv",
  },
  /**
   * A second seat, reading English.
   *
   * The locale assertion is falsifiable only because these two differ: a message
   * rendered in the language of whoever recorded the event would still be
   * Swedish for the chair and would fail here.
   */
  treasurer: {
    personId: `rep-treasurer-${suffix}`,
    email: `rep-treasurer-${suffix}@exempel.se`,
    locale: "en",
  },
  holder: {
    personId: `rep-holder-${suffix}`,
    email: `rep-holder-${suffix}@exempel.se`,
    locale: "sv",
    personalIdentityNumber: runIdentityNumber(`${suffix}-holder`),
  },
  protectedHolder: {
    personId: `rep-protected-${suffix}`,
    email: `rep-protected-${suffix}@exempel.se`,
    locale: "sv",
    personalIdentityNumber: runIdentityNumber(`${suffix}-protected`),
  },
  /** Holds no register capability at all. */
  resident: {
    personId: `rep-resident-${suffix}`,
    email: `rep-resident-${suffix}@exempel.se`,
    locale: "sv",
  },
} as const;

const personIds = Object.values(actors).map((actor) => actor.personId);

/** The transfer whose membership decision this suite records. */
const TRANSFER_ID = `rep-transfer-${suffix}`;

let createdAssociation = false;
let previousDesignation: string | null = null;

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
        // 10.38.0.0/16 is this suite's; the others each hold their own second
        // octet, so one suite's requests never count against another's
        // rate-limit budget. 10.40.0.1 to 10.40.0.4 are reserved for the
        // screenshot walk's four actors and are never taken by a suite.
        "x-forwarded-for": `10.38.0.${String((ipCounter % 250) + 1)}`,
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
  locale: string;
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
      preferredLocale: input.locale,
    },
  });
}

/** A calendar day offset from today, as the API takes it. */
function day(offset: number): string {
  return formatLocalDay(addLocalDays(localDayOf(new Date()), offset));
}

/** Every message the mail layer was handed, with the send stubbed out. */
function captureSends(): SendMailInput<unknown>[] {
  const captured: SendMailInput<unknown>[] = [];
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    captured.push(input as SendMailInput<unknown>);
  });
  return captured;
}

/**
 * A rejection shaped like the one that actually happens.
 *
 * A mail server refusing a recipient quotes the envelope back, so the message
 * carries the address the send was given. That is the whole reason the log line
 * names the failure by class and by obligation id, and this is what makes the
 * assertion about it mean something.
 */
class EnvelopeRefused extends Error {
  constructor(envelope: string) {
    super(`550 5.1.1 <${envelope}>: recipient rejected`);
    this.name = "EnvelopeRefused";
  }
}

async function queueFor(cookie: string): Promise<RegisterReportQueue> {
  const response = await inject({
    method: "GET",
    url: "/api/register-reports",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as RegisterReportQueue;
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
  mail = app.get(MailService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Anmalningsvagen",
      number: suffix,
      postalCode: "11144",
      city: "Stockholm",
      sortOrder: 930,
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.terminated, addressId, number: "1101", floor: 1 },
      { id: apartments.transferred, addressId, number: "1102", floor: 1 },
      { id: apartments.protected, addressId, number: "1103", floor: 1 },
    ],
  });

  for (const actor of [
    { ...actors.chair, firstName: "Bea" },
    { ...actors.treasurer, firstName: "Tom" },
    { ...actors.holder, firstName: "Mira" },
    { ...actors.protectedHolder, firstName: "Petra" },
    { ...actors.resident, firstName: "Rita" },
  ]) {
    await createPerson({
      personId: actor.personId,
      firstName: actor.firstName,
      email: actor.email,
      locale: actor.locale,
      personalIdentityNumber:
        "personalIdentityNumber" in actor
          ? actor.personalIdentityNumber
          : undefined,
      protectedPersonalData: actor.personId === actors.protectedHolder.personId,
    });
  }

  await prisma.residency.createMany({
    data: [
      {
        personId: actors.holder.personId,
        apartmentId: apartments.transferred,
        role: "MEMBER",
        movedInOn: new Date("2024-03-01T00:00:00.000Z"),
      },
      {
        personId: actors.protectedHolder.personId,
        apartmentId: apartments.protected,
        role: "MEMBER",
        movedInOn: new Date("2024-04-01T00:00:00.000Z"),
      },
      {
        personId: actors.resident.personId,
        apartmentId: apartments.protected,
        role: "RESIDENT",
        movedInOn: new Date("2024-04-01T00:00:00.000Z"),
      },
    ],
  });

  await prisma.transfer.create({
    data: {
      id: TRANSFER_ID,
      apartmentId: apartments.transferred,
      fromPersonId: null,
      toPersonId: actors.holder.personId,
      transferredOn: new Date("2024-03-01T00:00:00.000Z"),
      agreementReference: `Upplatelseavtal ${suffix}`,
    },
  });

  await prisma.lienNote.create({
    data: {
      apartmentId: apartments.transferred,
      creditor: `Aspbanken ${suffix}`,
      notedOn: new Date("2024-03-15T00:00:00.000Z"),
      amount: "1750000.00",
    },
  });
  // A released note, which the supply must leave out: it no longer applies, and
  // Lag (2026:485) 11 § preserves a panträtt that had sakrattsligt skydd.
  await prisma.lienNote.create({
    data: {
      apartmentId: apartments.protected,
      creditor: `Slutbanken ${suffix}`,
      notedOn: new Date("2024-05-01T00:00:00.000Z"),
      releasedOn: new Date("2025-01-01T00:00:00.000Z"),
    },
  });

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { propertyDesignation: true },
  });
  if (association === null) {
    await prisma.association.create({
      data: {
        id: 1,
        name: `Brf Anmalan ${suffix}`,
        organizationNumber: "769600-0101",
        propertyDesignation: `Talgoxen ${suffix}`,
      },
    });
    createdAssociation = true;
  } else {
    previousDesignation = association.propertyDesignation;
    await prisma.association.update({
      where: { id: 1 },
      data: { propertyDesignation: `Talgoxen ${suffix}` },
    });
  }

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: actors.chair.personId,
        position: "CHAIR",
        electedOn: new Date("2026-05-15T00:00:00.000Z"),
      },
      {
        personId: actors.treasurer.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-05-15T00:00:00.000Z"),
      },
    ],
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
  // The statutory archive is append-only, so the transfer, the termination, the
  // lien notes, the obligations and every audit entry this suite wrote stay, and
  // their apartments and persons stay with them.
  await app.close();
});

describe("who may read the reporting queue", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/register-reports",
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/register-reports",
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });

  it("admits a board member", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/register-reports",
      headers: { cookie: await signIn(actors.chair.email) },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("a duty whose fortnight has run out", () => {
  it("comes back as past the deadline and never as one still to report", async () => {
    /*
     * The load-bearing assertion of this file. A termination recorded thirty days
     * after it took effect arrives with its window already closed, which is the
     * true state and the one 3 kap. 10 § attaches a fine to. A queue that read
     * the state off anything but the deadline would put this row in with the ones
     * the association still has a fortnight for.
     */
    const cookie = await signIn(actors.chair.email);
    const recorded = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.terminated,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: day(-30),
        reference: `Protokoll ${suffix}`,
      },
      headers: { cookie },
    });
    expect(recorded.statusCode).toBe(201);

    const queue = await queueFor(cookie);
    const duty = queue.duties.find(
      (candidate) => candidate.apartmentId === apartments.terminated,
    );

    expect(duty?.state).toBe("overdue");
    expect(duty?.kind).toBe("TERMINATION");
    expect(duty?.triggeredOn).toBe(day(-30));
    expect(duty?.dueOn).toBe(day(-16));
    // Sixteen days past, stated as a negative count so the screen can render it
    // as sixteen days late rather than as a date to subtract.
    expect(duty?.daysUntilDue).toBe(-16);
    expect(duty?.reportedOn).toBeNull();
  });

  it("leads the queue, ahead of a duty still inside its window", async () => {
    const cookie = await signIn(actors.chair.email);
    const recorded = await inject({
      method: "POST",
      url: "/api/apartment-register/membership-decision",
      payload: { transferId: TRANSFER_ID, membershipDecidedOn: day(0) },
      headers: { cookie },
    });
    expect(recorded.statusCode).toBe(200);

    const queue = await queueFor(cookie);
    const mine = queue.duties.filter((duty) =>
      Object.values(apartments).includes(duty.apartmentId),
    );

    expect(mine[0]?.apartmentId).toBe(apartments.terminated);
    const transfer = mine.find(
      (duty) => duty.apartmentId === apartments.transferred,
    );
    expect(transfer?.state).toBe("due");
    expect(transfer?.dueOn).toBe(day(14));
    // Zero would be the last day of the window, which is inside it.
    expect(transfer?.daysUntilDue).toBe(14);
  });
});

describe("recording that a report was made", () => {
  async function obligationFor(apartmentId: string): Promise<string> {
    const obligation = await prisma.registerReportObligation.findFirst({
      where: { apartmentId },
      select: { id: true },
    });
    expect(obligation).not.toBeNull();
    return obligation?.id ?? "";
  }

  it("writes the fact to the audit log and leaves the ledger row untouched", async () => {
    /*
     * The whole property. register_report_obligation is append-only on a trigger
     * and on a REVOKE, so the discharge cannot be a column - and this asserts
     * that it was not smuggled in as one either. The row is read back field by
     * field, and the entry is what carries the day stated.
     */
    const cookie = await signIn(actors.chair.email);
    const obligationId = await obligationFor(apartments.terminated);
    const before = await prisma.registerReportObligation.findUniqueOrThrow({
      where: { id: obligationId },
    });

    const response = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: { obligationId, reportedOn: day(-2) },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);

    const after = await prisma.registerReportObligation.findUniqueOrThrow({
      where: { id: obligationId },
    });
    expect(after).toEqual(before);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "REGISTER_REPORT_MADE",
        targetKind: "registerReportObligation",
        targetId: obligationId,
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorPersonId).toBe(actors.chair.personId);
    expect(entries[0]?.context).toMatchObject({
      reportedOn: day(-2),
      triggeredOn: day(-30),
      dueOn: day(-16),
      kind: "TERMINATION",
      apartmentId: apartments.terminated,
    });
  });

  it("shows the duty as reported afterwards, with the day stated", async () => {
    const cookie = await signIn(actors.chair.email);
    const queue = await queueFor(cookie);
    const duty = queue.duties.find(
      (candidate) => candidate.apartmentId === apartments.terminated,
    );

    expect(duty?.state).toBe("reported");
    // The two dates stay on the row, so a duty reported after its deadline still
    // says so. The state answers whether anything is owed; these answer whether
    // it was in time.
    expect(duty?.reportedOn).toBe(day(-2));
    expect(duty?.dueOn).toBe(day(-16));
  });

  it("refuses a second statement about the same anmalan", async () => {
    const cookie = await signIn(actors.chair.email);
    const obligationId = await obligationFor(apartments.terminated);

    const response = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: { obligationId, reportedOn: day(-1) },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    // And no second entry, so the log still answers "when was this reported"
    // with one day.
    const entries = await prisma.auditLogEntry.count({
      where: {
        action: "REGISTER_REPORT_MADE",
        targetId: obligationId,
      },
    });
    expect(entries).toBe(1);
  });

  it("refuses a day that has not arrived, and one before the window opened", async () => {
    const cookie = await signIn(actors.chair.email);
    const obligationId = await obligationFor(apartments.transferred);

    const future = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: { obligationId, reportedOn: day(1) },
      headers: { cookie },
    });
    expect(future.statusCode).toBe(400);

    const tooEarly = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: { obligationId, reportedOn: day(-1) },
      headers: { cookie },
    });
    expect(tooEarly.statusCode).toBe(400);

    expect(
      await prisma.auditLogEntry.count({
        where: { action: "REGISTER_REPORT_MADE", targetId: obligationId },
      }),
    ).toBe(0);
  });

  it("answers 404 for an obligation the ledger does not hold", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: { obligationId: `missing-${suffix}`, reportedOn: day(0) },
      headers: { cookie: await signIn(actors.chair.email) },
    });

    expect(response.statusCode).toBe(404);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/reported",
      payload: {
        obligationId: await obligationFor(apartments.transferred),
        reportedOn: day(0),
      },
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the notice that a window has opened", () => {
  it("reaches every board member in their own language", async () => {
    const cookie = await signIn(actors.chair.email);
    const captured = captureSends();

    const recorded = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.protected,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: day(-1),
        reference: `Kopebrev ${suffix}`,
      },
      headers: { cookie },
    });
    expect(recorded.statusCode).toBe(201);

    // Counted relatively: the worker's database carries other suites' board
    // members, and this suite must not depend on how many.
    const board: readonly string[] = [
      actors.chair.email,
      actors.treasurer.email,
    ];
    const mine = captured.filter((message) => board.includes(message.to));
    expect(mine).toHaveLength(2);
    for (const message of mine) {
      expect(message.template.id).toBe("register-report-obligation");
    }
    // The recipient's own row, and not the locale of whoever recorded the event.
    expect(
      mine.find((message) => message.to === actors.chair.email)?.locale,
    ).toBe("sv");
    expect(
      mine.find((message) => message.to === actors.treasurer.email)?.locale,
    ).toBe("en");
  });

  it("states the deadline the ledger entered and nobody's name", async () => {
    const cookie = await signIn(actors.chair.email);
    const captured = captureSends();

    await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.transferred,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: day(-3),
        reference: `Protokoll II ${suffix}`,
      },
      headers: { cookie },
    });

    const message = captured.find(
      (candidate) => candidate.to === actors.chair.email,
    );
    const props = message?.props as {
      recipientName: string;
      kind: string;
      designation: string;
      triggeredOn: Date;
      dueOn: Date;
    };
    expect(props.kind).toBe("TERMINATION");
    expect(props.designation).toContain("1102");
    expect(props.dueOn.toISOString().slice(0, 10)).toBe(day(11));
    // The greeting names the board member the message is addressed to, which is
    // who it is to.
    expect(props.recipientName).toBe(`Bea ${surname}`);

    /*
     * And the content names nobody the register event is about: not the
     * acquirer, not the former holder, no address and no personal identity
     * number. A name in a mailbox is a name in every mail system the message
     * passes through, and this one goes to every seat on the board. Read as the
     * fields other than the greeting, because every person in this fixture
     * shares one surname and an assertion over the whole payload would only be
     * measuring the greeting.
     */
    const content = {
      kind: props.kind,
      designation: props.designation,
      triggeredOn: props.triggeredOn,
      dueOn: props.dueOn,
    };
    expect(JSON.stringify(content)).not.toContain(surname);
    expect(JSON.stringify(content)).not.toContain(
      actors.holder.personalIdentityNumber,
    );
  });

  it("does not roll back the register write when the mail server refuses", async () => {
    /*
     * Both writes have committed by the time a message is sent and neither can be
     * taken back: the obligation ledger refuses UPDATE and DELETE and a
     * termination is as strictly append-only. So a mail failure must not reject
     * the request - the deadline would still be running, with nobody told and the
     * board believing nothing was recorded.
     */
    const cookie = await signIn(actors.chair.email);
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new EnvelopeRefused(actors.chair.email));

    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.terminated,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: day(-4),
        reference: `Utmatning ${suffix}`,
      },
      headers: { cookie },
    });

    expect(send).toHaveBeenCalled();
    expect(response.statusCode).toBe(201);

    const termination = await prisma.termination.findFirst({
      where: { reference: `Utmatning ${suffix}` },
      select: { id: true, reportObligation: { select: { dueOn: true } } },
    });
    expect(termination).not.toBeNull();
    // And its deadline, which is the half that cannot be reconstructed.
    expect(
      termination?.reportObligation?.dueOn.toISOString().slice(0, 10),
    ).toBe(day(10));
  });

  it("writes to the rest of the board past a recipient the server refuses", async () => {
    /*
     * What the per-recipient catch is for, and it is a different property from
     * the one above. A rejection that escaped the loop would leave the seats
     * before the failure notified and the ones after it not, with nothing saying
     * which - and the call site would swallow it, so the whole thing would look
     * like a send that simply reached fewer people.
     */
    const cookie = await signIn(actors.chair.email);
    const reached: string[] = [];
    vi.spyOn(mail, "send").mockImplementation(async (input) => {
      if (input.to === actors.chair.email) {
        throw new EnvelopeRefused(input.to);
      }
      reached.push(input.to);
    });

    await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.transferred,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: day(-7),
        reference: `Protokoll III ${suffix}`,
      },
      headers: { cookie },
    });

    // The chair is first by id in this fixture, so the refusal happens before
    // the treasurer's send rather than after it.
    expect(reached).toContain(actors.treasurer.email);
    expect(reached).not.toContain(actors.chair.email);
  });

  it("keeps the register write when the recipients cannot be resolved at all", async () => {
    /*
     * The second layer, and the one the per-recipient catch does not reach.
     * Resolving the board is a database read before the loop starts, so a
     * failure there escapes the mailer; the call site wraps it for the same
     * reason it sends after the commit, and this is what says so.
     */
    const cookie = await signIn(actors.chair.email);
    const mailer = app.get(RegisterReportMailerService);
    const notice = vi
      .spyOn(mailer, "sendObligationNotice")
      .mockRejectedValue(new Error("the connection pool is exhausted"));

    const response = await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.transferred,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: day(-6),
        reference: `Forvar ${suffix}`,
      },
      headers: { cookie },
    });

    expect(notice).toHaveBeenCalled();
    expect(response.statusCode).toBe(201);
    const termination = await prisma.termination.findFirst({
      where: { reference: `Forvar ${suffix}` },
      select: { reportObligation: { select: { dueOn: true } } },
    });
    expect(
      termination?.reportObligation?.dueOn.toISOString().slice(0, 10),
    ).toBe(day(8));
  });

  it("names a failure by obligation and never by address", async () => {
    const cookie = await signIn(actors.chair.email);
    const logged = vi.spyOn(Logger.prototype, "error");
    vi.spyOn(mail, "send").mockRejectedValue(
      new EnvelopeRefused(actors.chair.email),
    );

    await inject({
      method: "POST",
      url: "/api/apartment-register/terminations",
      payload: {
        apartmentId: apartments.protected,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: day(-5),
        reference: `Kvarstad ${suffix}`,
      },
      headers: { cookie },
    });

    const lines = logged.mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes("obligation"));

    // The class of the failure, which says which layer gave way.
    expect(line).toContain("EnvelopeRefused");
    // And nothing the rejection was carrying. Container logs are read by more
    // people and kept longer than the data they would be repeating.
    for (const text of lines) {
      expect(text).not.toContain(actors.chair.email);
      expect(text).not.toContain(actors.treasurer.email);
    }
  });
});

describe("who may produce the initial supply", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/initial-supply",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/initial-supply",
      payload: {},
      headers: { cookie: await signIn(actors.resident.email) },
    });

    expect(response.statusCode).toBe(403);
    // And nothing was decrypted for the refused caller, so no entry was written
    // either: the gate is in front of the disclosure, not beside it.
    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "REGISTER_INITIAL_SUPPLY_EXPORTED",
          actorPersonId: actors.resident.personId,
        },
      }),
    ).toBe(0);
  });

  it("has no GET, so no browser can produce one by following a link", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/register-reports/initial-supply",
      headers: { cookie: await signIn(actors.chair.email) },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("the initial supply", () => {
  async function produce(): Promise<InitialSupply> {
    const response = await inject({
      method: "POST",
      url: "/api/register-reports/initial-supply",
      payload: {},
      headers: { cookie: await signIn(actors.chair.email) },
    });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body) as InitialSupply;
  }

  function rowsOf(supply: InitialSupply, recordType: string) {
    return supply.rows.filter((row) => row.recordType === recordType);
  }

  it("carries every current holder's personal identity number", async () => {
    const supply = await produce();
    const holder = rowsOf(supply, "HOLDER").find(
      (row) => row.apartmentKey?.endsWith("1102") === true,
    );

    expect(holder?.holderName).toBe(`Mira ${surname}`);
    expect(holder?.holderPersonalIdentityNumber).toBe(
      actors.holder.personalIdentityNumber,
    );
    expect(holder?.holderHeldFrom).toBe("2024-03-01");
    // The day the association decided on membership, which this suite recorded
    // above and which Forordning (2026:898) 2 kap. 5 § forsta stycket 7 asks for.
    expect(holder?.holderMembershipDecidedOn).toBe(day(0));
  });

  it("withholds a protected holder's address and says that it did", async () => {
    /*
     * A supply duty is not an exception to skyddade personuppgifter. The name and
     * the number identify the holder in a register keyed on exactly those; the
     * address is what the protection exists to withhold, and an empty cell with
     * nothing saying why reads as a register that lost one.
     */
    const supply = await produce();
    const holder = rowsOf(supply, "HOLDER").find(
      (row) => row.apartmentKey?.endsWith("1103") === true,
    );

    expect(holder?.holderProtectedPersonalData).toBe("yes");
    expect(holder?.holderPostalStreet).toBe("");
    expect(holder?.holderPostalCode).toBe("");
    expect(holder?.holderPostalCity).toBe("");
    expect(holder?.holderPersonalIdentityNumber).toBe(
      actors.protectedHolder.personalIdentityNumber,
    );
  });

  it("carries the pledges that still apply and leaves out a released one", async () => {
    // Pantsattningar are in the initial supply although they open no obligation:
    // the standing duty is the panthavare's (Lag (2026:484) 3 kap. 5 §) while
    // Lag (2026:485) 3 § puts the first supply of them on the association.
    const supply = await produce();
    const creditors = rowsOf(supply, "PLEDGE").map((row) => row.pledgeCreditor);

    expect(creditors).toContain(`Aspbanken ${suffix}`);
    expect(creditors).not.toContain(`Slutbanken ${suffix}`);
  });

  it("names the association once, with the register's own property designation", async () => {
    const supply = await produce();
    const association = rowsOf(supply, "ASSOCIATION");

    expect(association).toHaveLength(1);
    expect(association[0]?.associationPropertyDesignation).toBe(
      `Talgoxen ${suffix}`,
    );
  });

  it("produces a file whose rows all line up with its header", async () => {
    const supply = await produce();
    const lines = supply.csv.replace(/^﻿/, "").trimEnd().split("\r\n");

    // The byte order mark is what makes a spreadsheet read UTF-8 rather than the
    // local code page.
    expect(supply.csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(supply.columns.join(";"));
    for (const line of lines.slice(1)) {
      expect(line.split(";")).toHaveLength(supply.columns.length);
    }
    expect(supply.fileName).toBe(
      `bostadsrattsregister-uppgifter-${supply.generatedOn}.csv`,
    );
  });

  it("writes both entries, naming whose numbers it carried and how much", async () => {
    /*
     * What makes this an audited disclosure rather than a download. The export
     * entry says how much was disclosed and to whom the supply goes; the
     * PROTECTED_DATA_REVEALED entry beside it is what keeps "who has seen these
     * identity numbers" answerable from one action across the whole product.
     */
    const before = await prisma.auditLogEntry.count({
      where: { action: "REGISTER_INITIAL_SUPPLY_EXPORTED" },
    });
    const supply = await produce();

    const exported = await prisma.auditLogEntry.findFirst({
      where: {
        action: "REGISTER_INITIAL_SUPPLY_EXPORTED",
        actorPersonId: actors.chair.personId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "REGISTER_INITIAL_SUPPLY_EXPORTED" },
      }),
    ).toBe(before + 1);

    const context = exported?.context as {
      recipient: string;
      basis: string;
      columns: string[];
      records: Record<string, number>;
      personIds: string[];
      protectedPersonIds: string[];
    };
    expect(context.recipient).toBe("bostadsrattsregistret");
    expect(context.basis).toContain("2026:485");
    expect(context.columns).toEqual(supply.columns);
    expect(context.records.HOLDER).toBe(supply.counts.HOLDER);
    expect(context.personIds).toContain(actors.holder.personId);
    expect(context.protectedPersonIds).toContain(
      actors.protectedHolder.personId,
    );
    // Field names and counts, never a value.
    expect(JSON.stringify(context)).not.toContain(
      actors.holder.personalIdentityNumber,
    );

    const revealed = await prisma.auditLogEntry.findFirst({
      where: {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: actors.chair.personId,
        targetKind: "registerInitialSupply",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(revealed?.context).toMatchObject({
      fields: ["personalIdentityNumber"],
      via: "register-initial-supply",
    });
  });

  it("puts no personal identity number in a log line", async () => {
    const logged = vi.spyOn(Logger.prototype, "log");
    const errored = vi.spyOn(Logger.prototype, "error");
    const warned = vi.spyOn(Logger.prototype, "warn");

    await produce();

    const lines = [logged, errored, warned].flatMap((spy) =>
      spy.mock.calls.map((call) => String(call[0])),
    );
    // The act and the size of it are logged, so the export can be found.
    expect(lines.some((text) => text.includes("Initial supply"))).toBe(true);
    for (const text of lines) {
      expect(text).not.toContain(actors.holder.personalIdentityNumber);
      expect(text).not.toContain(actors.protectedHolder.personalIdentityNumber);
      expect(text).not.toContain(actors.chair.email);
    }
  });
});
