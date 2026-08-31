import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { BoardPositionView, SystemRoleGrantsView } from "./role-changes";

/**
 * Conferring and revoking a role, over HTTP and against a real database.
 *
 * The unit tests pin the rules. What only this suite can show is the half that
 * is about the register rather than about arithmetic: that the capability gate
 * really does leave a board member unable to write a system role, that ending a
 * term leaves the row where it was with a date on it, that each act commits its
 * audit entry with the change it records, and that the instance refuses to let
 * go of its last administrator - including when it is the administrator
 * themselves letting go.
 *
 * It also shows that a conferred role reaches the principal: the person who was
 * granted PROPERTY_MANAGER can open the issue queue afterwards, without an
 * account being touched, because roles are derived per request from the
 * register.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `roles-address-${suffix}`;
const apartmentId = `roles-apartment-${suffix}`;

const admin = {
  personId: `roles-admin-${suffix}`,
  email: `roles-admin-${suffix}@exempel.se`,
};
/** A second administrator, so the first one is not the last one. */
const spareAdmin = {
  personId: `roles-spare-${suffix}`,
  email: `roles-spare-${suffix}@exempel.se`,
};
const board = {
  personId: `roles-board-${suffix}`,
  email: `roles-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `roles-resident-${suffix}`,
  email: `roles-resident-${suffix}@exempel.se`,
};
/** The external contractor the property manager grant is conferred on. */
const contractor = {
  personId: `roles-contractor-${suffix}`,
  email: `roles-contractor-${suffix}@exempel.se`,
};
/** Somebody with no role at all, who the board elects to the board. */
const electee = { personId: `roles-electee-${suffix}` };
/** Their own person, so a seat a date is corrected on starts uncontested. */
const amender = { personId: `roles-amender-${suffix}` };

const actors = [admin, spareAdmin, board, resident, contractor];
const personIds = [
  ...actors.map((actor) => actor.personId),
  electee.personId,
  amender.personId,
];

/**
 * A calendar date a number of days either side of today.
 *
 * How far ahead a term may be recorded as running is counted from today, so a
 * suite that spelled these dates out as fixed years would start refusing what
 * it asserts is allowed once enough of them had passed.
 */
function daysFromToday(days: number): string {
  const today = new Date();
  return new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + days,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.26.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.26.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PATCH";
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

/** Records an election, and insists it was recorded. */
async function elect(
  cookie: string,
  personId: string,
  position: BoardPositionView["position"],
  electedOn: string,
): Promise<BoardPositionView> {
  const response = await inject({
    method: "POST",
    url: `/api/board-positions/persons/${personId}`,
    payload: { position, electedOn },
    headers: { cookie },
  });
  expect(
    response.statusCode,
    `electing ${personId} as ${position} answered ${String(
      response.statusCode,
    )}: ${response.body}`,
  ).toBe(201);
  return response.json() as BoardPositionView;
}

function setSystemRole(
  cookie: string,
  personId: string,
  role: "ADMIN" | "PROPERTY_MANAGER",
  granted: boolean,
) {
  return inject({
    method: "PATCH",
    url: `/api/system-roles/persons/${personId}`,
    payload: { role, granted },
    headers: { cookie },
  });
}

let adminCookie: string;
let boardCookie: string;
let residentCookie: string;
let contractorCookie: string;

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
      street: `Rollgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  await prisma.person.createMany({
    data: [
      { id: admin.personId, firstName: "Alva", lastName: `Roll${suffix}` },
      { id: spareAdmin.personId, firstName: "Sten", lastName: `Roll${suffix}` },
      { id: board.personId, firstName: "Bo", lastName: `Roll${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Roll${suffix}` },
      {
        id: contractor.personId,
        firstName: "Kaj",
        lastName: `Roll${suffix}`,
      },
      { id: electee.personId, firstName: "Elsa", lastName: `Roll${suffix}` },
      { id: amender.personId, firstName: "Ines", lastName: `Roll${suffix}` },
    ],
  });

  /*
   * Two administrators from the start, so the tests that revoke one are not
   * fighting the lockout guard, and the guard's own test can create the
   * one-administrator state deliberately rather than inheriting it. The
   * database this suite runs on is its own, but nothing in it is empty by
   * assumption: every query below is filtered to this run's own people.
   */
  await prisma.systemRole.createMany({
    data: [
      { personId: admin.personId, role: "ADMIN" },
      { personId: spareAdmin.personId, role: "ADMIN" },
    ],
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of actors) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  adminCookie = await signIn(admin.email);
  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
  contractorCookie = await signIn(contractor.email);
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
      "The roles suite could not clean up after itself.",
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
          prisma.systemRole.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
      ]);
      // Audit entries stay: the table is append-only, and the record of who was
      // given what is not test litter.
    }
  } finally {
    await app?.close();
  }
});

