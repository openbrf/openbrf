import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { MoveService } from "../moves/move.service";
import { LegalHoldService } from "../retention/legal-hold.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { DataSubjectRequestView } from "./data-subject-request";

/**
 * What a person asked about their own data, over HTTP and against a real
 * database.
 *
 * Two things here need a database rather than a fake. The refusals a grant can
 * meet are read off the person's real residencies, board seats, system roles
 * and holds, and each of them is a different table - a fake would be asserting
 * that the service asks the questions the fake was built to answer. And the
 * flags a grant writes are what the mailers, the directory and the purges read,
 * so the row is checked rather than the return value.
 *
 * That a granted erasure is actually carried out is `purge.int-spec.ts`, which
 * has the driven clock.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `dsr-address-${suffix}`;
const apartmentId = `dsr-apartment-${suffix}`;
const secondApartmentId = `dsr-apartment-2-${suffix}`;
const issueTypeId = `dsr-type-${suffix}`;
const issueId = `dsr-issue-${suffix}`;

const board = {
  personId: `dsr-board-${suffix}`,
  email: `dsr-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `dsr-resident-${suffix}`,
  email: `dsr-resident-${suffix}@exempel.se`,
};

/** People the requests are recorded about, one per situation. */
const subjects = {
  /** Moved out and nothing keeping them: the ordinary grant. */
  gone: `dsr-gone-${suffix}`,
  /** Still lives here. */
  living: `dsr-living-${suffix}`,
  /** Under a legal hold. */
  held: `dsr-held-${suffix}`,
  /** Still sits on the board. */
  seated: `dsr-seated-${suffix}`,
  /** Still administers the instance. */
  admin: `dsr-admin-${suffix}`,
  /** Asked for a restriction earlier. */
  restricted: `dsr-restricted-${suffix}`,
  /** Never held a residency at all. */
  external: `dsr-external-${suffix}`,
  /** Objects to the association's mailings. */
  objector: `dsr-objector-${suffix}`,
  /** Asks for a restriction, then lifts it. */
  restricter: `dsr-restricter-${suffix}`,
  /** Granted erasure, then moves back in. */
  returning: `dsr-returning-${suffix}`,
} as const;

const personIds = [
  board.personId,
  resident.personId,
  ...Object.values(subjects),
];

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.42.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.42.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
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

let boardCookie: string;
let residentCookie: string;

/** Records a request as the board, and answers the whole response. */
function record(
  personId: string,
  payload: Record<string, unknown>,
  cookie = () => boardCookie,
) {
  return inject({
    method: "POST",
    url: `/api/data-subject-requests/persons/${personId}`,
    payload: {
      requestedOn: "2026-09-01",
      ground: "Jag ber om det.",
      ...payload,
    },
    headers: { cookie: cookie() },
  });
}

/** Records a request that is expected to succeed, and answers its view. */
async function recorded(
  personId: string,
  payload: Record<string, unknown>,
): Promise<DataSubjectRequestView> {
  const response = await record(personId, payload);
  expect(response.statusCode).toBe(201);
  return response.json<DataSubjectRequestView>();
}

function decide(requestId: string, payload: Record<string, unknown>) {
  return inject({
    method: "POST",
    url: `/api/data-subject-requests/${requestId}/decision`,
    payload: { ground: "Styrelsens bedomning.", ...payload },
    headers: { cookie: boardCookie },
  });
}

function close(requestId: string, payload: Record<string, unknown> = {}) {
  return inject({
    method: "POST",
    url: `/api/data-subject-requests/${requestId}/close`,
    payload,
    headers: { cookie: boardCookie },
  });
}

