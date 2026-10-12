import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthService } from "../auth/auth.service";
import type { PrismaService } from "../database/prisma.service";
import {
  type ApplicationOnOwnDatabase,
  applicationOnOwnDatabase,
} from "../testing/application-on-own-database";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import type { BoardPositionView } from "./role-changes";

/**
 * A board recovery, over HTTP and against a register that really is vacant.
 *
 * Vacant is a fact about the whole register - no seat held today and none
 * recorded ahead - so this suite cannot run on a worker's shared database,
 * where the suites before it have seated boards of their own. It gets a
 * database of its own, cloned from the migrated template, and the register on
 * it holds exactly the seats written below.
 *
 * The cases run in order and each leaves the register as the next one needs
 * it: vacant with every term ended and its holder able to sign in, then
 * recovered, then with no seat held today and the next board recorded ahead.
 */

loadEnvForIntegrationTests();

let instance: ApplicationOnOwnDatabase;
let app: NestFastifyApplication;
let prisma: PrismaService;

const PASSWORD = "a-long-enough-password";

const admin = { personId: "recovery-admin", email: "admin@exempel.se" };
/** Chaired the board whose every term has ended. Can still sign in. */
const formerChair = {
  personId: "recovery-former-chair",
  email: "former-chair@exempel.se",
};
/** Elected chair at the meeting the recovery records. */
const chair = { personId: "recovery-chair", email: "chair@exempel.se" };
/** Elected with them, and has no account yet. */
const member = { personId: "recovery-member" };
/** Elected with them, and recorded by the chair once the board can act. */
const deputy = { personId: "recovery-deputy" };

const REASON =
  "The whole board stood down at the extra meeting before anybody recorded " +
  "the new one.";

/** Read once, so every date in the suite counts from the same day. */
const SUITE_TODAY = new Date();

