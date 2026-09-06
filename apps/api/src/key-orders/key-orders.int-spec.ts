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
import type { KeyOrderStatus } from "../generated/prisma/enums";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { KeyOrderPurgeService } from "./key-order-purge.service";
import type {
  KeyOrderIntakeView,
  KeyOrderQueueView,
} from "./key-order.service";

/**
 * Key orders against a real database.
 *
 * Six properties, none of which a unit test can show.
 *
 * The right is a resident's, and the assertion that says so is the one about the
 * lodger. He lives in the same apartment as the member and holds no
 * tenant-ownership, so BRL gives him no motion and no subletting application -
 * and he orders a key exactly as she does, because nothing gives anybody a right
 * to one and a way in through the front door belongs to the household. This
 * suite and `sublets.int-spec.ts` assert the same two people getting opposite
 * answers, which is the whole of the per-feature decision.
 *
 * The apartment has to be one the caller lives in. An administrator holds every
 * capability in the model and no residency, so they are refused exactly as
 * somebody naming a flat that is not in the register - which is what keeps the
 * endpoint from enumerating the building.
 *
 * The audiences are split at the controller. A resident cannot read the queue
 * and the property manager cannot reach the module at all.
 *
 * An order closes with a date and a status and is never deleted, closes exactly
 * once whichever way, and a resident cannot take back an order the board has
 * already answered.
 *
 * The personnummer scan refuses on the way in *and on a later revision*, names
 * where the number is, and does not echo it - and it holds against the board's
 * own note as well.
 *
 * And the purge, which is what makes the retention promise real: it erases
 * orders past their window, leaves an open one alone however old, and a legal
 * hold stops it. The audit entry recording the handover survives the purge that
 * erased the order, which is the one fact about a key worth keeping past the row
 * and is kept in the one table nobody can rewrite.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: KeyOrderPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `ko-address-${suffix}`;
const apartmentId = `ko-apartment-${suffix}`;
const otherApartmentId = `ko-other-apartment-${suffix}`;

const member = {
  personId: `ko-member-${suffix}`,
  email: `ko-member-${suffix}@exempel.se`,
};
const lodger = {
  personId: `ko-lodger-${suffix}`,
  email: `ko-lodger-${suffix}@exempel.se`,
};
const board = {
  personId: `ko-board-${suffix}`,
  email: `ko-board-${suffix}@exempel.se`,
};
const administrator = {
  personId: `ko-admin-${suffix}`,
  email: `ko-admin-${suffix}@exempel.se`,
};
const manager = {
  personId: `ko-manager-${suffix}`,
  email: `ko-manager-${suffix}@exempel.se`,
};
const actors = [member, lodger, board, administrator, manager];
const personIds = actors.map((actor) => actor.personId);

/** Every order this run created, so afterAll can clear the table it shares. */
const createdOrderIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The clock the purge is driven at, and the window it is driven with.
 *
 * Now rather than a date in the future, deliberately, for the reason
 * `bookings.int-spec.ts` gives: the purge is a query over the whole table and
 * this database is shared between suites, so a run driven from a date years
 * ahead would reach any order another suite had left standing. Anchored here,
 * the cutoff is thirty days back and every order this suite does not own is far
 * too recent to be in scope.
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
  const subnet = 100 + (Math.floor(ipCounter / 254) % 100);
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        /*
         * 10.43.0.0/16 is this feature's, and 10.43.100 and up is this suite's -
         * `sublets.int-spec.ts` takes the lower hundred of the same second
         * octet. The authentication endpoints are rate-limited per client
         * address, so two suites sharing one would make each other's requests
         * spend the other's budget. 10.40.0.1 to 10.40.0.4 are reserved for the
         * screenshot walk's four actors and are never taken here.
         */
        "x-forwarded-for": `10.43.${String(subnet)}.${String(host + 1)}`,
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

/** Orders as the given account, and remembers the row for the cleanup. */
async function order(
  cookie: string,
  payload: {
    apartmentId?: string;
    kind?: "KEY" | "TAG";
    quantity?: number;
    note?: string | null;
  } = {},
) {
  const response = await inject({
    method: "POST",
    url: "/api/key-orders",
    payload: {
      apartmentId: payload.apartmentId ?? apartmentId,
      kind: payload.kind ?? "TAG",
      quantity: payload.quantity ?? 1,
      note: payload.note === undefined ? "Till cykelrummet." : payload.note,
    },
    headers: { cookie },
  });
  if (response.statusCode === 201) {
    createdOrderIds.push(response.json<{ id: string }>().id);
  }
  return response;
}

