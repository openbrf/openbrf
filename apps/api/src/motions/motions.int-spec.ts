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
import type { MotionStatus } from "../generated/prisma/enums";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import { MotionPurgeService } from "./motion-purge.service";
import type { MotionIntakeView, MotionQueueView } from "./motion.service";

/**
 * Motions to the general meeting against a real database.
 *
 * Six properties, none of which a unit test can show.
 *
 * The right belongs to a member. EFL 6 kap. 15 §, applied to a housing
 * cooperative by BRL 9 kap. 14 §, gives it to "en medlem", so a resident who
 * holds no tenant-ownership is refused - and so is an administrator, who holds
 * every capability in the model and no membership. That second refusal is the one
 * the capability model alone cannot make, and it is asserted here because the
 * whole statutory claim rests on it.
 *
 * The audiences are split at the controller. A member cannot read the queue and
 * the property manager cannot reach the module at all.
 *
 * A motion closes with a date and a status and is never deleted, closes exactly
 * once whichever way, and a member cannot take back an item the board has already
 * received.
 *
 * The personnummer scan refuses a motion that carries one, names where it is, and
 * does not echo it.
 *
 * The bylaws' deadline is read from the association and stated on both halves,
 * and no deadline means intake stays open rather than closed.
 *
 * And the purge, which is what makes the retention promise real: it erases
 * motions past their window, leaves an open one alone however old, and a legal
 * hold stops it for the person it stands against - including one placed while the
 * run is in flight, which is the one property here that needs two transactions
 * interleaved rather than one sequence of calls.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: MotionPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `mo-address-${suffix}`;
const apartmentId = `mo-apartment-${suffix}`;

const member = {
  personId: `mo-member-${suffix}`,
  email: `mo-member-${suffix}@exempel.se`,
};
const lodger = {
  personId: `mo-lodger-${suffix}`,
  email: `mo-lodger-${suffix}@exempel.se`,
};
const board = {
  personId: `mo-board-${suffix}`,
  email: `mo-board-${suffix}@exempel.se`,
};
const administrator = {
  personId: `mo-admin-${suffix}`,
  email: `mo-admin-${suffix}@exempel.se`,
};
const manager = {
  personId: `mo-manager-${suffix}`,
  email: `mo-manager-${suffix}@exempel.se`,
};
const actors = [member, lodger, board, administrator, manager];
const personIds = actors.map((actor) => actor.personId);

/** Every motion this run created, so afterAll can clear the table it shares. */
const createdMotionIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The clock the purge is driven at, and the window it is driven with.
 *
 * Now rather than a date in the future, deliberately, for the reason
 * `bookings.int-spec.ts` gives: the purge is a query over the whole table and
 * this database is shared between suites, so a run driven from a date years ahead
 * would reach any motion another suite had left standing. Anchored here, the
 * cutoff is thirty days back and every motion this suite does not own is far too
 * recent to be in scope.
 */
const NOW = new Date();
const RETENTION_DAYS = 30;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
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
        // 10.31.0.0/16 is this suite's; the others each hold their own second
        // octet. 10.30.0.0/16 is left to the event chain being built in parallel.
        "x-forwarded-for": `10.31.${String(subnet)}.${String(host + 1)}`,
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

/** Submits a motion as the given account, and remembers it for the cleanup. */
async function submitMotion(
  cookie: string,
  payload: { title: string; body: string },
) {
  const response = await inject({
    method: "POST",
    url: "/api/motions",
    payload,
    headers: { cookie },
  });
  if (response.statusCode === 201) {
    createdMotionIds.push(response.json<{ id: string }>().id);
  }
  return response;
}