function reasonOf(response: { json: () => unknown }): string | undefined {
  return (response.json() as { reason?: string }).reason;
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

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Radgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          { id: apartmentId, number: "1001", floor: 0 },
          { id: secondApartmentId, number: "1002", floor: 0 },
        ],
      },
    },
  });

  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Person",
      lastName: `Begaran${suffix}`,
    })),
  });

  await prisma.boardPosition.createMany({
    data: [board.personId, subjects.seated].map((personId) => ({
      personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
    })),
  });
  await prisma.systemRole.create({
    data: { personId: subjects.admin, role: "ADMIN" },
  });

  // Everybody but the external one has a residency; the ones who may be erased
  // moved out long enough ago that nothing but the request is in question.
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT" as const,
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: subjects.living,
        apartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2020-01-01"),
      },
      ...(
        [
          subjects.gone,
          subjects.held,
          subjects.seated,
          subjects.admin,
          subjects.restricted,
          subjects.objector,
          subjects.restricter,
          subjects.returning,
        ] as const
      ).map((personId) => ({
        personId,
        apartmentId: secondApartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2015-01-01"),
        movedOutOn: new Date("2020-01-31"),
      })),
    ],
  });

  await app.get(LegalHoldService).place({
    personId: subjects.held,
    reason: "Tvist om andrahandsuthyrning",
    actorPersonId: board.personId,
  });

  await prisma.person.update({
    where: { id: subjects.restricted },
    data: { processingRestrictedAt: new Date("2026-02-01T00:00:00.000Z") },
  });

  await prisma.issueType.create({
    data: { id: issueTypeId, name: `Trapphus ${suffix}`, audience: "MEMBER" },
  });
  await prisma.issue.create({
    data: {
      id: issueId,
      typeId: issueTypeId,
      description: "Grannen i 1202 stallde cyklar i trapphuset",
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [board, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

async function cleanUp(
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    await step().catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The data subject request suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () =>
          prisma.session.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.account.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
        () =>
          prisma.dataSubjectRequest.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.issue.deleteMany({ where: { id: issueId } }),
        () => prisma.issueType.deleteMany({ where: { id: issueTypeId } }),
        () =>
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.systemRole.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () =>
          prisma.apartment.deleteMany({
            where: { id: { in: [apartmentId, secondApartmentId] } },
          }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("who may record a request", () => {
  it("refuses without a session", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-requests/persons/${subjects.gone}`,
      payload: { kind: "OBJECTION", requestedOn: "2026-09-01", ground: "Nej." },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, who may not write the register", async () => {
    const response = await record(
      subjects.gone,
      { kind: "OBJECTION" },
      () => residentCookie,
    );

    expect(response.statusCode).toBe(403);
  });
});

describe("the ground a request rests on", () => {
  it("requires the art. 17(1) ground on an erasure", async () => {
    const response = await record(subjects.gone, { kind: "ERASURE" });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("erasure-ground-required");
  });

  it("refuses one on an objection, which rests on art. 21 instead", async () => {
    const response = await record(subjects.gone, {
      kind: "OBJECTION",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("ground-not-applicable");
  });

  it("records the ground the person invoked", async () => {
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "CONSENT_WITHDRAWN",
    });

    expect(view.erasureGround).toBe("CONSENT_WITHDRAWN");
    // Derived and not stored: one calendar month from the request (art. 12(3)).
    expect(view.dueOn).toBe("2026-10-01");
    expect(view.state).toBe("open");

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });
});

describe("a request about a name in an issue's description", () => {
  it("takes the issue it is about", async () => {
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
      issueId,
    });

    expect(view.issueId).toBe(issueId);

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  it("refuses an issue on an objection", async () => {
    const response = await record(subjects.gone, {
      kind: "OBJECTION",
      issueId,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("issue-kind-inconsistent");
  });

  it("refuses an issue that is not there", async () => {
    const response = await record(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
      issueId: `${issueId}-missing`,
    });

    expect(response.statusCode).toBe(404);
    expect(reasonOf(response)).toBe("issue-not-found");
  });
});

describe("deciding an erasure", () => {
  it("requires the art. 17(3) assessment", async () => {
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    const response = await decide(view.requestId, { decision: "GRANTED" });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("erasure-exception-required");

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  it("refuses a grant that also names an exception", async () => {
    // An art. 17(3) exception is what disapplies the right. A grant naming one
    // would be the record of a decision that contradicts itself.
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    const response = await decide(view.requestId, {
      decision: "GRANTED",
      erasureException: "LEGAL_OBLIGATION_TO_KEEP",
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("exception-inconsistent");

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  it("records a refusal with the exception and the board's reasons", async () => {
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    const response = await decide(view.requestId, {
      decision: "REFUSED",
      erasureException: "LEGAL_OBLIGATION_TO_KEEP",
      ground: "Medlemsforteckningen far inte gallras.",
    });

    expect(response.statusCode).toBe(200);
    const decided = response.json<DataSubjectRequestView>();
    expect(decided.erasureException).toBe("LEGAL_OBLIGATION_TO_KEEP");
    // art. 12(4): a refusal carries its reasons, on the row where they can be
    // read and corrected rather than in the append-only log.
    expect(decided.decisionGround).toBe(
      "Medlemsforteckningen far inte gallras.",
    );
    expect(decided.state).toBe("refused");

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  it("grants an erasure for somebody with nothing keeping them", async () => {
    const view = await recorded(subjects.gone, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    const response = await decide(view.requestId, {
      decision: "GRANTED",
      erasureException: "NONE",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<DataSubjectRequestView>().state).toBe("granted");

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  it("grants an erasure for somebody who never held a residency", async () => {
    // The scheduled purge leaves them alone for ever - no move-out to anchor a
    // date on - but their contact details are service data like anybody's.
    const view = await recorded(subjects.external, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });

    const response = await decide(view.requestId, {
      decision: "GRANTED",
      erasureException: "NONE",
    });

    expect(response.statusCode).toBe(200);

    await prisma.dataSubjectRequest.deleteMany({
      where: { id: view.requestId },
    });
  });

  describe("the grants the platform declines to record", () => {
    it.each([
      ["somebody who still lives here", "living", "currently-resident"],
      ["somebody under a legal hold", "held", "on-legal-hold"],
      ["somebody still on the board", "seated", "board-position-current"],
      ["an administrator", "admin", "system-role-current"],
      [
        "somebody who asked for a restriction",
        "restricted",
        "processing-restricted",
      ],
    ])("refuses a grant for %s", async (_label, key, reason) => {
      /*
       * Not the board being overruled. The purge would decline to touch each of
       * these people, so recording a grant would leave a person told their data
       * was erased and a row saying so, with the data still there. The board's
       * own refusal is a REFUSED decision with its ground.
       */
      const personId = subjects[key as keyof typeof subjects];
      const view = await recorded(personId, {
        kind: "ERASURE",
        erasureGround: "NO_LONGER_NECESSARY",
      });

      const response = await decide(view.requestId, {
        decision: "GRANTED",
        erasureException: "NONE",
      });

      expect(response.statusCode).toBe(409);
      expect(reasonOf(response)).toBe(reason);

      await prisma.dataSubjectRequest.deleteMany({
        where: { id: view.requestId },
      });
    });
  });
});

describe("an objection and a restriction", () => {
  it("writes the dated flag the mailers read, and clears it on close", async () => {
    const view = await recorded(subjects.objector, { kind: "OBJECTION" });

    await decide(view.requestId, { decision: "GRANTED" });
    await expect(
      prisma.person.findUniqueOrThrow({
        where: { id: subjects.objector },
        select: { communicationObjectionAt: true },
      }),
    ).resolves.not.toMatchObject({ communicationObjectionAt: null });

    const closed = await close(view.requestId, { reason: "Aterkallad" });
    expect(closed.statusCode).toBe(200);
    await expect(
      prisma.person.findUniqueOrThrow({
        where: { id: subjects.objector },
        select: { communicationObjectionAt: true },
      }),
    ).resolves.toMatchObject({ communicationObjectionAt: null });
  });

  it("does the same for a restriction, which also suspends the purge", async () => {
    const view = await recorded(subjects.restricter, { kind: "RESTRICTION" });

    await decide(view.requestId, { decision: "GRANTED" });
    await expect(
      prisma.person.findUniqueOrThrow({
        where: { id: subjects.restricter },
        select: { processingRestrictedAt: true },
      }),
    ).resolves.not.toMatchObject({ processingRestrictedAt: null });

    await close(view.requestId, { reason: "Uppphavd" });
    await expect(
      prisma.person.findUniqueOrThrow({
        where: { id: subjects.restricter },
        select: { processingRestrictedAt: true },
      }),
    ).resolves.toMatchObject({ processingRestrictedAt: null });
  });

  it("refuses a second open request of the same kind", async () => {
    const view = await recorded(subjects.objector, { kind: "OBJECTION" });

    const response = await record(subjects.objector, { kind: "OBJECTION" });
    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe("already-open");

    await close(view.requestId);
  });

  it("refuses a second close", async () => {
    const view = await recorded(subjects.objector, { kind: "OBJECTION" });
    await close(view.requestId);

    const response = await close(view.requestId);
    expect(response.statusCode).toBe(409);
    expect(reasonOf(response)).toBe("already-closed");
  });
});

describe("a person who moves back in", () => {
  it("has their granted erasure closed by the move-in", async () => {
    /*
     * Without this the request stands granted and unexecuted for ever: the
     * purge refuses anybody with a current residency, so it would never be
     * carried out and never closed, and the person's page would keep promising
     * an erasure that was not coming.
     */
    const view = await recorded(subjects.returning, {
      kind: "ERASURE",
      erasureGround: "NO_LONGER_NECESSARY",
    });
    await decide(view.requestId, {
      decision: "GRANTED",
      erasureException: "NONE",
    });

    await app.get(MoveService).moveIn({
      actorPersonId: board.personId,
      personId: subjects.returning,
      apartmentId,
      role: "RESIDENT",
      movedInOn: "2026-09-01",
    });

    const row = await prisma.dataSubjectRequest.findUniqueOrThrow({
      where: { id: view.requestId },
      select: { closedAt: true, closeReason: true, executedAt: true },
    });
    expect(row.closedAt).not.toBeNull();
    expect(row.closeReason).toBe("moved-in");
    // Closed, not carried out: nothing was erased, and the record says so.
    expect(row.executedAt).toBeNull();
  });

  it("writes a closing entry that says it was not executed", async () => {
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "DATA_SUBJECT_REQUEST_CLOSED",
        targetPersonId: subjects.returning,
      },
      orderBy: [{ createdAt: "desc" }],
    });

    expect(entry?.context).toMatchObject({
      kind: "ERASURE",
      executed: false,
      closeReason: "moved-in",
    });
  });
});