/** The resident's own half of the module. */
async function intake(cookie: string): Promise<KeyOrderIntakeView> {
  const response = await inject({
    method: "GET",
    url: "/api/key-orders/mine",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<KeyOrderIntakeView>();
}

/** The board's half. */
async function queue(cookie: string): Promise<KeyOrderQueueView> {
  const response = await inject({
    method: "GET",
    url: "/api/key-order-queue",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<KeyOrderQueueView>();
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

/** Writes an order straight to the database, with a closing date of its own. */
async function seedOrder(input: {
  id: string;
  personId: string;
  closedAt: Date | null;
  status: KeyOrderStatus;
}): Promise<void> {
  await prisma.keyOrder.create({
    data: {
      id: input.id,
      orderedByPersonId: input.personId,
      apartmentId,
      kind: "KEY",
      quantity: 2,
      note: "Till porten.",
      status: input.status,
      closedAt: input.closedAt,
      closedByPersonId: input.closedAt === null ? null : board.personId,
    },
  });
  createdOrderIds.push(input.id);
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
  purge = app.get(KeyOrderPurgeService);
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
      street: "Nyckelgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1401", floor: 4 },
  });
  /*
   * A second apartment nobody in this suite lives in, so the refusal can be
   * asserted against an apartment that really is in the register: an identifier
   * nobody ever wrote would be refused by a service that had no check at all.
   */
  await prisma.apartment.create({
    data: { id: otherApartmentId, addressId, number: "1402", floor: 4 },
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
   * apartment without one. The same pair `sublets.int-spec.ts` sets up, and this
   * suite exists to give them the same answer where that one gives them
   * different ones.
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
  // The administrator holds no residency, which is the point of the account:
  // every capability the model defines, and no door here that is theirs.
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
 * it would fail for a reason that has nothing to do with them.
 */
afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await prisma.keyOrder.deleteMany({
        where: {
          OR: [
            { id: { in: createdOrderIds } },
            // Anything a test created and did not get to record, e.g. because an
            // assertion failed before its own cleanup line.
            { orderedByPersonId: { in: personIds } },
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
        where: { id: { in: [apartmentId, otherApartmentId] } },
      });
      await prisma.address.deleteMany({ where: { id: addressId } });

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

describe("who may order a key", () => {
  it("takes an order from the member", async () => {
    const response = await order(memberCookie, { kind: "KEY", quantity: 2 });

    expect(response.statusCode).toBe(201);

    const mine = await intake(memberCookie);
    const placed = mine.orders.find(
      (row) => row.id === response.json<{ id: string }>().id,
    );
    expect(placed?.status).toBe("SUBMITTED");
    expect(placed?.kind).toBe("KEY");
    expect(placed?.quantity).toBe(2);
    expect(placed?.apartment?.number).toBe("1401");
  });

  it("takes one from the resident who is not a member", async () => {
    /*
     * The decision this module makes differently from the one beside it. BRL
     * gives the lodger no motion and no subletting application; nothing gives
     * anybody a right to a key, so a way in through the front door belongs to
     * the household and he orders exactly as she does.
     */
    const response = await order(lodgerCookie, { kind: "TAG" });

    expect(response.statusCode).toBe(201);
    const mine = await intake(lodgerCookie);
    expect(mine.apartments.map((flat) => flat.id)).toEqual([apartmentId]);
  });

  it("refuses an administrator, who holds every capability and no residency", async () => {
    const response = await order(adminCookie);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );

    // And is offered no door at all, which is the same answer read from the
    // other end.
    expect((await intake(adminCookie)).apartments).toEqual([]);
  });

  it("refuses a resident naming an apartment that is not theirs", async () => {
    // A real apartment in the register, so this asserts the check rather than
    // the absence of a row - and the answer is the one a missing apartment gets,
    // because a distinguishable answer would enumerate the building.
    const response = await order(lodgerCookie, {
      apartmentId: otherApartmentId,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
  });

  it("refuses a quantity no household would want", async () => {
    const response = await order(memberCookie, { quantity: 400 });

    expect(response.statusCode).toBe(400);
  });

  it("takes an order with no note at all", async () => {
    // A tag for the entrance needs no explanation, and a field that insisted on
    // one would collect a line of nothing.
    const response = await order(memberCookie, { note: null });

    expect(response.statusCode).toBe(201);
  });
});

describe("who may read which half", () => {
  it("keeps the queue away from the resident who orders from it", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/key-order-queue",
      headers: { cookie: lodgerCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("keeps the whole module away from the property manager", async () => {
    /*
     * Decision 11, and the case where it costs something: handing out keys is
     * plausibly part of what a vicevard does, and the queue still names
     * residents and their apartments, which is the address book in another
     * shape.
     */
    for (const url of ["/api/key-orders/mine", "/api/key-order-queue"]) {
      const response = await inject({
        method: "GET",
        url,
        headers: { cookie: managerCookie },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("names the orderer to the board", async () => {
    const created = await order(lodgerCookie);
    expect(created.statusCode).toBe(201);

    const queued = await queue(boardCookie);
    const row = queued.orders.find(
      (placed) => placed.id === created.json<{ id: string }>().id,
    );

    expect(row?.orderer).toEqual({
      kind: "resident",
      personId: lodger.personId,
      name: "Lars Inneboende",
    });
  });

  it("withholds the name where the register protects it, and keeps the door", async () => {
    /*
     * Skyddade personuppgifter, and the projection is the server's rather than
     * the screen's: this queue is a working list and not a register, so a board
     * member who has to reach the person goes through the register that has a
     * statutory reason to name them.
     *
     * The apartment is deliberately still stated. The key is for a door, and a
     * board that could not tell which one could not answer the order at all.
     *
     * Asserted on the serialized row and not only on the projection, because
     * the name reaching the board through some other field of the same payload
     * is the disclosure this test exists to catch.
     */
    const created = await order(lodgerCookie);
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    await prisma.person.update({
      where: { id: lodger.personId },
      data: { protectedPersonalData: true },
    });
    try {
      const queued = await queue(boardCookie);
      const row = queued.orders.find((placed) => placed.id === id);

      expect(row?.orderer).toEqual({
        kind: "protected",
        personId: lodger.personId,
      });
      expect(row?.apartment?.id).toBe(apartmentId);
      expect(JSON.stringify(row)).not.toContain("Inneboende");
    } finally {
      await prisma.person.update({
        where: { id: lodger.personId },
        data: { protectedPersonalData: false },
      });
    }
  });
});

describe("the personal identity number guardrail", () => {
  /*
   * Shaped like a personal identity number and valid by its checksum, so the
   * scan recognises it - a string that merely looked like one would let this
   * whole describe block pass against a service that scanned nothing. Belongs to
   * nobody: the same number `news-comments.int-spec.ts` uses.
   */
  const WITH_A_NUMBER = "Till min son Erik, 19811218-9876.";

  it("refuses an order carrying one, and names where without echoing it", async () => {
    const response = await order(memberCookie, { note: WITH_A_NUMBER });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      reason: string;
      locations: { part: string; offset: number }[];
    }>();
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations).toEqual([
      { part: "note", offset: WITH_A_NUMBER.indexOf("1981") },
    ]);
    // The whole response body, not just the field the number would have
    // travelled in: a position is safe to publish and the value never is.
    expect(response.body).not.toContain("19811218-9876");
    expect(response.body).not.toContain("198112189876");
  });

  it("refuses it again on a later revision", async () => {
    /*
     * The half a scan on the way in does not cover. An order that arrived clean
     * and was edited to carry a number would otherwise be stored, and the number
     * would be on the board's screen and on an access report.
     */
    const created = await order(memberCookie);
    const id = created.json<{ id: string }>().id;

    const response = await inject({
      method: "PUT",
      url: `/api/key-orders/${id}`,
      payload: { kind: "KEY", quantity: 1, note: WITH_A_NUMBER },
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(422);

    const mine = await intake(memberCookie);
    expect(mine.orders.find((row) => row.id === id)?.note).not.toContain(
      "19811218-9876",
    );
  });

  it("refuses it in the board's own note", async () => {
    const created = await order(memberCookie);

    const response = await inject({
      method: "POST",
      url: `/api/key-order-queue/${created.json<{ id: string }>().id}/answer`,
      payload: { handedOver: false, note: WITH_A_NUMBER },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(
      response
        .json<{ locations: { part: string }[] }>()
        .locations.map((hit) => hit.part),
    ).toEqual(["boardNote"]);
    expect(response.body).not.toContain("19811218-9876");
  });

  it("takes a revision that carries no number", async () => {
    const created = await order(memberCookie);
    const id = created.json<{ id: string }>().id;

    const response = await inject({
      method: "PUT",
      url: `/api/key-orders/${id}`,
      payload: { kind: "KEY", quantity: 3, note: "Tre till porten." },
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ quantity: number }>().quantity).toBe(3);
  });
});

describe("the board's answer", () => {
  it("records a handover with its date, and never deletes the row", async () => {
    const created = await order(memberCookie, { kind: "KEY", quantity: 1 });
    const id = created.json<{ id: string }>().id;

    const answered = await inject({
      method: "POST",
      url: `/api/key-order-queue/${id}/answer`,
      payload: { handedOver: true, note: "Hamtad i styrelserummet." },
      headers: { cookie: boardCookie },
    });

    expect(answered.statusCode).toBe(201);
    expect(
      answered.json<{ status: string; closedAt: string | null }>(),
    ).toMatchObject({ status: "HANDED_OVER" });
    expect(
      answered.json<{ closedAt: string | null }>().closedAt,
    ).not.toBeNull();

    // Its own audit action, so the association can still say a key went to a
    // named person on a day once the order itself has been purged.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "KEY_ORDER_HANDED_OVER",
        targetKind: "keyOrder",
        targetId: id,
      },
    });
    expect(entry?.targetPersonId).toBe(member.personId);

    // And the resident reads the board's words on their own list.
    const mine = await intake(memberCookie);
    expect(mine.orders.find((row) => row.id === id)?.boardNote).toBe(
      "Hamtad i styrelserummet.",
    );
  });

  it("declines an order, which the motion queue has no equivalent of", async () => {
    // Refusing to take up a member's motion is not the board's to decide under
    // EFL 6 kap. 15 §. Refusing a fourth tag to the bike room plainly is.
    const created = await order(memberCookie, { kind: "TAG", quantity: 4 });

    const answered = await inject({
      method: "POST",
      url: `/api/key-order-queue/${created.json<{ id: string }>().id}/answer`,
      payload: { handedOver: false, note: "Hogst tva per lagenhet." },
      headers: { cookie: boardCookie },
    });

    expect(answered.statusCode).toBe(201);
    expect(answered.json<{ status: string }>().status).toBe("DECLINED");
  });

  it("closes exactly once, whichever way", async () => {
    const created = await order(memberCookie);
    const id = created.json<{ id: string }>().id;

    const first = await inject({
      method: "POST",
      url: `/api/key-order-queue/${id}/answer`,
      payload: { handedOver: true, note: null },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);

    const second = await inject({
      method: "POST",
      url: `/api/key-order-queue/${id}/answer`,
      payload: { handedOver: false, note: null },
      headers: { cookie: boardCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ reason: string }>().reason).toBe("already-closed");
  });

  it("refuses a withdrawal once the board has answered", async () => {
    const created = await order(memberCookie);
    const id = created.json<{ id: string }>().id;

    await inject({
      method: "POST",
      url: `/api/key-order-queue/${id}/answer`,
      payload: { handedOver: true, note: null },
      headers: { cookie: boardCookie },
    });

    const withdrawal = await inject({
      method: "POST",
      url: `/api/key-orders/${id}/withdrawal`,
      headers: { cookie: memberCookie },
    });

    expect(withdrawal.statusCode).toBe(409);
  });

  it("answers an order that is not the caller's as one that never existed", async () => {
    const created = await order(memberCookie);

    const response = await inject({
      method: "POST",
      url: `/api/key-orders/${created.json<{ id: string }>().id}/withdrawal`,
      // The lodger holds the capability and did not place this order.
      headers: { cookie: lodgerCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe("order-not-found");
  });
});

describe("the purge", () => {
  it("erases a closed order past its window and leaves the handover recorded", async () => {
    /*
     * The two halves of what this module keeps. The row goes, because the
     * purpose it was held for ended; the audit entry stays, because the log is
     * append-only and exempt from every purge, and "somebody was given a key to
     * this building on this day" is the one fact worth keeping past the order.
     */
    const id = `ko-expired-${suffix}`;
    await seedOrder({
      id,
      personId: member.personId,
      closedAt: daysBefore(90),
      status: "HANDED_OVER",
    });
    await prisma.auditLogEntry.create({
      data: {
        action: "KEY_ORDER_HANDED_OVER",
        actorPersonId: board.personId,
        targetPersonId: member.personId,
        targetKind: "keyOrder",
        targetId: id,
        context: { status: "HANDED_OVER", kind: "KEY", quantity: 2 },
      },
    });

    const summary = await purge.run(NOW, RETENTION_DAYS);

    expect(summary.ordersDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.keyOrder.findUnique({ where: { id } })).toBeNull();
    expect(
      await prisma.auditLogEntry.findFirst({
        where: { action: "KEY_ORDER_HANDED_OVER", targetId: id },
      }),
    ).not.toBeNull();

    // And one entry per person saying what went and the window it fell out of.
    expect(
      await prisma.auditLogEntry.findFirst({
        where: {
          action: "SERVICE_DATA_PURGED",
          targetKind: "keyOrder",
          targetPersonId: member.personId,
        },
      }),
    ).not.toBeNull();
  });

  it("leaves an open order alone however old it is", async () => {
    // The association is still processing it, so the purpose it is held for has
    // not ended. A queue nobody has worked is for the board to see rather than
    // for a job to erase.
    const id = `ko-open-${suffix}`;
    await seedOrder({
      id,
      personId: member.personId,
      closedAt: null,
      status: "SUBMITTED",
    });

    await purge.run(NOW, RETENTION_DAYS);

    expect(await prisma.keyOrder.findUnique({ where: { id } })).not.toBeNull();
  });

  it("is stopped by a hold placed while the run is already in flight", async () => {
    /*
     * Everything runs at READ COMMITTED. A purge that read "no hold stands" and
     * then deleted would erase exactly the rows a hold placed a moment later was
     * meant to preserve, and the board member who placed it would have been told
     * the person was held. The lock makes the two orderable: the placement takes
     * the same key, so it either lands before the purge's read and stops it, or
     * waits for the purge and takes effect from the moment it commits.
     *
     * The wait is read out of `pg_locks` rather than inferred from a delay, so a
     * purge that blocked and one that finished without taking the key are told
     * apart by what the database says.
     */
    const contested = `ko-purge-race-${suffix}`;
    await seedOrder({
      id: contested,
      personId: lodger.personId,
      closedAt: daysBefore(RETENTION_DAYS + 5),
      status: "HANDED_OVER",
    });

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // A transaction that takes the hold key, writes the hold, and waits. Run
    // through $executeRaw because the lock function returns void, which the
    // client has no column type for.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${lodger.personId}`}))`;
        await tx.legalHold.create({
          data: {
            personId: lodger.personId,
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
       */
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(
        async () => (await holdLockCount(lodger.personId, true)) > 0n,
      );

      const running = purge.purgePerson(lodger.personId, NOW, RETENTION_DAYS);
      await waitFor(
        async () => (await holdLockCount(lodger.personId, false)) > 0n,
      );

      releaseHolder?.();
      await holder;

      // It erased nothing, because by the time it got the key the hold stood.
      await expect(running).resolves.toBe(0);
      expect(
        await prisma.keyOrder.findUnique({ where: { id: contested } }),
      ).not.toBeNull();
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
      await prisma.legalHold.deleteMany({
        where: { personId: lodger.personId },
      });
    }
  }, 60_000);
});

describe("the data subject access report", () => {
  it("carries the resident's orders with the date each becomes erasable", async () => {
    const closed = `ko-report-closed-${suffix}`;
    const open = `ko-report-open-${suffix}`;
    await prisma.keyOrder.create({
      data: {
        id: closed,
        orderedByPersonId: lodger.personId,
        apartmentId,
        kind: "TAG",
        quantity: 1,
        note: "Till tvattstugan.",
        status: "HANDED_OVER",
        closedAt: new Date("2027-04-15T12:00:00.000Z"),
        closedByPersonId: board.personId,
        boardNote: "Utlamnad i porten.",
      },
    });
    createdOrderIds.push(closed);
    await prisma.keyOrder.create({
      data: {
        id: open,
        orderedByPersonId: lodger.personId,
        apartmentId,
        kind: "KEY",
        quantity: 1,
      },
    });
    createdOrderIds.push(open);

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${lodger.personId}`,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);

    const report = response.json<{
      keyOrders: {
        orderId: string;
        apartment: string | null;
        kind: string;
        quantity: number;
        note: string | null;
        boardNote: string | null;
        status: string;
        erasableFrom: string | null;
      }[];
    }>();

    const closedRow = report.keyOrders.find((row) => row.orderId === closed);
    // A year after the closing date, derived and never stored.
    expect(closedRow?.erasableFrom).toBe("2028-04-14");
    expect(closedRow?.note).toBe("Till tvattstugan.");
    expect(closedRow?.boardNote).toBe("Utlamnad i porten.");
    expect(closedRow?.apartment).toContain("1401");

    const openRow = report.keyOrders.find((row) => row.orderId === open);
    // No closing date to count from, and the association is still processing it.
    expect(openRow?.erasableFrom).toBeNull();
    expect(openRow?.status).toBe("SUBMITTED");
  });
});