/** The member's own half of the module. */
async function intake(cookie: string): Promise<MotionIntakeView> {
  const response = await inject({
    method: "GET",
    url: "/api/motions/mine",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<MotionIntakeView>();
}

/** The board's half. */
async function queue(cookie: string): Promise<MotionQueueView> {
  const response = await inject({
    method: "GET",
    url: "/api/motion-queue",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<MotionQueueView>();
}

/**
 * How many transactions hold, or are queued behind, this person's hold key.
 *
 * `hashtext` gives a signed int4 and the advisory lock space addresses it as two
 * halves of a bigint, which is what the shifting reassembles.
 */
async function holdLockCount(
  personId: string,
  granted: boolean,
): Promise<bigint> {
  const key = `legal-hold:${personId}`;
  const [row] = await prisma.$queryRaw<{ locks: bigint }[]>`
    SELECT count(*) AS locks
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND granted = ${granted}
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return row?.locks ?? 0n;
}

/** Polls until the condition holds, or gives up so a failure is a failure. */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the purge to block or finish.");
}

/** Writes a motion straight to the database, with a closing date of its own. */
async function seedMotion(input: {
  id: string;
  personId: string;
  closedAt: Date | null;
  status: MotionStatus;
}): Promise<void> {
  await prisma.motion.create({
    data: {
      id: input.id,
      title: `Motion ${input.id}`,
      body: "Foreningen bor se over cykelrummet.",
      submittedByPersonId: input.personId,
      status: input.status,
      closedAt: input.closedAt,
      closedByPersonId: input.closedAt === null ? null : input.personId,
    },
  });
  createdMotionIds.push(input.id);
}

let memberCookie = "";
let lodgerCookie = "";
let boardCookie = "";
let adminCookie = "";
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
  purge = app.get(MotionPurgeService);
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
      street: "Motionsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1201", floor: 2 },
  });

  for (const person of [
    { ...member, firstName: "Maja", lastName: "Medlem" },
    { ...lodger, firstName: "Lars", lastName: "Inneboende" },
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...administrator, firstName: "Adam", lastName: "Administrator" },
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
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  /*
   * The member holds the tenant-ownership; the lodger lives in the same
   * apartment without one.
   *
   * That is the statutory distinction this suite exists to assert: EFL 6 kap.
   * 15 § gives the right to a member, so two people at the same address get
   * different answers from the same endpoint.
   */
  await prisma.residency.create({
    data: {
      personId: member.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2025-01-01"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: lodger.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2025-01-01"),
    },
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15"),
    },
  });
  /*
   * The administrator holds no residency, which is the point of the account.
   *
   * They hold every capability the model defines, `motions:submit` among them,
   * and the statute still does not give them the right - so this account is what
   * proves the check in the service is doing something the capability model
   * cannot.
   */
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  memberCookie = await signIn(member.email);
  lodgerCookie = await signIn(lodger.email);
  boardCookie = await signIn(board.email);
  adminCookie = await signIn(administrator.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

/*
 * Cleanup in a try, and the close in a finally.
 *
 * Every statement below is reachable with the setup half-done: a beforeAll that
 * fails partway leaves rows this suite has to remove and rows it never wrote,
 * and one throw here would take the rest of the cleanup with it and never reach
 * app.close(). The Nest application, its Prisma pool and its Fastify server
 * would then stay open for the rest of the worker, and the suites that follow in
 * it would fail for a reason that has nothing to do with them - while the
 * failure that caused it is reported as a teardown error rather than as the
 * setup fault it is.
 */
afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await prisma.motion.deleteMany({
        where: {
          OR: [
            { id: { in: createdMotionIds } },
            // Anything a test created and did not get to record, e.g. because an
            // assertion failed before its own cleanup line.
            { submittedByPersonId: { in: personIds } },
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
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });

      // The deadline this suite may have written, back to no clause at all.
      // updateMany, because the row is absent whenever the setup failed before
      // it reached the association: update would throw P2025 and the throw
      // would be this teardown's, not the setup's.
      await prisma.association.updateMany({
        where: { id: 1 },
        data: { motionDeadlineMonth: null, motionDeadlineDay: null },
      });

      // Audit entries stay: the table is append-only by trigger, and every
      // assertion below selects on this run's target ids rather than on a count.
      if (associationCreatedHere) {
        await prisma.association.deleteMany({ where: { id: 1 } });
      }
    }
  } finally {
    // Unassigned when the module never built, which is a setup failure the
    // runner reports on its own.
    if (app !== undefined) {
      await app.close();
    }
  }
});

describe("who may put an item to the general meeting", () => {
  it("takes a motion from a member", async () => {
    const response = await submitMotion(memberCookie, {
      title: `Laddstolpar i garaget ${suffix}`,
      body: "Foreningen bor utreda vad laddstolpar skulle kosta.",
    });

    expect(response.statusCode).toBe(201);

    const own = await intake(memberCookie);
    const mine = own.motions.find(
      (motion) => motion.title === `Laddstolpar i garaget ${suffix}`,
    );
    expect(mine?.status).toBe("SUBMITTED");
    expect(mine?.closedAt).toBeNull();
  });

  it("refuses a resident who is not a member", async () => {
    /*
     * The statute, at the capability layer. EFL 6 kap. 15 § gives the right to a
     * member, so somebody living in the same apartment without a
     * tenant-ownership - a partner, an adult child, a lodger - is refused by the
     * guard before the service is reached.
     */
    const response = await submitMotion(lodgerCookie, {
      title: `Fran en inneboende ${suffix}`,
      body: "Detta ska inte tas emot.",
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses an administrator, who holds the capability and not the membership", async () => {
    /*
     * The load-bearing assertion of this file.
     *
     * An administrator holds every capability the model defines, `motions:submit`
     * among them, so the guard lets them through - and the statute still gives
     * them nothing, because a grant on an instance is not a share in the
     * association. The refusal comes from the service asking the register, which
     * is the only place that question can be asked. Delete that check and this
     * test is the only thing that notices.
     */
    const response = await submitMotion(adminCookie, {
      title: `Fran administratoren ${suffix}`,
      body: "Detta ska inte tas emot.",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason: string }>().reason).toBe("not-a-member");
  });

  it("refuses a board member who holds no tenant-ownership", async () => {
    // The right attaches to the membership and not to the office. This board
    // member was elected and lives elsewhere, so they work the queue and have no
    // item of their own to put.
    const response = await submitMotion(boardCookie, {
      title: `Fran styrelsen ${suffix}`,
      body: "Detta ska inte tas emot.",
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses the property manager the module entirely", async () => {
    // A motion is the members' business with their own association, and decision
    // 11 keeps an external contractor out of everything but the issue queue.
    const submitted = await submitMotion(managerCookie, {
      title: `Fran forvaltaren ${suffix}`,
      body: "Detta ska inte tas emot.",
    });
    expect(submitted.statusCode).toBe(403);

    const read = await inject({
      method: "GET",
      url: "/api/motion-queue",
      headers: { cookie: managerCookie },
    });
    expect(read.statusCode).toBe(403);
  });

  it("stops taking motions from a member whose residency has ended", async () => {
    /*
     * Membership is asked of the register at the moment of submission, not
     * cached on the account, so a household that has sold up stops holding the
     * right on the day the residency ends rather than when somebody remembers to
     * change something.
     *
     * The residency is closed and reopened around one request. The capability is
     * derived per request too, so the guard refuses first - which is the same
     * answer for the member and a stronger one than the service could give.
     */
    await prisma.residency.updateMany({
      where: { personId: member.personId, role: "MEMBER" },
      data: { movedOutOn: new Date("2025-06-01") },
    });
    try {
      const response = await submitMotion(memberCookie, {
        title: `Efter utflytt ${suffix}`,
        body: "Detta ska inte tas emot.",
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await prisma.residency.updateMany({
        where: { personId: member.personId, role: "MEMBER" },
        data: { movedOutOn: null },
      });
    }
  });
});

describe("the personal identity number scan", () => {
  it("refuses a motion carrying one, and names where without echoing it", async () => {
    /*
     * A motion is circulated - into the notice, read out in the room, into the
     * minutes - so a personnummer in one is a disclosure the association cannot
     * take back. The refusal says which field and how far in, and the response
     * body must not carry the number itself: a refusal that echoed it would put
     * it into whatever logs that body.
     */
    const number = runIdentityNumber(`motion-scan-${suffix}`);
    const response = await submitMotion(memberCookie, {
      title: `Om en granne ${suffix}`,
      body: `Det galler ${number} i trapphuset.`,
    });

    expect(response.statusCode).toBe(422);
    const failure = response.json<{
      reason: string;
      locations: { part: string; offset: number }[];
    }>();
    expect(failure.reason).toBe("personal-identity-number");
    expect(failure.locations).toEqual([
      { part: "body", offset: "Det galler ".length },
    ]);
    expect(response.body).not.toContain(number);
  });

  it("scans the title as well as the body", async () => {
    const number = runIdentityNumber(`motion-title-${suffix}`);
    const response = await submitMotion(memberCookie, {
      title: `Motion om ${number}`,
      body: "Ingenting kansligt i brodtexten.",
    });

    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ locations: { part: string }[] }>().locations[0]?.part,
    ).toBe("title");
    expect(response.body).not.toContain(number);
  });
});

describe("the board's queue", () => {
  it("is not readable by the member who submitted into it", async () => {
    // Who has put what to the meeting is what motions:handle gates. A member
    // reads their own intake and nobody else's.
    const response = await inject({
      method: "GET",
      url: "/api/motion-queue",
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("names the member who submitted each motion", async () => {
    const title = `Cykelstall ${suffix}`;
    expect(
      (await submitMotion(memberCookie, { title, body: "Fler platser." }))
        .statusCode,
    ).toBe(201);

    const board = await queue(boardCookie);
    const entry = board.motions.find((motion) => motion.title === title);

    expect(entry?.submitter).toEqual({
      kind: "member",
      personId: member.personId,
      name: "Maja Medlem",
    });
  });

  it("withholds the name of a member with protected personal data", async () => {
    /*
     * The board's own address book prints that name because a statutory register
     * has a reason to; a queue does not, and the same judgement governs the issue
     * queue. A board member who has to reach them goes through the register.
     */
    const title = `Skyddad motion ${suffix}`;
    await prisma.person.update({
      where: { id: member.personId },
      data: { protectedPersonalData: true },
    });
    try {
      expect(
        (await submitMotion(memberCookie, { title, body: "Nagot." }))
          .statusCode,
      ).toBe(201);

      const board = await queue(boardCookie);
      const entry = board.motions.find((motion) => motion.title === title);

      expect(entry?.submitter).toEqual({
        kind: "protected",
        personId: member.personId,
      });
      expect(JSON.stringify(entry)).not.toContain("Medlem");
    } finally {
      await prisma.person.update({
        where: { id: member.personId },
        data: { protectedPersonalData: false },
      });
    }
  });
});

describe("closing a motion", () => {
  it("acknowledges it with a date and a status, and never deletes it", async () => {
    const title = `Att bekrafta ${suffix}`;
    const created = await submitMotion(memberCookie, {
      title,
      body: "Foreningen bor mala trapphuset.",
    });
    const { id } = created.json<{ id: string }>();

    const acknowledged = await inject({
      method: "POST",
      url: `/api/motion-queue/${id}/acknowledgement`,
      headers: { cookie: boardCookie },
    });

    expect(acknowledged.statusCode).toBe(201);
    const view = acknowledged.json<{
      status: string;
      closedAt: string | null;
      closedByPersonId: string | null;
    }>();
    expect(view.status).toBe("ACKNOWLEDGED");
    expect(view.closedAt).not.toBeNull();
    expect(view.closedByPersonId).toBe(board.personId);

    // The row is still there, which is what lets the member point at having
    // submitted it.
    const row = await prisma.motion.findUnique({ where: { id } });
    expect(row?.status).toBe("ACKNOWLEDGED");
    expect(row?.title).toBe(title);
  });

  it("refuses a second acknowledgement", async () => {
    const created = await submitMotion(memberCookie, {
      title: `Tva klick ${suffix}`,
      body: "Nagot.",
    });
    const { id } = created.json<{ id: string }>();

    const first = await inject({
      method: "POST",
      url: `/api/motion-queue/${id}/acknowledgement`,
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);

    const second = await inject({
      method: "POST",
      url: `/api/motion-queue/${id}/acknowledgement`,
      headers: { cookie: boardCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ reason: string }>().reason).toBe("already-closed");
  });

  it("lets a member withdraw their own open motion", async () => {
    const created = await submitMotion(memberCookie, {
      title: `Att aterkalla ${suffix}`,
      body: "Nagot jag angrar.",
    });
    const { id } = created.json<{ id: string }>();

    const withdrawn = await inject({
      method: "POST",
      url: `/api/motions/${id}/withdrawal`,
      headers: { cookie: memberCookie },
    });

    expect(withdrawn.statusCode).toBe(201);
    expect(withdrawn.json<{ status: string }>().status).toBe("WITHDRAWN");
    expect((await prisma.motion.findUnique({ where: { id } }))?.status).toBe(
      "WITHDRAWN",
    );
  });

  it("refuses withdrawing a motion the board has already received", async () => {
    // Once the item has been taken up it may already be in a notice that has
    // gone out, so taking it back is a matter for the board and the meeting.
    const created = await submitMotion(memberCookie, {
      title: `Redan mottagen ${suffix}`,
      body: "Nagot.",
    });
    const { id } = created.json<{ id: string }>();
    await inject({
      method: "POST",
      url: `/api/motion-queue/${id}/acknowledgement`,
      headers: { cookie: boardCookie },
    });

    const withdrawn = await inject({
      method: "POST",
      url: `/api/motions/${id}/withdrawal`,
      headers: { cookie: memberCookie },
    });

    expect(withdrawn.statusCode).toBe(409);
    expect(withdrawn.json<{ reason: string }>().reason).toBe("already-closed");
  });

  it("answers somebody else's motion exactly as one that does not exist", async () => {
    /*
     * Otherwise the withdraw endpoint reports, for any identifier, whether a
     * motion is there - and who has put what to the meeting is exactly what
     * motions:handle exists to gate. Asserted as the two answers being the same
     * rather than as one of them being a 404, because it is the sameness that is
     * the property.
     */
    const other = `mo-foreign-${suffix}`;
    await seedMotion({
      id: other,
      personId: board.personId,
      closedAt: null,
      status: "SUBMITTED",
    });

    const foreign = await inject({
      method: "POST",
      url: `/api/motions/${other}/withdrawal`,
      headers: { cookie: memberCookie },
    });
    const missing = await inject({
      method: "POST",
      url: `/api/motions/mo-no-such-motion-${suffix}/withdrawal`,
      headers: { cookie: memberCookie },
    });

    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json<{ reason: string }>().reason).toBe(
      missing.json<{ reason: string }>().reason,
    );
    expect(foreign.json<{ reason: string }>().reason).toBe("motion-not-found");
  });

  it("records the submission and the close in the audit log", async () => {
    const created = await submitMotion(memberCookie, {
      title: `For granskningsloggen ${suffix}`,
      body: "Nagot att bekrafta.",
    });
    const { id } = created.json<{ id: string }>();
    await inject({
      method: "POST",
      url: `/api/motion-queue/${id}/acknowledgement`,
      headers: { cookie: boardCookie },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "motion", targetId: id },
      orderBy: { createdAt: "asc" },
      select: {
        action: true,
        actorPersonId: true,
        targetPersonId: true,
        context: true,
      },
    });

    expect(entries.map((entry) => entry.action)).toEqual([
      "MOTION_SUBMITTED",
      "MOTION_ACKNOWLEDGED",
    ]);
    // The member is the subject of both, so their own access report shows what
    // the board did with their item and not only what they did themselves.
    expect(
      entries.every((entry) => entry.targetPersonId === member.personId),
    ).toBe(true);
    expect(entries[0]?.actorPersonId).toBe(member.personId);
    expect(entries[1]?.actorPersonId).toBe(board.personId);

    // Facts, never the text: the log is append-only and exempt from every purge,
    // so a title copied in would outlive the motion by design.
    const submitted = JSON.stringify(entries[0]?.context);
    expect(submitted).not.toContain("granskningsloggen");
    expect(submitted).toContain("titleLength");
  });
});

describe("the bylaws' deadline", () => {
  it("is absent until the bylaws set one, and intake stays open", async () => {
    // No default, because EFL 6 kap. 15 § makes the deadline the association's
    // own clause: a number invented here would be the platform asserting a term
    // of a document it has not read.
    await prisma.association.update({
      where: { id: 1 },
      data: { motionDeadlineMonth: null, motionDeadlineDay: null },
    });

    const own = await intake(memberCookie);
    expect(own.deadline).toBeNull();

    // And a motion is still taken.
    const response = await submitMotion(memberCookie, {
      title: `Utan stadgefrist ${suffix}`,
      body: "Nagot.",
    });
    expect(response.statusCode).toBe(201);
  });

  it("is stated to the member and to the board once it is set", async () => {
    const response = await inject({
      method: "PUT",
      url: "/api/settings/motion-deadline",
      payload: { motionDeadline: { month: 1, day: 31 } },
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);

    const own = await intake(memberCookie);
    expect(own.deadline).toMatchObject({ month: 1, day: 31 });
    expect(own.deadline?.nextOn).toMatch(/^\d{4}-01-31$/);

    const board = await queue(boardCookie);
    expect(board.deadline).toMatchObject({ month: 1, day: 31 });
  });

  it("is readable by the board and changeable only by an administrator", async () => {
    // The settings split the retention policy already follows: the board is
    // answerable for the clause and has to see it, and changing what the instance
    // holds stays with an administrator.
    const read = await inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: boardCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(
      read.json<{ motionDeadline: { month: number } | null }>().motionDeadline,
    ).toMatchObject({ month: 1, day: 31 });

    const written = await inject({
      method: "PUT",
      url: "/api/settings/motion-deadline",
      payload: { motionDeadline: { month: 2, day: 1 } },
      headers: { cookie: boardCookie },
    });
    expect(written.statusCode).toBe(403);
  });

  it("refuses a month and day no year has", async () => {
    const response = await inject({
      method: "PUT",
      url: "/api/settings/motion-deadline",
      payload: { motionDeadline: { month: 2, day: 31 } },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ reason: string }>().reason).toBe(
      "motion-deadline-not-a-date",
    );
  });

  it("is refused by the table when it is half a clause or not a date", async () => {
    /*
     * The two columns are one setting, and the settings write is the only code
     * that keeps them together - so without the constraint the invariant lives
     * in one function and a statement typed at a prompt can leave a month with
     * no day. readMotionDeadline answers "no deadline" for such a row, which is
     * the reading that cannot turn a member away for a clause nobody can see,
     * but it should never have a row to answer for.
     *
     * The constraint is named in each assertion, so a typo in the statement
     * below fails the test rather than passing it for the wrong reason.
     */
    const before = await prisma.association.findUniqueOrThrow({
      where: { id: 1 },
      select: { motionDeadlineMonth: true, motionDeadlineDay: true },
    });
    // A whole clause is set at this point, and the restore below puts it back.
    // Asserted rather than assumed, on both columns: reordered so that no clause
    // is set, the restore would write nulls and turn the clearing test after this
    // one into a no-op, and a half-written pair would make the restore itself the
    // statement the constraint refuses.
    expect(before.motionDeadlineMonth).not.toBeNull();
    expect(before.motionDeadlineDay).not.toBeNull();

    try {
      await expect(
        prisma.$executeRaw`UPDATE "association" SET "motionDeadlineMonth" = 1, "motionDeadlineDay" = NULL WHERE "id" = 1`,
      ).rejects.toThrow(/association_motionDeadline_check/);
      await expect(
        prisma.$executeRaw`UPDATE "association" SET "motionDeadlineMonth" = NULL, "motionDeadlineDay" = 31 WHERE "id" = 1`,
      ).rejects.toThrow(/association_motionDeadline_check/);
      // 31 February, which isWritableDeadline refuses at the boundary: the day is
      // bounded by the month here too rather than by a flat 31.
      await expect(
        prisma.$executeRaw`UPDATE "association" SET "motionDeadlineMonth" = 2, "motionDeadlineDay" = 31 WHERE "id" = 1`,
      ).rejects.toThrow(/association_motionDeadline_check/);

      // And the clause the API writes is accepted, so the constraint is not
      // refusing the pair as such. 29 February is a date in a leap year and is
      // what nextMotionDeadline's clamp exists for.
      await expect(
        prisma.$executeRaw`UPDATE "association" SET "motionDeadlineMonth" = 2, "motionDeadlineDay" = 29 WHERE "id" = 1`,
      ).resolves.toBe(1);
    } finally {
      // The clause the suite arrived with, put back whether or not the
      // assertions held - a cleanup that runs only on success leaves the row
      // rewritten precisely when something has already gone wrong.
      await prisma.association.update({ where: { id: 1 }, data: before });
    }
  });

  it("clears back to no deadline", async () => {
    const response = await inject({
      method: "PUT",
      url: "/api/settings/motion-deadline",
      payload: { motionDeadline: null },
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ motionDeadline: unknown }>().motionDeadline,
    ).toBeNull();
    expect((await intake(memberCookie)).deadline).toBeNull();
  });
});

describe("the purge", () => {
  it("erases a closed motion past its window and leaves a recent one", async () => {
    const old = `mo-purge-old-${suffix}`;
    const recent = `mo-purge-recent-${suffix}`;
    await seedMotion({
      id: old,
      personId: member.personId,
      closedAt: daysBefore(RETENTION_DAYS + 5),
      status: "ACKNOWLEDGED",
    });
    await seedMotion({
      id: recent,
      personId: member.personId,
      closedAt: daysBefore(1),
      status: "ACKNOWLEDGED",
    });

    const erased = await purge.purgePerson(
      member.personId,
      NOW,
      RETENTION_DAYS,
    );

    expect(erased).toBe(1);
    expect(await prisma.motion.findUnique({ where: { id: old } })).toBeNull();
    expect(
      await prisma.motion.findUnique({ where: { id: recent } }),
    ).not.toBeNull();

    await prisma.motion.deleteMany({ where: { id: recent } });
  });

  it("leaves an open motion alone however long ago it was submitted", async () => {
    /*
     * The association is still processing it, so the purpose it is held for has
     * not ended. A queue nobody has worked is something for the board to see
     * rather than for a job to erase - and the row has no closing date for the
     * window to be measured from at all.
     */
    const open = `mo-purge-open-${suffix}`;
    await prisma.motion.create({
      data: {
        id: open,
        title: `Aldrig behandlad ${suffix}`,
        body: "Nagot.",
        submittedByPersonId: member.personId,
        submittedAt: daysBefore(RETENTION_DAYS * 10),
        status: "SUBMITTED",
        closedAt: null,
      },
    });
    createdMotionIds.push(open);

    await purge.purgePerson(member.personId, NOW, RETENTION_DAYS);

    expect(
      await prisma.motion.findUnique({ where: { id: open } }),
    ).not.toBeNull();
    await prisma.motion.deleteMany({ where: { id: open } });
  });

  it("records the erasure with a count and no title", async () => {
    const erasable = `mo-purge-audited-${suffix}`;
    await seedMotion({
      id: erasable,
      personId: lodger.personId,
      closedAt: daysBefore(RETENTION_DAYS + 5),
      status: "WITHDRAWN",
    });

    await purge.purgePerson(lodger.personId, NOW, RETENTION_DAYS);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "motion",
        targetPersonId: lodger.personId,
      },
      orderBy: { createdAt: "desc" },
      select: { actorPersonId: true, context: true },
    });

    expect(entry?.actorPersonId).toBeNull();
    expect(entry?.context).toEqual({
      motions: 1,
      retentionDaysAfterClosing: RETENTION_DAYS,
    });
  });

  it("is stopped by a legal hold standing against the member", async () => {
    const held = `mo-purge-held-${suffix}`;
    await seedMotion({
      id: held,
      personId: member.personId,
      closedAt: daysBefore(RETENTION_DAYS + 5),
      status: "ACKNOWLEDGED",
    });
    await prisma.legalHold.create({
      data: {
        personId: member.personId,
        reason: "A dispute about the meeting",
        placedByPersonId: board.personId,
      },
    });

    try {
      // Excluded by the scan, so the person is not even selected.
      await expect(purge.eligible(NOW, RETENTION_DAYS)).resolves.not.toContain(
        member.personId,
      );
      // And refused inside the transaction, which is the check that counts.
      await expect(
        purge.purgePerson(member.personId, NOW, RETENTION_DAYS),
      ).resolves.toBe(0);
      expect(
        await prisma.motion.findUnique({ where: { id: held } }),
      ).not.toBeNull();
    } finally {
      await prisma.legalHold.deleteMany({
        where: { personId: member.personId },
      });
      await prisma.motion.deleteMany({ where: { id: held } });
    }
  });

  it("is stopped by a hold placed while the run is already in flight", async () => {
    /*
     * The property the advisory lock exists for, and the only one here that needs
     * two transactions interleaved.
     *
     * Everything runs at READ COMMITTED. A purge that read "no hold stands" and
     * then deleted would erase exactly the rows a hold placed a moment later was
     * meant to preserve, and the board member who placed it would have been told
     * the person was held. The lock makes the two orderable: the placement takes
     * the same key, so it either lands before the purge's read and stops it, or
     * waits for the purge and takes effect from the moment it commits.
     *
     * Driven by holding the key in a transaction of this test's own, so the purge
     * has to wait for it - and the wait is read out of `pg_locks` rather than
     * inferred from a delay, so a purge that blocked and one that finished without
     * taking the key are told apart by what the database says.
     */
    const contested = `mo-purge-race-${suffix}`;
    await seedMotion({
      id: contested,
      personId: member.personId,
      closedAt: daysBefore(RETENTION_DAYS + 5),
      status: "ACKNOWLEDGED",
    });

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // A transaction that takes the hold key, writes the hold, and waits.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${member.personId}`}))`;
        await tx.legalHold.create({
          data: {
            personId: member.personId,
            reason: "Placed while the purge was running",
            placedByPersonId: board.personId,
          },
        });
        await holderDone;
      },
      /*
       * Longer than the wait below is willing to spend. An interactive
       * transaction defaults to five seconds, and this one is held open on
       * purpose while the purge queues behind its key - so on the default it
       * would abort with P2028 before the test let it go, the lock would be
       * released by the rollback, and the purge would sail through and erase.
       * The assertion would then fail as though the hold had not been honoured.
       * The same numbers as the booking and import interleaving tests.
       */
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(
        async () => (await holdLockCount(member.personId, true)) > 0n,
      );

      // The purge starts now and must block on the key rather than read past it.
      const running = purge.purgePerson(member.personId, NOW, RETENTION_DAYS);
      await waitFor(
        async () => (await holdLockCount(member.personId, false)) > 0n,
      );

      releaseHolder?.();
      await holder;

      // It erased nothing, because by the time it got the key the hold stood.
      await expect(running).resolves.toBe(0);
      expect(
        await prisma.motion.findUnique({ where: { id: contested } }),
      ).not.toBeNull();
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
      await prisma.legalHold.deleteMany({
        where: { personId: member.personId },
      });
      await prisma.motion.deleteMany({ where: { id: contested } });
    }
  });
});

describe("the data subject access report", () => {
  it("carries the member's motions with the date each becomes erasable", async () => {
    const closed = `mo-report-closed-${suffix}`;
    const open = `mo-report-open-${suffix}`;
    await seedMotion({
      id: closed,
      personId: member.personId,
      closedAt: new Date("2027-04-15T12:00:00.000Z"),
      status: "ACKNOWLEDGED",
    });
    await prisma.motion.create({
      data: {
        id: open,
        title: `Oppen motion ${suffix}`,
        body: "Nagot.",
        submittedByPersonId: member.personId,
        status: "SUBMITTED",
      },
    });
    createdMotionIds.push(open);

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${member.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    const report = response.json<{
      motions: {
        motionId: string;
        title: string;
        body: string;
        status: string;
        erasableFrom: string | null;
      }[];
    }>();

    const closedRow = report.motions.find((row) => row.motionId === closed);
    // Two years after the closing date, derived and never stored.
    expect(closedRow?.erasableFrom).toBe("2029-04-14");
    expect(closedRow?.body).toBe("Foreningen bor se over cykelrummet.");

    const openRow = report.motions.find((row) => row.motionId === open);
    // No closing date to count from, and the association is still processing it.
    expect(openRow?.erasableFrom).toBeNull();
    expect(openRow?.status).toBe("SUBMITTED");
  });
});
