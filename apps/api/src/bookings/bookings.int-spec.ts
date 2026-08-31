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
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { BookableResourceView } from "./bookable-resource.service";
import { BookingPurgeService } from "./booking-purge.service";

/**
 * Resource booking against a real database.
 *
 * Five properties, none of which a unit test can show.
 *
 * The double booking is refused by the database. The partial unique index is
 * the whole of that guarantee, and it is partial for a reason: a cancelled
 * booking must let go of its period, or a time somebody changed their mind
 * about could never be booked by anyone again. Both halves are asserted,
 * because an index that was accidentally written without its WHERE clause would
 * pass the first assertion and fail the second.
 *
 * The catalogue is the board's. A resident and the property manager are refused
 * at the controller, which is where the capability sits.
 *
 * A withdrawn resource keeps its bookings, every act on the catalogue is in the
 * audit log with the mode and the field names and no free text, and the grid a
 * booking was cut from cannot be moved under it while it is still to come.
 *
 * The purge, which is what makes the retention promise real: it erases bookings
 * past their window, leaves the ones inside it, and a legal hold stops it for
 * the person it stands against.
 *
 * And that the hold stops it even when placed while the run is in flight, which
 * is the one property here that needs two transactions interleaved rather than
 * one sequence of calls.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: BookingPurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `bk-address-${suffix}`;
const apartmentId = `bk-apartment-${suffix}`;

const laundryId = `bk-resource-laundry-${suffix}`;
const commonRoomId = `bk-resource-common-${suffix}`;

const board = {
  personId: `bk-board-${suffix}`,
  email: `bk-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `bk-resident-${suffix}`,
  email: `bk-resident-${suffix}@exempel.se`,
};
const manager = {
  personId: `bk-manager-${suffix}`,
  email: `bk-manager-${suffix}@exempel.se`,
};
const actors = [board, resident, manager];
const personIds = actors.map((actor) => actor.personId);

/**
 * The resources this suite creates through the API, whose ids are the server's.
 *
 * Collected so afterAll can delete them: an assertion failing before the end of
 * a test would otherwise leave a resource behind, and the catalogue assertions
 * read the whole list.
 */
const createdResourceIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The clock the purge is driven at, and the window it is driven with.
 *
 * Now rather than a date in the future, deliberately. The purge is a query over
 * the whole table and this database is shared between suites, so a run driven
 * from a fixed date years ahead would reach any booking another suite had left
 * standing at the time - erasing a fixture that suite was about to assert on,
 * for a reason nobody would find. Anchored here, the cutoff is thirty days back
 * from now and every booking this suite does not own is far too recent to be in
 * scope.
 */
