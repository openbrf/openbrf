import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { ISSUE_CONCERNED_PERSON_LIMIT, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { erasureRemainder } from "../retention/erasure-domains";
import { grantErasure } from "../testing/erasure-requests";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { issuesConcerningPerson } from "./issue-concerned-persons";
import { IssueErasureService } from "./issue-erasure.service";
import { IssuePurgeService } from "./issue-purge.service";
import { WORK_ORDER_BODY_RETENTION_DAYS } from "./issue-retention";
import { IssueTextPurgeService } from "./issue-text-purge.service";
import { IssueService } from "./issue.service";
import { showsProtectedHousehold } from "./work-order-link";

/**
 * The people an issue concerns (berörd person, ADR 0057), over HTTP and
 * against a real database: a handler records a resident from the picker's
 * residency, the list names them or says they are protected, and the record is
 * part of the issue's free-text layer. It goes with the text, by the clock and
 * by the reporter's granted erasure request, and a legal hold or a restriction
 * on the person it names keeps that layer, and the text of the issue's work
 * orders, as one on the reporter does. A
 * handler takes one off as a redaction, under the same refusals. An issue
 * concerning a protected person is left out of every read leaving the
 * instance, and ends a contractor's link to it.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let clock: IssueTextPurgeService;
let erasure: IssueErasureService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const DAY = 24 * 60 * 60 * 1000;

function handler(key: string, firstName: string) {
  return {
    personId: `cp-${key}-${suffix}`,
    email: `cp-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `Handlaggare${suffix}`,
  };
}

const board = handler("board", "Bea");
const manager = handler("manager", "Frida");
const handlers = [board, manager];

const addressId = `cp-address-${suffix}`;
const apartmentIds = {
  reporter: `cp-apartment-reporter-${suffix}`,
  neighbour: `cp-apartment-neighbour-${suffix}`,
};

/** Residents with a residency today, each in the neighbour's apartment. */
const residents = {
  neighbour: { personId: `cp-neighbour-${suffix}`, firstName: "Nils" },
  shielded: { personId: `cp-shielded-${suffix}`, firstName: "Sara" },
  held: { personId: `cp-held-${suffix}`, firstName: "Hugo" },
  restricted: { personId: `cp-restricted-${suffix}`, firstName: "Rakel" },
  reporter: { personId: `cp-reporter-${suffix}`, firstName: "Rut" },
};
/** Enough residents to fill an issue to its limit and one more. */
const crowd = Array.from(
  { length: ISSUE_CONCERNED_PERSON_LIMIT + 1 },
  (_, index) => ({
    personId: `cp-crowd-${String(index)}-${suffix}`,
    firstName: `Granne${String(index)}`,
  }),
);
const formerReporterId = `cp-former-${suffix}`;
const movedOutId = `cp-moved-out-${suffix}`;
/** People a hold or a restriction reaches only after a scan has run. */
const lateHeldId = `cp-late-held-${suffix}`;
const lateRestrictedId = `cp-late-restricted-${suffix}`;

const residencyOf: Record<string, string> = {};
const personIds = [
  ...handlers.map((entry) => entry.personId),
  ...Object.values(residents).map((entry) => entry.personId),
  ...crowd.map((entry) => entry.personId),
  formerReporterId,
  movedOutId,
  lateHeldId,
  lateRestrictedId,
];

const typeIds = {
  disturbance: `cp-type-disturbance-${suffix}`,
  boardOnly: `cp-type-board-${suffix}`,
};
let disturbance: IssueTypeFixture;
let boardOnly: IssueTypeFixture;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.214.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.214.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
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

const cookies: Record<string, string> = {};
const as = (entry: { personId: string }): string =>
  cookies[entry.personId] ?? "";

/**
 * An issue written directly, with a description, so its free-text layer
 * stands: reported by `reporterPersonId`, or by nobody, and closed
 * `closedDaysAgo` days ago, or open.
 */
async function seed(input: {
  type?: IssueTypeFixture;
  reporterPersonId?: string | null;
  closedDaysAgo?: number | null;
}): Promise<string> {
  const type = input.type ?? disturbance;
  const closedDaysAgo = input.closedDaysAgo ?? null;
  const issue = await prisma.issue.create({
    data: {
      typeId: type.id,
      statusId:
        closedDaysAgo === null ? type.statusIds.NEW : type.statusIds.DONE,
      outcome: closedDaysAgo === null ? null : "FIXED",
      reporterPersonId: input.reporterPersonId ?? null,
      apartmentId: apartmentIds.reporter,
      description: `Hög musik från grannen, ${suffix}`,
      closedAt:
        closedDaysAgo === null
          ? null
          : new Date(Date.now() - closedDaysAgo * DAY),
    },
    select: { id: true },
  });
  return issue.id;
}

function add(
  issueId: string,
  residentPersonId: string,
  cookie: string = as(board),
) {
  return inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/concerned-persons`,
    payload: { residencyId: residencyOf[residentPersonId] ?? "" },
    cookie,
  });
}

function list(issueId: string, cookie: string = as(board)) {
  return inject({
    method: "GET",
    url: `/api/issue-queue/${issueId}/concerned-persons`,
    cookie,
  });
}

function redact(issueId: string, payload: object) {
  return inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/redactions`,
    payload,
    cookie: as(board),
  });
}