function daysFromToday(days: number): string {
  return new Date(
    Date.UTC(
      SUITE_TODAY.getUTCFullYear(),
      SUITE_TODAY.getUTCMonth(),
      SUITE_TODAY.getUTCDate() + days,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

const dateColumn = (days: number) =>
  new Date(`${daysFromToday(days)}T00:00:00Z`);

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.70.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.70.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      payload: options.payload,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
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
  expect(response.statusCode, `signing in ${email}`).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

function recover(cookie: string, payload: object) {
  return inject({
    method: "POST",
    url: "/api/board-positions/recovery",
    payload,
    cookie,
  });
}

/** The board the meeting elected, as the recovery records it. */
const electedBoard = [
  {
    personId: chair.personId,
    position: "CHAIR",
    electedOn: daysFromToday(-7),
  },
  {
    personId: member.personId,
    position: "BOARD_MEMBER",
    electedOn: daysFromToday(-7),
  },
];

async function vacant(cookie: string): Promise<boolean> {
  const response = await inject({
    method: "GET",
    url: "/api/board-positions/recovery",
    cookie,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { vacant: boolean }).vacant;
}

let adminCookie: string;

beforeAll(async () => {
  instance = await applicationOnOwnDatabase("board_recovery");
  app = instance.app;
  prisma = instance.prisma;

  await prisma.person.createMany({
    data: [
      { id: admin.personId, firstName: "Alva", lastName: "Återställd" },
      { id: formerChair.personId, firstName: "Frej", lastName: "Återställd" },
      { id: chair.personId, firstName: "Cilla", lastName: "Återställd" },
      { id: member.personId, firstName: "Måns", lastName: "Återställd" },
      { id: deputy.personId, firstName: "Doris", lastName: "Återställd" },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });
  // The board before: every term ended a month ago.
  await prisma.boardPosition.create({
    data: {
      personId: formerChair.personId,
      position: "CHAIR",
      electedOn: dateColumn(-800),
      endedOn: dateColumn(-30),
    },
  });

  const auth = app.get(AuthService);
  for (const person of [admin, formerChair, chair]) {
    await auth.createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  adminCookie = await signIn(admin.email);
}, 180_000);

afterAll(async () => {
  await instance?.close();
});

describe("a register on which every term has ended", () => {
  it("is vacant, although the last board's chair can still sign in", async () => {
    await expect(vacant(adminCookie)).resolves.toBe(true);
  });

  it("still takes no ordinary election from an administrator with no seat", async () => {
    // The window this replaces: an election by somebody with no seat is
    // refused whatever the register holds, so the only way in is the recovery.
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${chair.personId}`,
      payload: { position: "CHAIR", electedOn: daysFromToday(-7) },
      cookie: adminCookie,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "board-seat-required" });
  });

  it("refuses a recovery without a reason, and writes nothing", async () => {
    for (const payload of [
      { seats: electedBoard },
      { seats: electedBoard, reason: "" },
      { seats: electedBoard, reason: "   " },
    ]) {
      const response = await recover(adminCookie, payload);
      expect(response.statusCode).toBe(400);
    }

    await expect(
      prisma.boardPosition.count({ where: { endedOn: null } }),
    ).resolves.toBe(0);
  });

  it("refuses a recovery that seats the person recording it", async () => {
    const response = await recover(adminCookie, {
      seats: [
        ...electedBoard,
        {
          personId: admin.personId,
          position: "DEPUTY_BOARD_MEMBER",
          electedOn: daysFromToday(-7),
        },
      ],
      reason: REASON,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "board-seat-required" });
    await expect(
      prisma.boardPosition.count({ where: { endedOn: null } }),
    ).resolves.toBe(0);
  });

  it("refuses a recovery dated after today, and writes no seat and no audit entry", async () => {
    // Two days and not one: the register counts days on the association's
    // calendar, which is ahead of UTC, and tomorrow by UTC can be today there.
    const response = await recover(adminCookie, {
      seats: [
        ...electedBoard,
        {
          personId: deputy.personId,
          position: "DEPUTY_BOARD_MEMBER",
          electedOn: daysFromToday(2),
        },
      ],
      reason: REASON,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "recovery-dated-ahead" });
    await expect(prisma.boardPosition.count()).resolves.toBe(1);
    const recoveryTargetPersonIds = [
      ...electedBoard.map(({ personId }) => personId),
      deputy.personId,
    ];
    await expect(
      prisma.auditLogEntry.count({
        where: {
          action: "BOARD_RECOVERY_RECORDED",
          actorPersonId: admin.personId,
          targetPersonId: { in: recoveryTargetPersonIds },
        },
      }),
    ).resolves.toBe(0);
    await expect(vacant(adminCookie)).resolves.toBe(true);
  });

  it("records the board the meeting elected, with its own audit entries", async () => {
    const response = await recover(adminCookie, {
      seats: electedBoard,
      reason: REASON,
    });

    expect(response.statusCode, response.body).toBe(201);
    const seats = response.json() as BoardPositionView[];
    expect(
      seats.map(({ personId, position, endedOn }) => ({
        personId,
        position,
        endedOn,
      })),
    ).toEqual([
      { personId: chair.personId, position: "CHAIR", endedOn: null },
      { personId: member.personId, position: "BOARD_MEMBER", endedOn: null },
    ]);

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "BOARD_RECOVERY_RECORDED" },
      orderBy: { createdAt: "asc" },
    });
    expect(
      entries.map((entry) => ({
        actorPersonId: entry.actorPersonId,
        targetPersonId: entry.targetPersonId,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        context: entry.context,
      })),
    ).toEqual(
      seats.map((seat) => ({
        actorPersonId: admin.personId,
        targetPersonId: seat.personId,
        targetKind: "boardPosition",
        targetId: seat.boardPositionId,
        context: expect.objectContaining({
          position: seat.position,
          electedOn: daysFromToday(-7),
          seats: 2,
          reason: REASON,
        }) as unknown,
      })),
    );
    // Its own action, not an election by another name.
    await expect(
      prisma.auditLogEntry.count({
        where: { action: "BOARD_POSITION_ELECTED" },
      }),
    ).resolves.toBe(0);
  });
});

describe("a register with a seat held today", () => {
  it("is not vacant, and refuses a second recovery", async () => {
    await expect(vacant(adminCookie)).resolves.toBe(false);

    const response = await recover(adminCookie, {
      seats: [
        {
          personId: deputy.personId,
          position: "DEPUTY_BOARD_MEMBER",
          electedOn: daysFromToday(-7),
        },
      ],
      reason: REASON,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "board-not-vacant" });
    await expect(
      prisma.boardPosition.count({ where: { personId: deputy.personId } }),
    ).resolves.toBe(0);
  });

  it("is the board's to keep: the recovered chair records the rest", async () => {
    const chairCookie = await signIn(chair.email);

    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${deputy.personId}`,
      payload: {
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: daysFromToday(-7),
      },
      cookie: chairCookie,
    });

    expect(response.statusCode, response.body).toBe(201);
    await expect(
      prisma.auditLogEntry.count({
        where: {
          action: "BOARD_POSITION_ELECTED",
          actorPersonId: chair.personId,
          targetPersonId: deputy.personId,
        },
      }),
    ).resolves.toBe(1);
  });
});

describe("a register with no seat held today and the next board recorded ahead", () => {
  it("is not vacant, and refuses a recovery", async () => {
    // Every seat ends today, and the incoming board begins next month: the
    // days between are the board's, not a way in.
    await prisma.boardPosition.updateMany({
      where: { endedOn: null },
      data: { endedOn: dateColumn(0) },
    });
    await prisma.boardPosition.create({
      data: {
        personId: formerChair.personId,
        position: "CHAIR",
        electedOn: dateColumn(30),
      },
    });

    await expect(vacant(adminCookie)).resolves.toBe(false);

    const response = await recover(adminCookie, {
      seats: [
        {
          personId: deputy.personId,
          position: "CHAIR",
          electedOn: daysFromToday(0),
        },
      ],
      reason: REASON,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "board-not-vacant" });
    await expect(
      prisma.boardPosition.count({
        where: { personId: deputy.personId, position: "CHAIR" },
      }),
    ).resolves.toBe(0);
  });
});