describe("who may confer what", () => {
  it("refuses an election from a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${electee.personId}`,
      payload: { position: "BOARD_MEMBER", electedOn: "2026-04-14" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident, who sits on nothing", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${electee.personId}`,
      payload: { position: "BOARD_MEMBER", electedOn: "2026-04-14" },
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a board member the system role endpoint entirely", async () => {
    /*
     * The decision this feature turns on. A board seat must not be a way to
     * grant oneself administrator rights, and it is not, because there is no
     * route on which a board member can write a system_role row - not a branch
     * inside one that inspects which role was asked for.
     *
     * Asserted for both roles: the refusal is the controller's capability gate,
     * so it does not depend on what the body said.
     */
    for (const role of ["ADMIN", "PROPERTY_MANAGER"] as const) {
      const response = await setSystemRole(
        boardCookie,
        board.personId,
        role,
        true,
      );
      expect(response.statusCode).toBe(403);
    }

    await expect(
      prisma.systemRole.count({ where: { personId: board.personId } }),
    ).resolves.toBe(0);
  });

  it("refuses a board member reading the system roles as well", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/system-roles/persons/${admin.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets the board record its own election", async () => {
    // The board is elected by the general meeting, so the minute of that
    // election is the board's to write down rather than an administrator's to
    // approve.
    const seat = await elect(
      boardCookie,
      electee.personId,
      "DEPUTY_BOARD_MEMBER",
      "2026-04-14",
    );

    expect(seat.position).toBe("DEPUTY_BOARD_MEMBER");
    expect(seat.electedOn).toBe("2026-04-14");
    expect(seat.endedOn).toBeNull();
  });
});