/** Records a resident directly, for the tests about what keeps the record. */
async function concern(issueId: string, personId: string): Promise<string> {
  const row = await prisma.issueConcernedPerson.create({
    data: { issueId, personId },
    select: { id: true },
  });
  return row.id;
}

function recorded(issueId: string) {
  return prisma.issueConcernedPerson.count({ where: { issueId } });
}

let createdAssociation = false;

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
  clock = app.get(IssueTextPurgeService);
  erasure = app.get(IssueErasureService);

  createdAssociation =
    (await prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    })) === null;
  if (createdAssociation) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Grannvagen",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: {
      id: apartmentIds.reporter,
      addressId,
      number: "1101",
      floor: 1,
    },
  });
  await prisma.apartment.create({
    data: {
      id: apartmentIds.neighbour,
      addressId,
      number: "1201",
      floor: 2,
    },
  });

  for (const entry of handlers) {
    const email = await encryption.encrypt("person.email", entry.email);
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  for (const entry of [...Object.values(residents), ...crowd]) {
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: `Boende${suffix}`,
        protectedPersonalData: entry.personId === residents.shielded.personId,
        processingRestrictedAt:
          entry.personId === residents.restricted.personId ? new Date() : null,
      },
    });
    const residency = await prisma.residency.create({
      data: {
        personId: entry.personId,
        apartmentId:
          entry.personId === residents.reporter.personId
            ? apartmentIds.reporter
            : apartmentIds.neighbour,
        role: "RESIDENT",
        movedInOn: new Date("2020-01-01"),
      },
      select: { id: true },
    });
    residencyOf[entry.personId] = residency.id;
  }
  await prisma.legalHold.create({
    data: {
      personId: residents.held.personId,
      reason: "Tvist om störningar",
      placedByPersonId: board.personId,
    },
  });

  // A former resident, whose erasure a test grants, and one who moved out.
  for (const id of [formerReporterId, movedOutId]) {
    await prisma.person.create({
      data: { id, firstName: "Fia", lastName: `Flyttad${suffix}` },
    });
    const residency = await prisma.residency.create({
      data: {
        personId: id,
        apartmentId: apartmentIds.reporter,
        role: "RESIDENT",
        movedInOn: new Date("2019-01-01"),
        movedOutOn: new Date("2025-01-31"),
      },
      select: { id: true },
    });
    residencyOf[id] = residency.id;
  }

  disturbance = await createIssueTypeFixture(prisma, {
    id: typeIds.disturbance,
    name: `Störningar ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Styrelsens ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });
  for (const entry of handlers) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.issueType.deleteMany({
    where: { id: { in: Object.values(typeIds) } },
  });
  await prisma.dataSubjectRequest.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
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
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({
    where: { id: { in: Object.values(apartmentIds) } },
  });
  await prisma.address.deleteMany({ where: { id: addressId } });
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
  await app.close();
});

describe("recording whom an issue concerns", () => {
  it("names the resident, withholds a protected one, and records the act without the person", async () => {
    const issueId = await seed({
      reporterPersonId: residents.reporter.personId,
    });

    const first = await add(issueId, residents.neighbour.personId);
    expect(first.statusCode, first.body).toBe(201);
    const shielded = await add(issueId, residents.shielded.personId);
    expect(shielded.statusCode, shielded.body).toBe(201);

    const read = await list(issueId);
    expect(read.statusCode).toBe(200);
    const rows = read.json<{ kind: string; id: string; name?: string }[]>();
    expect(rows).toEqual([
      {
        kind: "person",
        id: expect.any(String),
        name: `Nils Boende${suffix}`,
      },
      { kind: "protected", id: expect.any(String) },
    ]);
    // No person identifier leaves the list, a protected one's least of all.
    expect(read.body).not.toContain(residents.shielded.personId);
    expect(read.body).not.toContain(residents.neighbour.personId);

    // The entry names the handler and the record, never the person: the log
    // outlives the record.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_CONCERNED_PERSON_ADDED",
      },
      orderBy: { createdAt: "asc" },
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });
    expect(entries).toEqual(
      rows.map((row) => ({
        actorPersonId: board.personId,
        targetPersonId: null,
        context: { id: row.id },
      })),
    );

    // The same resident again writes nothing.
    expect((await add(issueId, residents.neighbour.personId)).statusCode).toBe(
      201,
    );
    expect(await recorded(issueId)).toBe(2);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetId: issueId,
          action: "ISSUE_CONCERNED_PERSON_ADDED",
        },
      }),
    ).toBe(2);

    // The timeline says a person was recorded, and never whom.
    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: as(board),
    });
    expect(
      timeline
        .json<{ kind: string }[]>()
        .filter((step) => step.kind === "concernedPerson"),
    ).toHaveLength(2);
    expect(timeline.body).not.toContain("Nils");
  });

  it("refuses a residency not held today, one more than the limit, and an issue the handler does not handle", async () => {
    const issueId = await seed({});
    const movedOut = await add(issueId, movedOutId);
    expect(movedOut.statusCode).toBe(404);
    expect(movedOut.json<{ reason: string }>().reason).toBe(
      "resident-not-found",
    );

    for (const entry of crowd.slice(0, ISSUE_CONCERNED_PERSON_LIMIT)) {
      expect((await add(issueId, entry.personId)).statusCode).toBe(201);
    }
    const over = await add(
      issueId,
      crowd[ISSUE_CONCERNED_PERSON_LIMIT]?.personId ?? "",
    );
    expect(over.statusCode).toBe(409);
    expect(over.json<{ reason: string }>().reason).toBe(
      "too-many-concerned-persons",
    );
    expect(await recorded(issueId)).toBe(ISSUE_CONCERNED_PERSON_LIMIT);

    // The property manager is not let into a type the board handles alone,
    // and is told so as of an issue that does not exist.
    const boardsOwn = await seed({ type: boardOnly });
    const refused = await add(
      boardsOwn,
      residents.neighbour.personId,
      as(manager),
    );
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
    expect((await list(boardsOwn, as(manager))).statusCode).toBe(404);
    expect(await recorded(boardsOwn)).toBe(0);
  });
});

describe("taking a person off", () => {
  it("deletes the record as a redaction, and is refused while a hold stands on the issue or on a person it concerns", async () => {
    const issueId = await seed({});
    const neighbourRecord = await concern(
      issueId,
      residents.neighbour.personId,
    );

    await prisma.issue.update({
      where: { id: issueId },
      data: { legalHoldAt: new Date() },
    });
    const underHold = await redact(issueId, {
      target: "concernedPerson",
      id: neighbourRecord,
    });
    expect(underHold.statusCode).toBe(409);
    expect(underHold.json<{ reason: string }>().reason).toBe("legal-hold");
    await prisma.issue.update({
      where: { id: issueId },
      data: { legalHoldAt: null },
    });

    // A person it concerns under a legal hold keeps every part of the layer,
    // the description included, and their own record as well.
    const heldRecord = await concern(issueId, residents.held.personId);
    expect((await redact(issueId, { target: "description" })).statusCode).toBe(
      409,
    );
    expect(
      (await redact(issueId, { target: "concernedPerson", id: heldRecord }))
        .statusCode,
    ).toBe(409);
    await prisma.issueConcernedPerson.delete({ where: { id: heldRecord } });

    const removed = await redact(issueId, {
      target: "concernedPerson",
      id: neighbourRecord,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await recorded(issueId)).toBe(0);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { targetId: issueId, action: "ISSUE_REDACTED" },
      select: { context: true, targetPersonId: true },
    });
    expect(entry).toEqual({
      context: { target: "concernedPerson", id: neighbourRecord },
      targetPersonId: null,
    });

    const again = await redact(issueId, {
      target: "concernedPerson",
      id: neighbourRecord,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json<{ reason: string }>().reason).toBe(
      "redaction-target-not-found",
    );
  });
});

describe("the record on the clock", () => {
  it("goes with the free text, and is kept while a person it concerns is held or restricted", async () => {
    const now = new Date();
    const plain = await seed({ closedDaysAgo: 400 });
    await concern(plain, residents.neighbour.personId);
    const held = await seed({ closedDaysAgo: 400 });
    await concern(held, residents.held.personId);
    const restricted = await seed({ closedDaysAgo: 400 });
    await concern(restricted, residents.restricted.personId);

    const eligible = await clock.eligible(now, 1);
    expect(eligible).toContain(plain);
    expect(eligible).not.toContain(held);
    expect(eligible).not.toContain(restricted);

    expect(await clock.purgeIssue(plain, now, 1)).toBe("removed");
    expect(await recorded(plain)).toBe(0);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { targetId: plain, action: "SERVICE_DATA_PURGED" },
      select: { context: true },
    });
    expect(entry?.context).toMatchObject({
      layer: "freeText",
      concernedPersons: 1,
    });

    // Asked directly, past the scan, the removal still refuses both.
    expect(await clock.purgeIssue(held, now, 1)).toBe("kept");
    expect(await clock.purgeIssue(restricted, now, 1)).toBe("kept");
    expect(await recorded(held)).toBe(1);
    expect(await recorded(restricted)).toBe(1);
    const kept = await prisma.issue.findUniqueOrThrow({
      where: { id: held },
      select: { description: true },
    });
    expect(kept.description).not.toBe("");
  });

  it("alone keeps an issue standing, so a layer that is nothing else is still removed", async () => {
    const issueId = await prisma.issue.create({
      data: {
        typeId: disturbance.id,
        statusId: disturbance.statusIds.DONE,
        outcome: "FIXED",
        description: "",
        closedAt: new Date(Date.now() - 400 * DAY),
      },
      select: { id: true },
    });
    await concern(issueId.id, residents.neighbour.personId);
    expect(await clock.eligible(new Date(), 1)).toContain(issueId.id);
    expect(await clock.purgeIssue(issueId.id, new Date(), 1)).toBe("removed");
    expect(await recorded(issueId.id)).toBe(0);
  });
});

describe("the text of a work order", () => {
  const days = WORK_ORDER_BODY_RETENTION_DAYS;
  let purge: IssuePurgeService;

  beforeAll(async () => {
    purge = app.get(IssuePurgeService);
    for (const id of [lateHeldId, lateRestrictedId]) {
      await prisma.person.create({
        data: { id, firstName: "Sen", lastName: `Skyddad${suffix}` },
      });
    }
  });

  /** A closed issue past the text's window, concerning `personId`. */
  async function closedWithOrder(personId: string) {
    const issueId = await seed({ closedDaysAgo: days + 1 });
    await concern(issueId, personId);
    const order = await prisma.workOrder.create({
      data: {
        issueId,
        recipientName: `Rormokare ${suffix}`,
        recipientEmailCipher: "kept-as-it-was",
        body: "Tala med grannen i 1201 om musiken.",
        sentByPersonId: board.personId,
        deliveryStatus: "SENT",
      },
      select: { id: true },
    });
    return { issueId, orderId: order.id };
  }

  async function body(orderId: string) {
    const order = await prisma.workOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { body: true },
    });
    return order.body;
  }

  it("is erased on an issue concerning nobody withheld, and kept while a person it concerns is held or restricted", async () => {
    const now = new Date();
    const plain = await closedWithOrder(residents.neighbour.personId);
    const held = await closedWithOrder(residents.held.personId);
    const restricted = await closedWithOrder(residents.restricted.personId);

    const eligible = await purge.eligibleWorkOrderTexts(now, days);
    expect(eligible).toContain(plain.issueId);
    expect(eligible).not.toContain(held.issueId);
    expect(eligible).not.toContain(restricted.issueId);

    // Asked directly, past the scan, the erasure still refuses both.
    await expect(
      purge.purgeWorkOrderTexts(held.issueId, now, days),
    ).resolves.toBe(false);
    await expect(
      purge.purgeWorkOrderTexts(restricted.issueId, now, days),
    ).resolves.toBe(false);
    expect(await body(held.orderId)).not.toBeNull();
    expect(await body(restricted.orderId)).not.toBeNull();

    await expect(
      purge.purgeWorkOrderTexts(plain.issueId, now, days),
    ).resolves.toBe(true);
    expect(await body(plain.orderId)).toBeNull();
  });

  it("is kept by a hold or a restriction on a person it concerns placed after the scan", async () => {
    const now = new Date();
    const held = await closedWithOrder(lateHeldId);
    const restricted = await closedWithOrder(lateRestrictedId);
    const eligible = await purge.eligibleWorkOrderTexts(now, days);
    expect(eligible).toContain(held.issueId);
    expect(eligible).toContain(restricted.issueId);

    await prisma.legalHold.create({
      data: {
        personId: lateHeldId,
        reason: "Tvist om musiken",
        placedByPersonId: board.personId,
      },
    });
    await prisma.person.update({
      where: { id: lateRestrictedId },
      data: { processingRestrictedAt: new Date() },
    });

    // The transaction that erases reads them again.
    await expect(
      purge.purgeWorkOrderTexts(held.issueId, now, days),
    ).resolves.toBe(false);
    await expect(
      purge.purgeWorkOrderTexts(restricted.issueId, now, days),
    ).resolves.toBe(false);
    expect(await body(held.orderId)).not.toBeNull();
    expect(await body(restricted.orderId)).not.toBeNull();
  });
});

describe("the reporter's granted erasure", () => {
  it("removes the record with the layer, and keeps an issue concerning a held person, counted as kept", async () => {
    const plain = await seed({
      reporterPersonId: formerReporterId,
      closedDaysAgo: 30,
    });
    await concern(plain, residents.neighbour.personId);
    const held = await seed({
      reporterPersonId: formerReporterId,
      closedDaysAgo: 30,
    });
    await concern(held, residents.held.personId);
    await grantErasure(prisma, formerReporterId, board.personId);

    expect(
      await erasureRemainder(prisma, formerReporterId, new Date(), encryption),
    ).toEqual([
      expect.objectContaining({ domain: "issues", owed: 1, kept: 1 }),
    ]);

    await erasure.run();
    expect(await recorded(plain)).toBe(0);
    expect(await recorded(held)).toBe(1);
    const kept = await prisma.issue.findUniqueOrThrow({
      where: { id: held },
      select: { description: true, freeTextRemovedAt: true },
    });
    expect(kept.description).not.toBe("");
    expect(kept.freeTextRemovedAt).toBeNull();
  });
});

describe("the ring-fence of a protected person", () => {
  it("leaves an issue concerning them out of a read leaving the instance, and ends a contractor's link", async () => {
    const issueId = await seed({});
    await concern(issueId, residents.shielded.personId);
    const issues = app.get(IssueService);

    await expect(
      issues.queuedIssue(board.personId, issueId, "omit"),
    ).rejects.toMatchObject({
      reason: "issue-not-found",
    });
    // The board's own screen shows it.
    expect((await issues.queuedIssue(board.personId, issueId, "show")).id).toBe(
      issueId,
    );

    expect(
      await showsProtectedHousehold(prisma, issueId, localDayOf(new Date())),
    ).toBe(true);
    const other = await seed({});
    await concern(other, residents.neighbour.personId);
    expect(
      await showsProtectedHousehold(prisma, other, localDayOf(new Date())),
    ).toBe(false);
  });
});

describe("the cases about a person", () => {
  it("finds the issues that concern them and that they did not report", async () => {
    const aboutThem = await seed({
      reporterPersonId: residents.reporter.personId,
    });
    await concern(aboutThem, residents.neighbour.personId);
    const fromForm = await seed({});
    await concern(fromForm, residents.neighbour.personId);
    const theirOwn = await seed({
      reporterPersonId: residents.neighbour.personId,
    });
    await concern(theirOwn, residents.neighbour.personId);
    const unrelated = await seed({
      reporterPersonId: residents.reporter.personId,
    });

    const found = await prisma.issue.findMany({
      where: {
        typeId: disturbance.id,
        ...issuesConcerningPerson(residents.neighbour.personId),
      },
      select: { id: true },
    });
    const ids = found.map((issue) => issue.id);
    expect(ids).toContain(aboutThem);
    expect(ids).toContain(fromForm);
    expect(ids).not.toContain(theirOwn);
    expect(ids).not.toContain(unrelated);
  });
});