const NOW = new Date();
const RETENTION_DAYS = 30;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function daysAfter(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
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
        // 10.28.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.28.${String(subnet)}.${String(host + 1)}`,
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

/**
 * Whether anything is queued behind this person's legal-hold key.
 *
 * Read out of `pg_locks` rather than inferred from a delay, so a purge that
 * blocks and a purge that finished without taking the key are told apart by
 * what the database says instead of by how long a test was willing to wait.
 * `hashtext` gives a signed int4 and the advisory lock space addresses it as
 * two halves of a bigint, which is what the shifting reassembles.
 */
async function waitsForHoldLock(personId: string): Promise<boolean> {
  const key = `legal-hold:${personId}`;
  const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
    SELECT count(*) AS waiting
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND NOT granted
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return (row?.waiting ?? 0n) > 0n;
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

/** The whole catalogue as the board reads it. */
async function catalogue(cookie: string): Promise<BookableResourceView[]> {
  const response = await inject({
    method: "GET",
    url: "/api/bookable-resources",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<BookableResourceView[]>();
}

const laundryPayload = {
  name: `Tvattstuga ${suffix}`,
  description: "Kallaren, port 14",
  mode: "TIME_SLOTS",
  slotMinutes: 120,
  opensAtMinute: 7 * 60,
  closesAtMinute: 21 * 60,
  maxConcurrentBookings: 2,
  maxBookingsPerWeek: 3,
};

let boardCookie = "";
let residentCookie = "";
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
  purge = app.get(BookingPurgeService);
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
      street: "Bokningsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1501", floor: 5 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...resident, firstName: "Rune", lastName: "Boende" },
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

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2025-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  // Two resources written directly, so the tests that read them do not depend
  // on the tests that create one through the API having run first.
  await prisma.bookableResource.createMany({
    data: [
      {
        id: laundryId,
        name: `Tvattstuga A ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 7 * 60,
        closesAtMinute: 21 * 60,
        maxBookingsPerWeek: 3,
      },
      {
        id: commonRoomId,
        name: `Foreningslokal ${suffix}`,
        mode: "WHOLE_DAY",
        maxConcurrentBookings: 1,
      },
    ],
  });

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    /*
     * The resources this run owns, resolved before anything is deleted, and the
     * bookings deleted by that same set.
     *
     * Booking.resource is Restrict, so a booking left standing against a
     * resource vetoes deleting the resource - and a booking says which person
     * booked what, which is service-tier personal data this suite would be
     * leaving in a shared database for the rest of its life. Scoped to the two
     * fixtures alone it would clear only those: a booking made against a
     * resource one of the catalogue tests created, in a test that failed an
     * assertion before its own cleanup line, would survive and take its
     * resource with it. So the same condition selects both, and the bookings go
     * first.
     */
    const ownResources = await prisma.bookableResource.findMany({
      where: {
        OR: [
          { id: { in: [laundryId, commonRoomId, ...createdResourceIds] } },
          // Anything the catalogue tests created and did not get to delete.
          { name: { endsWith: suffix } },
        ],
      },
      select: { id: true },
    });
    const ownResourceIds = ownResources.map((resource) => resource.id);

    await prisma.booking.deleteMany({
      where: { resourceId: { in: ownResourceIds } },
    });
    await prisma.bookableResource.deleteMany({
      where: { id: { in: ownResourceIds } },
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

    // Audit entries stay: the table is append-only by trigger, and every
    // assertion below selects on this run's target ids rather than on a count.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("the double booking", () => {
  // Ahead of the clock, so the purge tests below can never reach these however
  // long after this was written the suite is run.
  const slot = daysAfter(30);

  it("refuses a second live booking of the same hour", async () => {
    const first = await prisma.booking.create({
      data: {
        resourceId: laundryId,
        apartmentId,
        bookedByPersonId: resident.personId,
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    /*
     * The database refuses it, not a read the application took a moment ago -
     * and the assertion says which refusal, because that is the property. Any
     * failure satisfies `toThrow()`: a foreign key nobody meant to break, a
     * column renamed out from under the fixture, a connection dropped. This
     * test exists for the partial unique index, so it asserts the code Postgres
     * raises when a unique index is what refused the write.
     */
    await expect(
      prisma.booking.create({
        data: {
          resourceId: laundryId,
          apartmentId,
          bookedByPersonId: board.personId,
          startsAt: slot,
          endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.booking.delete({ where: { id: first.id } });
  });

  it("lets a cancelled booking give its hour back", async () => {
    /*
     * The half a full unique index would break. Without the WHERE clause the
     * cancelled row would keep the hour for ever and nobody could book a time
     * somebody once changed their mind about.
     */
    const cancelled = await prisma.booking.create({
      data: {
        resourceId: laundryId,
        apartmentId,
        bookedByPersonId: resident.personId,
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
        status: "CANCELLED",
      },
    });

    const rebooked = await prisma.booking.create({
      data: {
        resourceId: laundryId,
        apartmentId,
        bookedByPersonId: board.personId,
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    expect(rebooked.status).toBe("BOOKED");

    await prisma.booking.deleteMany({
      where: { id: { in: [cancelled.id, rebooked.id] } },
    });
  });

  it("lets two resources hold the same hour", async () => {
    const laundry = await prisma.booking.create({
      data: {
        resourceId: laundryId,
        bookedByPersonId: resident.personId,
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
      },
    });
    const commonRoom = await prisma.booking.create({
      data: {
        resourceId: commonRoomId,
        bookedByPersonId: board.personId,
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
      },
    });

    expect(commonRoom.id).not.toBe(laundry.id);

    await prisma.booking.deleteMany({
      where: { id: { in: [laundry.id, commonRoom.id] } },
    });
  });
});

describe("the catalogue capability", () => {
  it.each([
    ["a resident", () => residentCookie],
    ["the property manager", () => managerCookie],
  ])("refuses %s the catalogue", async (_who, cookie) => {
    const response = await inject({
      method: "GET",
      url: "/api/bookable-resources",
      headers: { cookie: cookie() },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a resident the creation of a resource", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/bookable-resources",
      payload: { ...laundryPayload, name: `Refused ${suffix}` },
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(
      await prisma.bookableResource.findFirst({
        where: { name: `Refused ${suffix}` },
      }),
    ).toBeNull();
  });

  it("offers the board its own catalogue", async () => {
    const resources = await catalogue(boardCookie);

    expect(resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([laundryId, commonRoomId]),
    );
  });
});

describe("configuring a resource", () => {
  it("creates one, audits it, and counts no bookings against it", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/bookable-resources",
      payload: laundryPayload,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<BookableResourceView>();
    createdResourceIds.push(created.id);

    expect(created.mode).toBe("TIME_SLOTS");
    expect(created.slotMinutes).toBe(120);
    expect(created.maxConcurrentBookings).toBe(2);
    expect(created.maxBookingsPerWeek).toBe(3);
    expect(created.deactivatedAt).toBeNull();
    expect(created.bookingCount).toBe(0);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_RESOURCE_CREATED",
        targetKind: "bookableResource",
        targetId: created.id,
      },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    // Facts, never the name the board typed: the entry is append-only and
    // outlives the row, so a copy here would be the one the purge never reached.
    expect(entry?.context).toEqual({
      mode: "TIME_SLOTS",
      quotas: ["maxConcurrentBookings", "maxBookingsPerWeek"],
    });
  });

  it("refuses a slot length that leaves a remainder", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/bookable-resources",
      payload: {
        ...laundryPayload,
        name: `Ojamn ${suffix}`,
        slotMinutes: 180,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "slot-does-not-fit",
    );
  });

  it("refuses opening hours on a whole-day resource", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/bookable-resources",
      payload: {
        name: `Lokal med tider ${suffix}`,
        mode: "WHOLE_DAY",
        slotMinutes: 120,
        opensAtMinute: 420,
        closesAtMinute: 1260,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "schedule-not-applicable",
    );
  });

  it("refuses a quota of none", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/bookable-resources",
      payload: {
        ...laundryPayload,
        name: `Noll ${suffix}`,
        maxBookingsPerWeek: 0,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "quota-not-positive",
    );
  });

  it("clears a quota back to unlimited and names what changed", async () => {
    const response = await inject({
      method: "PUT",
      url: `/api/bookable-resources/${laundryId}`,
      payload: {
        name: `Tvattstuga A ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 7 * 60,
        closesAtMinute: 21 * 60,
        maxBookingsPerWeek: null,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<BookableResourceView>().maxBookingsPerWeek).toBeNull();

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_RESOURCE_UPDATED",
        targetKind: "bookableResource",
        targetId: laundryId,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry?.context).toEqual({
      mode: "TIME_SLOTS",
      changed: ["maxBookingsPerWeek"],
      quotas: [],
    });

    // Put it back, so the resource the other tests read is as they found it.
    await prisma.bookableResource.update({
      where: { id: laundryId },
      data: { maxBookingsPerWeek: 3 },
    });
  });

  it("refuses an update to a resource that does not exist", async () => {
    const response = await inject({
      method: "PUT",
      url: `/api/bookable-resources/bk-missing-${suffix}`,
      payload: laundryPayload,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "resource-not-found",
    );
  });

  describe("with a booking still to come", () => {
    /*
     * The grid a booking was cut from cannot be moved under it.
     *
     * A booking carries the instants it was made for, not a reference to a
     * slot, so changing the mode or the slot length or the opening hours does
     * not move the bookings already made: they keep a start and an end that
     * correspond to no period the resource offers any more. Nothing on the
     * calendar can draw such a row, the quota cannot count it and the
     * double-booking index cannot protect it, and the resident still believes
     * they hold Tuesday evening.
     *
     * Renaming is the other half, and it has to keep working. A house that
     * cannot correct a spelling mistake without cancelling a week of bookings
     * would have a rule that costs more than it buys.
     */
    let bookingId = "";

    /** The laundry fixture exactly as the suite created it. */
    const asCreated = {
      name: `Tvattstuga A ${suffix}`,
      mode: "TIME_SLOTS",
      slotMinutes: 120,
      opensAtMinute: 7 * 60,
      closesAtMinute: 21 * 60,
      maxBookingsPerWeek: 3,
    };

    beforeAll(async () => {
      const slot = daysAfter(21);
      const booking = await prisma.booking.create({
        data: {
          resourceId: laundryId,
          apartmentId,
          bookedByPersonId: resident.personId,
          startsAt: slot,
          endsAt: new Date(slot.getTime() + 2 * 60 * 60 * 1000),
        },
      });
      bookingId = booking.id;
    });

    afterAll(async () => {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    });

    it("refuses a change to the booking mechanics", async () => {
      const response = await inject({
        method: "PUT",
        url: `/api/bookable-resources/${laundryId}`,
        payload: { name: asCreated.name, mode: "WHOLE_DAY" },
        headers: { cookie: boardCookie },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ reason: string }>().reason).toBe(
        "resource-in-use",
      );

      // Refused whole, so the row the resident holds still matches the grid.
      const unchanged = await prisma.bookableResource.findUnique({
        where: { id: laundryId },
        select: { mode: true, slotMinutes: true },
      });
      expect(unchanged?.mode).toBe("TIME_SLOTS");
      expect(unchanged?.slotMinutes).toBe(120);
    });

    it("allows a change to the name", async () => {
      const renamed = `Tvattstuga A ommalad ${suffix}`;
      const response = await inject({
        method: "PUT",
        url: `/api/bookable-resources/${laundryId}`,
        payload: { ...asCreated, name: renamed },
        headers: { cookie: boardCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<BookableResourceView>().name).toBe(renamed);

      // Back to what the suite created, by the same route, so this rename does
      // not leave the fixture depending on execution order.
      const restored = await inject({
        method: "PUT",
        url: `/api/bookable-resources/${laundryId}`,
        payload: asCreated,
        headers: { cookie: boardCookie },
      });
      expect(restored.statusCode).toBe(200);
    });

    it("allows a change to the mechanics once the booking has passed", async () => {
      // The bound is what is still to come. Rewriting the slots does not make
      // last March untrue, so a resource nobody holds a future booking on is
      // the board's to reconfigure.
      const ended = daysBefore(2);
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          startsAt: new Date(ended.getTime() - 2 * 60 * 60 * 1000),
          endsAt: ended,
        },
      });

      const response = await inject({
        method: "PUT",
        url: `/api/bookable-resources/${laundryId}`,
        payload: { ...asCreated, slotMinutes: 60 },
        headers: { cookie: boardCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<BookableResourceView>().slotMinutes).toBe(60);

      const restored = await inject({
        method: "PUT",
        url: `/api/bookable-resources/${laundryId}`,
        payload: asCreated,
        headers: { cookie: boardCookie },
      });
      expect(restored.statusCode).toBe(200);
    });
  });

  it("withdraws a resource and keeps the bookings made against it", async () => {
    const created = await prisma.bookableResource.create({
      data: {
        name: `Bastu ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 60,
        opensAtMinute: 8 * 60,
        closesAtMinute: 20 * 60,
      },
    });
    createdResourceIds.push(created.id);
    const booking = await prisma.booking.create({
      data: {
        resourceId: created.id,
        apartmentId,
        bookedByPersonId: resident.personId,
        startsAt: daysAfter(34),
        endsAt: new Date(daysAfter(34).getTime() + 60 * 60 * 1000),
      },
    });

    const response = await inject({
      method: "POST",
      url: `/api/bookable-resources/${created.id}/deactivate`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const withdrawn = response.json<BookableResourceView>();
    expect(withdrawn.deactivatedAt).not.toBeNull();
    expect(withdrawn.bookingCount).toBe(1);

    // The booking says what it was for only through the resource, so both stay.
    expect(
      await prisma.booking.findUnique({ where: { id: booking.id } }),
    ).not.toBeNull();

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_RESOURCE_DEACTIVATED",
        targetKind: "bookableResource",
        targetId: created.id,
      },
    });
    expect(entry?.context).toEqual({ mode: "TIME_SLOTS", bookings: 1 });

    // A second withdrawal is a conflict, and editing a withdrawn resource is
    // refused rather than quietly configuring something nobody is offered.
    const again = await inject({
      method: "POST",
      url: `/api/bookable-resources/${created.id}/deactivate`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe(
      "resource-deactivated",
    );

    const edited = await inject({
      method: "PUT",
      url: `/api/bookable-resources/${created.id}`,
      payload: { name: `Bastu ${suffix}`, mode: "WHOLE_DAY" },
      headers: { cookie: boardCookie },
    });
    expect(edited.statusCode).toBe(409);

    await prisma.booking.delete({ where: { id: booking.id } });
  });
});

describe("the purge", () => {
  /** A booking made by this person, ending the given number of days ago. */
  async function bookingEndedDaysAgo(
    personId: string,
    days: number,
    hour: number,
  ): Promise<string> {
    const endsAt = daysBefore(days);
    const booking = await prisma.booking.create({
      data: {
        resourceId: commonRoomId,
        apartmentId,
        bookedByPersonId: personId,
        // Distinct start times, so the partial unique index does not refuse a
        // fixture two of these tests happen to want on the same resource.
        startsAt: new Date(endsAt.getTime() - hour * 60 * 60 * 1000),
        endsAt,
      },
    });
    return booking.id;
  }

  it("erases what is past the window and leaves what is inside it", async () => {
    const expired = await bookingEndedDaysAgo(resident.personId, 40, 1);
    const recent = await bookingEndedDaysAgo(resident.personId, 10, 2);

    const summary = await purge.run(NOW, RETENTION_DAYS);

    expect(summary.failed).toBe(0);
    expect(
      await prisma.booking.findUnique({ where: { id: expired } }),
    ).toBeNull();
    expect(
      await prisma.booking.findUnique({ where: { id: recent } }),
    ).not.toBeNull();

    // One entry naming the person, with the count and no resource on it.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "booking",
        targetPersonId: resident.personId,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry?.actorPersonId).toBeNull();
    /*
     * Equal and not merely matching. The count and the window are the whole of
     * the evidence a purge entry owes, and this entry names the person and is
     * written into a table that is exempt from every purge - so a field naming
     * the resource, or when any of the erased bookings ran, would be a precise
     * record of somebody's use of the house, kept for good, inside the entry
     * that says it was erased. `toMatchObject` would pass through exactly that.
     */
    expect(entry?.context).toEqual({
      bookings: 1,
      retentionDaysAfterBooking: RETENTION_DAYS,
    });

    await prisma.booking.deleteMany({ where: { id: recent } });
  });

  it("writes nothing on a second run with nothing left to erase", async () => {
    const before = await prisma.auditLogEntry.count({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "booking",
        targetPersonId: resident.personId,
      },
    });

    await purge.run(NOW, RETENTION_DAYS);

    /*
     * Eligibility is computed from the data rather than marked on it, so a
     * person already erased is not selected again - otherwise they would
     * collect an entry a night for ever in a table nobody can tidy.
     *
     * Read as this person's entry count and not as the run's total. The purge
     * is a query over the whole table and this database is shared between
     * suites, so `summary.bookingsDeleted` counts whatever any other suite left
     * past its window too: a run that erased somebody else's expired booking
     * would fail an assertion about this one while the property under test held
     * perfectly.
     */
    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "SERVICE_DATA_PURGED",
          targetKind: "booking",
          targetPersonId: resident.personId,
        },
      }),
    ).toBe(before);
  });

  it("is stopped by a legal hold and resumes once it is released", async () => {
    const held = await bookingEndedDaysAgo(resident.personId, 50, 3);
    const hold = await prisma.legalHold.create({
      data: {
        personId: resident.personId,
        reason: `Forsakringsarende ${suffix}`,
        placedByPersonId: board.personId,
      },
    });

    await purge.run(NOW, RETENTION_DAYS);

    // Art. 17.3 is about the person's data rather than about one table: a
    // dispute that keeps their contact details keeps the bookings it may be
    // about.
    expect(
      await prisma.booking.findUnique({ where: { id: held } }),
    ).not.toBeNull();

    await prisma.legalHold.update({
      where: { id: hold.id },
      data: { releasedAt: new Date(), releasedByPersonId: board.personId },
    });
    await purge.run(NOW, RETENTION_DAYS);

    expect(await prisma.booking.findUnique({ where: { id: held } })).toBeNull();
  });

  it("waits for a hold being placed rather than erasing under it", async () => {
    /*
     * The interleaving the two checks in the scan and the transaction cannot
     * answer between them.
     *
     * Everything here runs at READ COMMITTED. A hold that commits after the
     * purge has read "nobody is held" and before it deletes is invisible to
     * both reads, and the bookings the hold was placed to preserve go anyway -
     * while the board member who placed it is told the person is held. The
     * transaction-scoped advisory lock is what turns that into an ordering:
     * `LegalHoldService.place` and the purge take the same key, so one of them
     * waits for the other and either outcome is a decision somebody made.
     *
     * Played out as the transaction a placement is, rather than through the
     * service, because the case is about what the purge sees while that
     * transaction is open: it holds the key, it has inserted the hold, and it
     * does not commit until this test lets it. A purge that takes the same key
     * cannot read until then. One that does not reads a person with no hold
     * against them and erases their bookings.
     */
    const expired = await bookingEndedDaysAgo(resident.personId, 60, 5);

    let release!: () => void;
    const placed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const placing = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${resident.personId}`}))`;
        await tx.legalHold.create({
          data: {
            personId: resident.personId,
            reason: `Tvist ${suffix}`,
            placedByPersonId: board.personId,
          },
        });
        await placed;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    let purgeSettled = false;
    const purging = purge
      .purgePerson(resident.personId, NOW, RETENTION_DAYS)
      .finally(() => (purgeSettled = true));

    /*
     * Released only once the purge can make no further progress on its own:
     * either it is waiting for this person's key, which is the whole of the
     * fix, or it has finished without taking one, which is the defect. Waiting
     * on the state rather than on a duration keeps both outcomes deterministic.
     */
    await waitFor(
      async () => purgeSettled || (await waitsForHoldLock(resident.personId)),
    );
    const settledBeforeTheHoldCommitted = purgeSettled;
    release();

    const [erased] = await Promise.all([purging, placing]);

    // It waited, so it read the hold, so it erased nothing.
    expect(settledBeforeTheHoldCommitted).toBe(false);
    expect(erased).toBe(0);
    expect(
      await prisma.booking.findUnique({ where: { id: expired } }),
    ).not.toBeNull();

    await prisma.legalHold.deleteMany({
      where: { personId: resident.personId, releasedAt: null },
    });
    await prisma.booking.deleteMany({ where: { id: expired } });
  });

  it("erases a cancelled booking on the same clock as a live one", async () => {
    const endsAt = daysBefore(45);
    const cancelled = await prisma.booking.create({
      data: {
        resourceId: commonRoomId,
        apartmentId,
        bookedByPersonId: board.personId,
        startsAt: new Date(endsAt.getTime() - 4 * 60 * 60 * 1000),
        endsAt,
        status: "CANCELLED",
      },
    });

    await purge.run(NOW, RETENTION_DAYS);

    // A cancellation is a record of a booking that was made, and its purpose
    // ran out on the same day the booking's did.
    expect(
      await prisma.booking.findUnique({ where: { id: cancelled.id } }),
    ).toBeNull();
  });

  it("never touches the resources themselves", async () => {
    // A bookable resource holds no personal data at all: it is the
    // association's account of what it offers.
    expect(
      await prisma.bookableResource.findUnique({ where: { id: commonRoomId } }),
    ).not.toBeNull();
  });
});