describe("recording an election", () => {
  it("records the act naming the seat and its date", async () => {
    const seat = await elect(
      adminCookie,
      electee.personId,
      "CHAIR",
      "2026-04-14",
    );

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "BOARD_POSITION_ELECTED",
        targetPersonId: electee.personId,
        targetId: seat.boardPositionId,
      },
    });
    expect(entry.actorPersonId).toBe(admin.personId);
    expect(entry.targetKind).toBe("boardPosition");
    expect(entry.context).toMatchObject({
      position: "CHAIR",
      electedOn: "2026-04-14",
    });
  });

  it("refuses a second election to a position already held", async () => {
    // Re-election is two acts: end the term, then record the new election. One
    // row cannot carry two elections, and merging them would silently drop
    // whichever date the register kept.
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${electee.personId}`,
      payload: { position: "CHAIR", electedOn: "2027-04-14" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "position-already-held" });
  });

  it("allows a second, different position at the same time", async () => {
    // The register's own answer: a deputy co-opted as a board member holds
    // both, and the roster prints them both.
    const seat = await elect(
      adminCookie,
      board.personId,
      "CHAIR",
      "2026-04-14",
    );

    expect(seat.position).toBe("CHAIR");
    await expect(
      prisma.boardPosition.count({
        where: { personId: board.personId, endedOn: null },
      }),
    ).resolves.toBe(2);
  });

  it("answers 404 for somebody the register does not hold", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/nobody-${suffix}`,
      payload: { position: "BOARD_MEMBER", electedOn: "2026-04-14" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: "person-not-found" });
  });

  it("refuses a date that is not a calendar date", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/persons/${electee.personId}`,
      payload: { position: "BOARD_MEMBER", electedOn: "the spring meeting" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ reason: "invalid-body" });
  });
});

describe("ending a term", () => {
  it("writes the end date and keeps the row", async () => {
    const seat = await elect(
      adminCookie,
      electee.personId,
      "BOARD_MEMBER",
      "2024-04-14",
    );

    const response = await inject({
      method: "POST",
      url: `/api/board-positions/${seat.boardPositionId}/end`,
      payload: { endedOn: "2026-04-14" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      boardPositionId: seat.boardPositionId,
      electedOn: "2024-04-14",
      endedOn: "2026-04-14",
    });

    /*
     * The row itself, read back off the table. A board seat is the record of
     * who answered for the association between two dates, and an interface
     * that "removed" somebody from the board by deleting it would destroy the
     * answer to every later question about a decision taken while they sat.
     */
    const stored = await prisma.boardPosition.findUniqueOrThrow({
      where: { id: seat.boardPositionId },
    });
    expect(stored.endedOn).not.toBeNull();
    expect(stored.electedOn.toISOString()).toBe("2024-04-14T00:00:00.000Z");

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "BOARD_POSITION_ENDED",
        targetId: seat.boardPositionId,
      },
    });
    expect(entry.context).toMatchObject({
      position: "BOARD_MEMBER",
      electedOn: "2024-04-14",
      endedOn: "2026-04-14",
    });
  });

  it("refuses ending a term twice", async () => {
    const seat = await elect(
      adminCookie,
      electee.personId,
      "BOARD_MEMBER",
      "2022-04-14",
    );
    const end = () =>
      inject({
        method: "POST",
        url: `/api/board-positions/${seat.boardPositionId}/end`,
        payload: { endedOn: "2023-04-14" },
        headers: { cookie: adminCookie },
      });

    expect((await end()).statusCode).toBe(200);
    const second = await end();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "term-already-ended" });
  });

  it("refuses a term ending before the election that began it", async () => {
    const seat = await elect(
      adminCookie,
      electee.personId,
      "BOARD_MEMBER",
      "2026-04-14",
    );

    const response = await inject({
      method: "POST",
      url: `/api/board-positions/${seat.boardPositionId}/end`,
      payload: { endedOn: "2025-04-14" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "ended-before-elected" });
  });

  it("answers 404 for a seat the register does not hold", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/board-positions/nothing-${suffix}/end`,
      payload: { endedOn: "2026-04-14" },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      reason: "board-position-not-found",
    });
  });

  it("refuses a year typed with the wrong century, and leaves the seat open", async () => {
    /*
     * The typo this bound exists for. A seat goes on conferring what a board
     * member holds until its end date arrives - the protected data reveal, the
     * member register, the apartment register - so 2206 for 2026 is not a
     * wrong date on a screen but a century and a half of access.
     */
    const seat = await elect(
      adminCookie,
      amender.personId,
      "BOARD_MEMBER",
      daysFromToday(-30),
    );

    const response = await inject({
      method: "POST",
      url: `/api/board-positions/${seat.boardPositionId}/end`,
      payload: { endedOn: daysFromToday(365 * 20) },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "ended-too-far-ahead" });

    const stored = await prisma.boardPosition.findUniqueOrThrow({
      where: { id: seat.boardPositionId },
    });
    expect(stored.endedOn).toBeNull();
  });

  it("writes a new date over an end date that has not arrived", async () => {
    /*
     * The correction path, and the reason the bound above is not enough on its
     * own: a plausible wrong date - next spring's meeting instead of this
     * one's - is inside every horizon, and a board that could not correct it
     * from the application would be back to editing the database, which is the
     * thing this feature exists to end.
     */
    const seat = await elect(
      adminCookie,
      amender.personId,
      "CHAIR",
      daysFromToday(-30),
    );
    const end = (endedOn: string) =>
      inject({
        method: "POST",
        url: `/api/board-positions/${seat.boardPositionId}/end`,
        payload: { endedOn },
        headers: { cookie: adminCookie },
      });

    expect((await end(daysFromToday(400))).statusCode).toBe(200);
    const corrected = await end(daysFromToday(35));

    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ endedOn: daysFromToday(35) });

    const stored = await prisma.boardPosition.findUniqueOrThrow({
      where: { id: seat.boardPositionId },
    });
    expect(stored.endedOn?.toISOString()).toBe(
      `${daysFromToday(35)}T00:00:00.000Z`,
    );

    /*
     * Both writes are on file, and the second says what it replaced. One
     * action covers them because the act is the same one - saying when this
     * term ends - and what a reader needs is the date the seat carried before,
     * which is the fact rather than a second name for the act.
     */
    const contexts = (
      await prisma.auditLogEntry.findMany({
        where: {
          action: "BOARD_POSITION_ENDED",
          targetId: seat.boardPositionId,
        },
      })
    ).map((entry) => entry.context);

    expect(contexts).toHaveLength(2);
    expect(contexts).toContainEqual(
      expect.objectContaining({
        endedOn: daysFromToday(400),
        previousEndedOn: null,
      }),
    );
    expect(contexts).toContainEqual(
      expect.objectContaining({
        endedOn: daysFromToday(35),
        previousEndedOn: daysFromToday(400),
      }),
    );
  });

  it("refuses to move an end date that has already passed", async () => {
    // Settled rather than amendable. The seat stopped conferring on that day,
    // and the period it covered is the answer to who answered for the
    // association while it ran.
    const seat = await elect(
      adminCookie,
      amender.personId,
      "DEPUTY_BOARD_MEMBER",
      daysFromToday(-60),
    );
    const end = (endedOn: string) =>
      inject({
        method: "POST",
        url: `/api/board-positions/${seat.boardPositionId}/end`,
        payload: { endedOn },
        headers: { cookie: adminCookie },
      });

    expect((await end(daysFromToday(-10))).statusCode).toBe(200);
    const second = await end(daysFromToday(30));

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "term-already-ended" });
    const stored = await prisma.boardPosition.findUniqueOrThrow({
      where: { id: seat.boardPositionId },
    });
    expect(stored.endedOn?.toISOString()).toBe(
      `${daysFromToday(-10)}T00:00:00.000Z`,
    );
  });
});

describe("the property manager grant", () => {
  it("is granted by an administrator and reaches the issue queue", async () => {
    // Before: the contractor has an account and no role, so the queue is not
    // theirs to open. That is what makes the "after" meaningful.
    const before = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: contractorCookie },
    });
    expect(before.statusCode).toBe(403);

    const granted = await setSystemRole(
      adminCookie,
      contractor.personId,
      "PROPERTY_MANAGER",
      true,
    );
    expect(granted.statusCode).toBe(200);
    expect((granted.json() as SystemRoleGrantsView).roles).toEqual([
      "PROPERTY_MANAGER",
    ]);

    /*
     * The same session, with no account touched and nothing re-issued. Roles
     * are derived from the register on every request, so the grant is in force
     * on the next one.
     */
    const after = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: contractorCookie },
    });
    expect(after.statusCode).toBe(200);
  });

  it("still leaves the address book closed to them", async () => {
    // The published promise: an external property manager reaches the issue
    // queue and never the register. Conferring the grant from a screen must not
    // be the thing that widens it.
    const response = await inject({
      method: "GET",
      url: "/api/address-book",
      headers: { cookie: contractorCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("is revoked, and the queue closes again", async () => {
    const revoked = await setSystemRole(
      adminCookie,
      contractor.personId,
      "PROPERTY_MANAGER",
      false,
    );
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as SystemRoleGrantsView).roles).toEqual([]);

    const after = await inject({
      method: "GET",
      url: "/api/issue-queue",
      headers: { cookie: contractorCookie },
    });
    expect(after.statusCode).toBe(403);
  });

  it("writes one entry per act and none for a change that changes nothing", async () => {
    const entriesFor = async (
      action: "SYSTEM_ROLE_GRANTED" | "SYSTEM_ROLE_REVOKED",
    ) =>
      prisma.auditLogEntry.count({
        where: { action, targetPersonId: contractor.personId },
      });

    expect(await entriesFor("SYSTEM_ROLE_GRANTED")).toBe(1);
    expect(await entriesFor("SYSTEM_ROLE_REVOKED")).toBe(1);

    // Revoking again: already gone, so nothing happened and nothing is
    // recorded. Padding the log with entries corresponding to no act would
    // make the entries that do harder to find.
    const again = await setSystemRole(
      adminCookie,
      contractor.personId,
      "PROPERTY_MANAGER",
      false,
    );
    expect(again.statusCode).toBe(200);
    expect(await entriesFor("SYSTEM_ROLE_REVOKED")).toBe(1);
  });
});

describe("the administrator grant", () => {
  it("is granted to a second person, who can then grant roles themselves", async () => {
    const response = await setSystemRole(
      adminCookie,
      board.personId,
      "ADMIN",
      true,
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as SystemRoleGrantsView).roles).toEqual(["ADMIN"]);

    // The same session as the board member who was refused this endpoint
    // above. Nothing was re-issued; the register answers differently now.
    const nowAllowed = await setSystemRole(
      boardCookie,
      contractor.personId,
      "PROPERTY_MANAGER",
      true,
    );
    expect(nowAllowed.statusCode).toBe(200);

    // Put back, so the tests below count the administrators this suite meant.
    await setSystemRole(
      boardCookie,
      contractor.personId,
      "PROPERTY_MANAGER",
      false,
    );
    await setSystemRole(adminCookie, board.personId, "ADMIN", false);
  });

  it("refuses to remove the last administrator", async () => {
    /*
     * The lockout guard, against a real count. The instance is reduced to one
     * administrator - this run's own two, minus one - and the survivor is then
     * asked to be removed.
     *
     * The guard counts every administrator on the instance, because that is
     * what the rule means; a count filtered to this run's people would be a
     * different rule passing a test. Reaching the one-administrator state
     * therefore depends on nobody else's administrator standing on this
     * database, which holds because a worker runs one suite at a time and each
     * suite removes its own rows when it finishes. The check below is here so
     * that a suite which crashed before its teardown says so, rather than this
     * one failing on the revoke with nothing to point at.
     */
    const foreign = await prisma.systemRole.findMany({
      where: { role: "ADMIN", personId: { notIn: personIds } },
      select: { personId: true },
    });
    expect(
      foreign.map((holder) => holder.personId),
      "an administrator this suite did not create stands on this database, so " +
        "the last-administrator state cannot be reached without removing " +
        "somebody else's row. An earlier suite on this worker did not clean up.",
    ).toEqual([]);

    const mine = await prisma.systemRole.findMany({
      where: { role: "ADMIN", personId: { in: personIds } },
      select: { personId: true },
    });
    expect(
      mine.map((holder) => holder.personId).sort(),
      "this suite's own administrators are not the two it created, so a test " +
        "above left one behind",
    ).toEqual([admin.personId, spareAdmin.personId].sort());

    const removedSpare = await setSystemRole(
      adminCookie,
      spareAdmin.personId,
      "ADMIN",
      false,
    );
    expect(removedSpare.statusCode).toBe(200);

    const response = await setSystemRole(
      adminCookie,
      admin.personId,
      "ADMIN",
      false,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "last-administrator" });
    // And the grant is still there: a refusal that left the row half-removed
    // would be the lockout it was meant to prevent.
    await expect(
      prisma.systemRole.count({
        where: { personId: admin.personId, role: "ADMIN" },
      }),
    ).resolves.toBe(1);
  });

  it("refuses an administrator revoking their own last grant", async () => {
    // The same refusal as above, and the case that actually happens: somebody
    // tidying up their own account rather than removing a colleague. Asserted
    // separately because the rule must not depend on the actor and the target
    // being different people - here they are the same person, acting on
    // themselves, and the door still does not close.
    const response = await setSystemRole(
      adminCookie,
      admin.personId,
      "ADMIN",
      false,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "last-administrator" });

    // Still signed in and still an administrator on the next request.
    const stillAdmin = await inject({
      method: "GET",
      url: `/api/system-roles/persons/${admin.personId}`,
      headers: { cookie: adminCookie },
    });
    expect(stillAdmin.statusCode).toBe(200);
    expect((stillAdmin.json() as SystemRoleGrantsView).roles).toEqual([
      "ADMIN",
    ]);
  });

  it("lets go once somebody else holds the grant", async () => {
    // The way out of the refusal, and the sentence the screen says: grant it to
    // somebody else first.
    const granted = await setSystemRole(
      adminCookie,
      spareAdmin.personId,
      "ADMIN",
      true,
    );
    expect(granted.statusCode).toBe(200);

    const response = await setSystemRole(
      adminCookie,
      admin.personId,
      "ADMIN",
      false,
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as SystemRoleGrantsView).roles).toEqual([]);

    // And the door has closed behind them: the endpoint is an administrator's.
    const afterwards = await setSystemRole(
      adminCookie,
      admin.personId,
      "ADMIN",
      true,
    );
    expect(afterwards.statusCode).toBe(403);
  });
});

describe("the board's person view", () => {
  it("carries each seat's own id, so a screen can end one term and not a position", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${electee.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const person = response.json() as {
      boardPositions: {
        boardPositionId: string;
        position: string;
        endedOn: string | null;
      }[];
    };

    // This person has held BOARD_MEMBER more than once by now, ended and open.
    // The position is not a name for either row, which is why the id travels.
    const ids = person.boardPositions.map((seat) => seat.boardPositionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
});
