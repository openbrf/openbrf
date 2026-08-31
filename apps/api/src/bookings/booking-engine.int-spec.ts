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
import type { BookableResourceSummary } from "./bookable-resource.service";
import type {
  BookableSlotView,
  ManagedBookingView,
  OwnBookingView,
} from "./booking.service";
import {
  addLocalDays,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localWeekAround,
} from "./stockholm-calendar";

/**
 * The slot engine and the booking API against a real database.
 *
 * Five properties, none of which a unit test can show.
 *
 * **The wall clock survives a daylight saving change.** The laundry room opens
 * at seven on the Saturday and at seven on the Sunday the clocks move, and the
 * two are an hour apart as instants. Both transitions are exercised through the
 * endpoint rather than against the generator, because the round trip through
 * JSON and back is where a time of day is most easily turned into an instant in
 * whatever zone the server happens to be running in.
 *
 * **The database decides a race.** Two residents of two different households
 * claim the same laundry hour at the same moment. One wins, the other is
 * refused with the reason a read would have given, and the audit log holds
 * exactly one entry - which is what proves the loser's entry rolled back with
 * its insert rather than being written beside it.
 *
 * **The quota is derived from residencies at write time.** Joint holders of one
 * apartment share one allowance without anything being stored that says so, and
 * a residency ending on the Thursday stops that person booking the Friday while
 * the bookings the household already made go on counting against it - so
 * somebody leaving does not hand the household a fresh week.
 *
 * **Cancelling gives the slot back**, because the unique index covers live
 * bookings only, and a resident cancelling somebody else's booking is answered
 * exactly as one that does not exist.
 *
 * **A stay of several nights is one row**, so the index cannot see an overlap
 * and the transaction lock is what refuses one.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `be-address-${suffix}`;
/** The jointly held apartment, whose two holders share one allowance. */
const jointApartmentId = `be-apartment-joint-${suffix}`;
/** A second household, so a race is between two apartments and not one. */
const otherApartmentId = `be-apartment-other-${suffix}`;

const quotaLaundryId = `be-resource-quota-${suffix}`;
const moveLaundryId = `be-resource-move-${suffix}`;
const raceLaundryId = `be-resource-race-${suffix}`;
const commonRoomId = `be-resource-common-${suffix}`;
const guestApartmentId = `be-resource-guest-${suffix}`;
const withdrawnId = `be-resource-withdrawn-${suffix}`;
const resourceIds = [
  quotaLaundryId,
  moveLaundryId,
  raceLaundryId,
  commonRoomId,
  guestApartmentId,
  withdrawnId,
];

/** One of the two holders of the jointly held apartment. */
const alfa = {
  personId: `be-alfa-${suffix}`,
  email: `be-alfa-${suffix}@exempel.se`,
};
/** The other, whose residency in it ends mid-week. */
const beta = {
  personId: `be-beta-${suffix}`,
  email: `be-beta-${suffix}@exempel.se`,
};
/** The second household, who exists so a race has two apartments in it. */
const gamma = {
  personId: `be-gamma-${suffix}`,
  email: `be-gamma-${suffix}@exempel.se`,
};
const board = {
  personId: `be-board-${suffix}`,
  email: `be-board-${suffix}@exempel.se`,
};
const manager = {
  personId: `be-manager-${suffix}`,
  email: `be-manager-${suffix}@exempel.se`,
};
const actors = [alfa, beta, gamma, board, manager];
const personIds = actors.map((actor) => actor.personId);

/**
 * The Sundays the clocks move in 2027, written out.
 *
 * Fixed dates rather than dates derived from the rule, so a test that agreed
 * with a broken generator could not also have derived its own expectation from
 * it. Nothing here books on these days - the calendar is read for them, which
 * is true whether they are ahead of today or behind it.
 */
const SPRING_SATURDAY: LocalDay = { year: 2027, month: 3, day: 27 };
const SPRING_SUNDAY: LocalDay = { year: 2027, month: 3, day: 28 };
const AUTUMN_SATURDAY: LocalDay = { year: 2027, month: 10, day: 30 };
const AUTUMN_SUNDAY: LocalDay = { year: 2027, month: 10, day: 31 };

/**
 * The week the booking tests work in: the one containing three weeks from now.
 *
 * Far enough ahead that every slot in it is bookable however long the suite
 * takes to run, and computed rather than fixed because a booking has to be in
 * the future and a date written into a file stops being that.
 */
const WEEK: LocalDay = weekMondayOf(addLocalDays(localDayOf(new Date()), 21));
const NEXT_WEEK: LocalDay = addLocalDays(WEEK, 7);

function weekMondayOf(day: LocalDay): LocalDay {
  return localDayOf(localWeekAround(noonOf(day)).startsAt);
}

function noonOf(day: LocalDay): Date {
  const instant = instantAt(day, 12 * 60);
  /* c8 ignore next 3 -- unreachable: Sweden's clock has never skipped noon */
  if (instant === null) {
    throw new Error(`No local noon on ${formatLocalDay(day)}.`);
  }
  return instant;
}

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
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
        // 10.29.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.29.${String(subnet)}.${String(host + 1)}`,
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

/** The slots a resource offers over a range of days, as a resident sees them. */
async function slotsFor(
  cookie: string,
  resourceId: string,
  from: LocalDay,
  to: LocalDay,
): Promise<BookableSlotView[]> {
  const response = await inject({
    method: "GET",
    url:
      `/api/bookings/resources/${resourceId}/slots` +
      `?from=${formatLocalDay(from)}&to=${formatLocalDay(to)}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<BookableSlotView[]>();
}

/** The slot at a given position of a given day, which every claim starts from. */
async function slotOn(
  cookie: string,
  resourceId: string,
  day: LocalDay,
  index = 0,
): Promise<BookableSlotView> {
  const slots = await slotsFor(cookie, resourceId, day, day);
  const slot = slots[index];
  if (slot === undefined) {
    throw new Error(
      `Resource ${resourceId} offers no slot ${String(index)} on ${formatLocalDay(day)}.`,
    );
  }
  return slot;
}

function claim(
  cookie: string,
  payload: {
    resourceId: string;
    apartmentId: string;
    startsAt: string;
    endsAt?: string;
  },
) {
  return inject({
    method: "POST",
    url: "/api/bookings",
    payload,
    headers: { cookie },
  });
}

let alfaCookie = "";
let betaCookie = "";
let gammaCookie = "";
let boardCookie = "";
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
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Bokningsvagen",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: jointApartmentId, addressId, number: "0101", floor: 1 },
      { id: otherApartmentId, addressId, number: "0202", floor: 2 },
    ],
  });

  for (const person of [
    { ...alfa, firstName: "Alva", lastName: "Andersson" },
    { ...beta, firstName: "Bengt", lastName: "Andersson" },
    { ...gamma, firstName: "Git", lastName: "Grannson" },
    { ...board, firstName: "Bea", lastName: "Ordforande" },
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

  // Alva and Bengt hold one apartment together, which is what makes the
  // allowance shared without anything storing that it is.
  await prisma.residency.createMany({
    data: [
      {
        personId: alfa.personId,
        apartmentId: jointApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2025-01-01"),
      },
      {
        personId: beta.personId,
        apartmentId: jointApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2025-01-01"),
      },
      {
        personId: gamma.personId,
        apartmentId: otherApartmentId,
        role: "MEMBER",
        movedInOn: new Date("2025-01-01"),
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2026-05-15"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  await prisma.bookableResource.createMany({
    data: [
      {
        id: quotaLaundryId,
        // 07:00 to 21:00 in two-hour slots: seven a day, two a week.
        name: `Tvattstuga kvot ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 7 * 60,
        closesAtMinute: 21 * 60,
        maxBookingsPerWeek: 2,
      },
      {
        id: moveLaundryId,
        // The same mechanics, so the move-out tests have a week of their own
        // and cannot spend the allowance the sharing tests are counting.
        name: `Tvattstuga flytt ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 7 * 60,
        closesAtMinute: 21 * 60,
        maxBookingsPerWeek: 2,
      },
      {
        id: raceLaundryId,
        // No limits at all, so a refusal in the race is the index and nothing
        // else.
        name: `Tvattstuga kapp ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 7 * 60,
        closesAtMinute: 21 * 60,
      },
      {
        id: commonRoomId,
        name: `Foreningslokal ${suffix}`,
        mode: "WHOLE_DAY",
        maxConcurrentBookings: 1,
      },
      {
        id: guestApartmentId,
        name: `Gastlagenhet ${suffix}`,
        mode: "DATE_RANGE",
      },
      {
        id: withdrawnId,
        name: `Bastu ${suffix}`,
        mode: "WHOLE_DAY",
        deactivatedAt: new Date("2026-06-01"),
      },
    ],
  });

  alfaCookie = await signIn(alfa.email);
  betaCookie = await signIn(beta.email);
  gammaCookie = await signIn(gamma.email);
  boardCookie = await signIn(board.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.booking.deleteMany({
      where: { resourceId: { in: resourceIds } },
    });
    await prisma.bookableResource.deleteMany({
      where: { id: { in: resourceIds } },
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
      where: { id: { in: [jointApartmentId, otherApartmentId] } },
    });
    await prisma.address.deleteMany({ where: { id: addressId } });

    // Audit entries stay: the table is append-only by trigger, and every
    // assertion below selects on this run's target ids rather than on a count.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("what a resident is offered", () => {
  it("lists the resources the house offers and not the withdrawn ones", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/bookings/resources",
      headers: { cookie: alfaCookie },
    });

    expect(response.statusCode).toBe(200);
    const offered = response.json<BookableResourceSummary[]>();
    const ids = offered.map((resource) => resource.id);
    expect(ids).toEqual(expect.arrayContaining([quotaLaundryId, commonRoomId]));
    // A withdrawn resource is not a choice, so it is not on the list a resident
    // chooses from.
    expect(ids).not.toContain(withdrawnId);
    // The limits travel with it: they are the rules the resident is subject to.
    expect(
      offered.find((resource) => resource.id === quotaLaundryId)
        ?.maxBookingsPerWeek,
    ).toBe(2);
  });

  it("refuses the property manager the calendar", async () => {
    // Decision 11: an external contractor handles the association's issues and
    // does not live in the building, so a laundry hour is not theirs to see.
    const response = await inject({
      method: "GET",
      url: "/api/bookings/resources",
      headers: { cookie: managerCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a resident the board's view of who booked what", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/booking-admin",
      headers: { cookie: alfaCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses a calendar wider than the cap", async () => {
    const response = await inject({
      method: "GET",
      url:
        `/api/bookings/resources/${quotaLaundryId}/slots` +
        `?from=2027-01-01&to=2027-12-31`,
      headers: { cookie: alfaCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("range-invalid");
  });

  it("says a withdrawn resource was withdrawn", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/bookings/resources/${withdrawnId}/slots?from=2027-06-01&to=2027-06-02`,
      headers: { cookie: alfaCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "resource-deactivated",
    );
  });
});

describe("the wall clock across a daylight saving change", () => {
  it("opens the laundry room at seven on the Sunday the clocks go forward", async () => {
    const saturday = await slotOn(alfaCookie, quotaLaundryId, SPRING_SATURDAY);
    const sunday = await slotOn(alfaCookie, quotaLaundryId, SPRING_SUNDAY);

    /*
     * The property the whole calendar is for. Both days open at 07:00 on the
     * association's clock, and the instants are an hour apart because the
     * clocks moved between them. Anything that generated slots by adding 24
     * hours to yesterday's would have opened the Sunday at eight.
     */
    expect(saturday.opensAtMinute).toBe(7 * 60);
    expect(sunday.opensAtMinute).toBe(7 * 60);
    expect(saturday.startsAt).toBe("2027-03-27T06:00:00.000Z");
    expect(sunday.startsAt).toBe("2027-03-28T05:00:00.000Z");
    expect(sunday.day).toBe("2027-03-28");
  });

  it("opens the laundry room at seven on the Sunday the clocks go back", async () => {
    const saturday = await slotOn(alfaCookie, quotaLaundryId, AUTUMN_SATURDAY);
    const sunday = await slotOn(alfaCookie, quotaLaundryId, AUTUMN_SUNDAY);

    expect(saturday.opensAtMinute).toBe(7 * 60);
    expect(sunday.opensAtMinute).toBe(7 * 60);
    expect(saturday.startsAt).toBe("2027-10-30T05:00:00.000Z");
    expect(sunday.startsAt).toBe("2027-10-31T06:00:00.000Z");
  });

  it("gives every day of both weekends the same seven slots", async () => {
    const spring = await slotsFor(
      alfaCookie,
      quotaLaundryId,
      SPRING_SATURDAY,
      addLocalDays(SPRING_SUNDAY, 1),
    );
    const autumn = await slotsFor(
      alfaCookie,
      quotaLaundryId,
      AUTUMN_SATURDAY,
      addLocalDays(AUTUMN_SUNDAY, 1),
    );

    // The opening hours are 07:00 to 21:00 whatever the clocks do, and the
    // room is shut across both changes, so no day loses or gains a slot.
    expect(spring).toHaveLength(21);
    expect(autumn).toHaveLength(21);
    expect(new Set(spring.map((slot) => slot.opensAtMinute))).toEqual(
      new Set([420, 540, 660, 780, 900, 1020, 1140]),
    );
    expect(new Set(autumn.map((slot) => slot.opensAtMinute))).toEqual(
      new Set([420, 540, 660, 780, 900, 1020, 1140]),
    );
  });

  it("gives the whole-day resource its 25-hour Sunday in October", async () => {
    const sunday = await slotOn(alfaCookie, commonRoomId, AUTUMN_SUNDAY);

    // Midnight to midnight on the association's clock, which is 25 hours that
    // day. A day of a fixed 24 hours would have ended it at 23:00.
    expect(sunday.opensAtMinute).toBe(0);
    expect(
      (Date.parse(sunday.endsAt) - Date.parse(sunday.startsAt)) /
        (60 * 60 * 1000),
    ).toBe(25);
  });
});

describe("claiming a slot", () => {
  it("books it, records it, and shows it back as the caller's own", async () => {
    const slot = await slotOn(gammaCookie, raceLaundryId, NEXT_WEEK, 6);

    const response = await claim(gammaCookie, {
      resourceId: raceLaundryId,
      apartmentId: otherApartmentId,
      startsAt: slot.startsAt,
    });

    expect(response.statusCode).toBe(201);
    const booked = response.json<OwnBookingView>();
    expect(booked.status).toBe("BOOKED");
    expect(booked.startsAt).toBe(slot.startsAt);
    expect(booked.endsAt).toBe(slot.endsAt);
    expect(booked.apartment?.id).toBe(otherApartmentId);

    // The entry carries the identifiers, the mechanics and the day, and never
    // the resource's name or the household's: the log outlives the rows.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_MADE",
        targetKind: "booking",
        targetId: booked.id,
      },
    });
    expect(entry?.actorPersonId).toBe(gamma.personId);
    expect(entry?.targetPersonId).toBe(gamma.personId);
    expect(entry?.context).toEqual({
      resourceId: raceLaundryId,
      apartmentId: otherApartmentId,
      mode: "TIME_SLOTS",
      startsAt: slot.startsAt,
      days: 1,
    });

    // And the calendar now says the slot is the caller's, which is what lets a
    // screen offer to cancel it.
    const again = await slotOn(gammaCookie, raceLaundryId, NEXT_WEEK, 6);
    expect(again.state).toBe("MINE");
    expect(again.bookingId).toBe(booked.id);

    // To everybody else it is taken, and it never says by whom.
    const asNeighbour = await slotOn(alfaCookie, raceLaundryId, NEXT_WEEK, 6);
    expect(asNeighbour.state).toBe("TAKEN");
    expect(asNeighbour.bookingId).toBeNull();
    expect(JSON.stringify(asNeighbour)).not.toContain(gamma.personId);
  });

  it("refuses a period that is not a slot the resource offers", async () => {
    const slot = await slotOn(alfaCookie, raceLaundryId, NEXT_WEEK, 0);
    const halfAnHourLate = new Date(
      Date.parse(slot.startsAt) + 30 * 60 * 1000,
    ).toISOString();

    const response = await claim(alfaCookie, {
      resourceId: raceLaundryId,
      apartmentId: jointApartmentId,
      startsAt: halfAnHourLate,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "slot-not-bookable",
    );
  });

  it("refuses a slot that has already begun", async () => {
    const yesterday = addLocalDays(localDayOf(new Date()), -1);
    const slot = await slotOn(alfaCookie, raceLaundryId, yesterday, 0);

    expect(slot.state).toBe("PAST");
    const response = await claim(alfaCookie, {
      resourceId: raceLaundryId,
      apartmentId: jointApartmentId,
      startsAt: slot.startsAt,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "slot-not-bookable",
    );
  });

  it("answers an apartment the caller does not hold as one that is not there", async () => {
    const slot = await slotOn(alfaCookie, raceLaundryId, NEXT_WEEK, 1);

    const response = await claim(alfaCookie, {
      resourceId: raceLaundryId,
      // A real apartment in the register, and not this caller's. The answer is
      // the same one a made-up identifier gets, so the endpoint cannot be used
      // to walk the building.
      apartmentId: otherApartmentId,
      startsAt: slot.startsAt,
    });
    const invented = await claim(alfaCookie, {
      resourceId: raceLaundryId,
      apartmentId: `be-nowhere-${suffix}`,
      startsAt: slot.startsAt,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
    expect(invented.statusCode).toBe(404);
    expect(invented.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const slot = await slotOn(alfaCookie, raceLaundryId, NEXT_WEEK, 3);
    expect(slot.state).toBe("FREE");
    const before = new Date();

    /*
     * Two households, so the apartment lock cannot be what separates them and
     * the partial unique index is left as the only thing that can.
     */
    const [first, second] = await Promise.all([
      claim(alfaCookie, {
        resourceId: raceLaundryId,
        apartmentId: jointApartmentId,
        startsAt: slot.startsAt,
      }),
      claim(gammaCookie, {
        resourceId: raceLaundryId,
        apartmentId: otherApartmentId,
        startsAt: slot.startsAt,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort(
      (left, right) => left - right,
    );
    expect(statuses).toEqual([201, 409]);

    const loser = first.statusCode === 409 ? first : second;
    // The same reason a read would have given, and a reason that never says
    // who won.
    expect(loser.json<{ reason: string }>().reason).toBe("slot-taken");
    expect(JSON.stringify(loser.json())).not.toContain(alfa.personId);
    expect(JSON.stringify(loser.json())).not.toContain(gamma.personId);

    const live = await prisma.booking.findMany({
      where: {
        resourceId: raceLaundryId,
        startsAt: new Date(slot.startsAt),
        status: "BOOKED",
      },
    });
    expect(live).toHaveLength(1);

    /*
     * And exactly one audit entry. The loser's entry was written in the same
     * transaction as the insert that affected nothing, so it rolled back with
     * it - which is the property that cannot be shown any other way. Two
     * entries here would mean the log claimed a booking that does not exist,
     * in a table nobody can correct.
     */
    const written = await prisma.auditLogEntry.findMany({
      where: {
        action: "BOOKING_MADE",
        targetKind: "booking",
        createdAt: { gte: before },
      },
      select: { context: true },
    });
    const forThisSlot = written.filter((entry) => {
      const context = entry.context as {
        resourceId?: string;
        startsAt?: string;
      } | null;
      return (
        context?.resourceId === raceLaundryId &&
        context.startsAt === slot.startsAt
      );
    });
    expect(forThisSlot).toHaveLength(1);
  });
});

describe("the quota", () => {
  it("is shared by the joint holders of one apartment", async () => {
    const first = await slotOn(alfaCookie, quotaLaundryId, WEEK, 0);
    const second = await slotOn(
      betaCookie,
      quotaLaundryId,
      addLocalDays(WEEK, 1),
      0,
    );

    const byAlfa = await claim(alfaCookie, {
      resourceId: quotaLaundryId,
      apartmentId: jointApartmentId,
      startsAt: first.startsAt,
    });
    const byBeta = await claim(betaCookie, {
      resourceId: quotaLaundryId,
      apartmentId: jointApartmentId,
      startsAt: second.startsAt,
    });

    // Two people, one apartment, two bookings: the allowance is the
    // apartment's, so nothing had to be stored for them to share it.
    expect(byAlfa.statusCode).toBe(201);
    expect(byBeta.statusCode).toBe(201);
  });

  it("refuses the third booking of the week and names the limit", async () => {
    const third = await slotOn(
      alfaCookie,
      quotaLaundryId,
      addLocalDays(WEEK, 2),
      0,
    );

    const response = await claim(alfaCookie, {
      resourceId: quotaLaundryId,
      apartmentId: jointApartmentId,
      startsAt: third.startsAt,
    });

    expect(response.statusCode).toBe(409);
    const refusal = response.json<{
      reason: string;
      quota: string[];
      allowed: number[];
    }>();
    expect(refusal.reason).toBe("quota-reached");
    // Codes and numbers, so the screen can say which rule and how many.
    expect(refusal.quota).toEqual(["maxBookingsPerWeek"]);
    expect(refusal.allowed).toEqual([2]);
  });

  it("counts the week the booking is for and not the week it is made in", async () => {
    const nextWeek = await slotOn(alfaCookie, quotaLaundryId, NEXT_WEEK, 0);

    const response = await claim(alfaCookie, {
      resourceId: quotaLaundryId,
      apartmentId: jointApartmentId,
      startsAt: nextWeek.startsAt,
    });

    // A fresh allowance, because it is a different calendar week. Counting the
    // week the request arrives in would let one household take every slot of
    // every future week in a single afternoon.
    expect(response.statusCode).toBe(201);
  });

  it("bites the day a residency ends, mid-week, and keeps what was already booked", async () => {
    /*
     * Bengt is leaving the joint apartment on the Thursday of the week the
     * bookings are for. He is still a resident today, so he still holds the
     * capability and is still offered the apartment - what changes is which
     * periods he holds it for.
     */
    const monday = WEEK;
    const wednesday = addLocalDays(WEEK, 2);
    const thursday = addLocalDays(WEEK, 3);
    const friday = addLocalDays(WEEK, 4);
    const saturday = addLocalDays(WEEK, 5);

    await prisma.residency.updateMany({
      where: { personId: beta.personId, apartmentId: jointApartmentId },
      data: {
        movedOutOn: new Date(`${formatLocalDay(thursday)}T00:00:00.000Z`),
      },
    });

    const before = await claim(betaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (await slotOn(betaCookie, moveLaundryId, wednesday)).startsAt,
    });
    const after = await claim(betaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (await slotOn(betaCookie, moveLaundryId, friday)).startsAt,
    });

    // Wednesday is his, Friday is not. The move-out date is the first day the
    // apartment is somebody else's, and a booking for a week when nobody living
    // there could use it is an hour taken from whoever moves in.
    expect(before.statusCode).toBe(201);
    expect(after.statusCode).toBe(404);
    expect(after.json<{ reason: string }>().reason).toBe("apartment-not-found");

    // Alva stays, so the Friday is hers to book.
    const byAlfa = await claim(alfaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (await slotOn(alfaCookie, moveLaundryId, friday)).startsAt,
    });
    expect(byAlfa.statusCode).toBe(201);

    /*
     * And the household gets no fresh week's allowance out of somebody leaving.
     * Bengt's Wednesday booking and Alva's Friday one are the week's two, so the
     * Saturday is refused - because the count is over the apartment's bookings
     * and not over who is still standing behind them.
     */
    const third = await claim(alfaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (await slotOn(alfaCookie, moveLaundryId, saturday)).startsAt,
    });
    expect(third.statusCode).toBe(409);
    expect(third.json<{ reason: string }>().reason).toBe("quota-reached");

    // The following week is a fresh allowance for whoever is still there, and
    // still closed to Bengt.
    const nextWeekForAlfa = await claim(alfaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (
        await slotOn(alfaCookie, moveLaundryId, addLocalDays(monday, 7))
      ).startsAt,
    });
    const nextWeekForBeta = await claim(betaCookie, {
      resourceId: moveLaundryId,
      apartmentId: jointApartmentId,
      startsAt: (
        await slotOn(betaCookie, moveLaundryId, addLocalDays(monday, 8))
      ).startsAt,
    });
    expect(nextWeekForAlfa.statusCode).toBe(201);
    expect(nextWeekForBeta.statusCode).toBe(404);
  });

  it("bites a stay that runs past the day the residency ends", async () => {
    /*
     * The case the periods above cannot show. Every other mode begins and ends
     * inside one day, so checking the day a period starts answers the whole
     * question; a stay does not. Bengt leaves on the Thursday, and a check-in on
     * the Wednesday is his - but the nights from the Thursday are not, and a
     * stay that stops being his halfway through is the guest apartment taken
     * from whoever moves in.
     */
    const wednesday = addLocalDays(WEEK, 2);
    const thursday = addLocalDays(WEEK, 3);
    const friday = addLocalDays(WEEK, 4);

    await prisma.residency.updateMany({
      where: { personId: beta.personId, apartmentId: jointApartmentId },
      data: {
        movedOutOn: new Date(`${formatLocalDay(thursday)}T00:00:00.000Z`),
      },
    });

    const checkIn = await slotOn(betaCookie, guestApartmentId, wednesday);
    const lastNightHeld = await slotOn(betaCookie, guestApartmentId, wednesday);
    const nightAfterLeaving = await slotOn(
      betaCookie,
      guestApartmentId,
      friday,
    );

    // Checks in on a night he holds and out on a morning he does not.
    const straddling = await claim(betaCookie, {
      resourceId: guestApartmentId,
      apartmentId: jointApartmentId,
      startsAt: checkIn.startsAt,
      endsAt: nightAfterLeaving.endsAt,
    });
    expect(straddling.statusCode).toBe(404);
    expect(straddling.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );

    // The Wednesday night alone ends before the move-out and stands.
    const insideHisTime = await claim(betaCookie, {
      resourceId: guestApartmentId,
      apartmentId: jointApartmentId,
      startsAt: checkIn.startsAt,
      endsAt: lastNightHeld.endsAt,
    });
    expect(insideHisTime.statusCode).toBe(201);

    await prisma.booking.deleteMany({
      where: { id: insideHisTime.json<OwnBookingView>().id },
    });
  });

  it("lets a household book the day its residency begins", async () => {
    /*
     * The other end of the same arithmetic, and the case an instant comparison
     * gets wrong in the opposite direction. Both residency dates are date
     * columns, read back at midnight UTC, while a night and a whole day open at
     * local midnight - the evening before in UTC. So a residency beginning on
     * the booked day compares as starting after the period it covers, and the
     * household that moves in on the Monday is told its apartment does not
     * exist when it asks for the Monday.
     *
     * Alva's residency is restored whatever happens, because the tests after
     * this one book against it: a move-in date left rewritten here would fail
     * them for a reason that is not theirs.
     */
    const arrival = addLocalDays(WEEK, 35);
    const dayAfter = addLocalDays(arrival, 1);
    const claimed: string[] = [];

    const moveAlvaIn = async (day: LocalDay): Promise<void> => {
      await prisma.residency.updateMany({
        where: { personId: alfa.personId, apartmentId: jointApartmentId },
        data: { movedInOn: new Date(`${formatLocalDay(day)}T00:00:00.000Z`) },
      });
    };

    try {
      await moveAlvaIn(arrival);

      // A night, which is where the two midnights are furthest apart.
      const firstNight = await slotOn(alfaCookie, guestApartmentId, arrival);
      const stayOnArrival = await claim(alfaCookie, {
        resourceId: guestApartmentId,
        apartmentId: jointApartmentId,
        startsAt: firstNight.startsAt,
        endsAt: firstNight.endsAt,
      });
      if (stayOnArrival.statusCode === 201) {
        claimed.push(stayOnArrival.json<OwnBookingView>().id);
      }
      expect(stayOnArrival.statusCode).toBe(201);

      // A whole day opens on the same boundary and answers the same way.
      const wholeDay = await slotOn(alfaCookie, commonRoomId, arrival);
      const roomOnArrival = await claim(alfaCookie, {
        resourceId: commonRoomId,
        apartmentId: jointApartmentId,
        startsAt: wholeDay.startsAt,
      });
      if (roomOnArrival.statusCode === 201) {
        claimed.push(roomOnArrival.json<OwnBookingView>().id);
      }
      expect(roomOnArrival.statusCode).toBe(201);

      // A residency that begins later still holds nothing, which is the half
      // of the rule the comparison must not give away.
      await moveAlvaIn(addLocalDays(arrival, 2));

      const nextNight = await slotOn(alfaCookie, guestApartmentId, dayAfter);
      const beforeArrival = await claim(alfaCookie, {
        resourceId: guestApartmentId,
        apartmentId: jointApartmentId,
        startsAt: nextNight.startsAt,
        endsAt: nextNight.endsAt,
      });
      if (beforeArrival.statusCode === 201) {
        claimed.push(beforeArrival.json<OwnBookingView>().id);
      }
      expect(beforeArrival.statusCode).toBe(404);
      expect(beforeArrival.json<{ reason: string }>().reason).toBe(
        "apartment-not-found",
      );
    } finally {
      await prisma.residency.updateMany({
        where: { personId: alfa.personId, apartmentId: jointApartmentId },
        data: { movedInOn: new Date("2025-01-01") },
      });
      await prisma.booking.deleteMany({ where: { id: { in: claimed } } });
    }
  });

  it("counts unstarted bookings against the concurrent limit", async () => {
    const first = await slotOn(gammaCookie, commonRoomId, NEXT_WEEK);
    const second = await slotOn(
      gammaCookie,
      commonRoomId,
      addLocalDays(NEXT_WEEK, 1),
    );

    const one = await claim(gammaCookie, {
      resourceId: commonRoomId,
      apartmentId: otherApartmentId,
      startsAt: first.startsAt,
    });
    const two = await claim(gammaCookie, {
      resourceId: commonRoomId,
      apartmentId: otherApartmentId,
      startsAt: second.startsAt,
    });

    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(409);
    const refusal = two.json<{ reason: string; quota: string[] }>();
    expect(refusal.reason).toBe("quota-reached");
    expect(refusal.quota).toEqual(["maxConcurrentBookings"]);

    // Cancelling gives the share back at once, because a cancelled row is not
    // counted. Nothing had to be decremented for that to be true.
    const held = one.json<OwnBookingView>();
    const cancelled = await inject({
      method: "POST",
      url: `/api/bookings/${held.id}/cancel`,
      headers: { cookie: gammaCookie },
    });
    expect(cancelled.statusCode).toBe(201);

    const retried = await claim(gammaCookie, {
      resourceId: commonRoomId,
      apartmentId: otherApartmentId,
      startsAt: second.startsAt,
    });
    expect(retried.statusCode).toBe(201);
  });
});

describe("cancelling", () => {
  it("gives the slot back to the calendar", async () => {
    const slot = await slotOn(
      gammaCookie,
      raceLaundryId,
      addLocalDays(NEXT_WEEK, 2),
      0,
    );
    const booked = await claim(gammaCookie, {
      resourceId: raceLaundryId,
      apartmentId: otherApartmentId,
      startsAt: slot.startsAt,
    });
    expect(booked.statusCode).toBe(201);
    const held = booked.json<OwnBookingView>();

    const response = await inject({
      method: "POST",
      url: `/api/bookings/${held.id}/cancel`,
      headers: { cookie: gammaCookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<OwnBookingView>().status).toBe("CANCELLED");

    /*
     * The half a full unique index would break: the cancelled row keeps its
     * start time, and somebody else takes the hour anyway because the index
     * covers live bookings only.
     */
    const freed = await slotOn(
      alfaCookie,
      raceLaundryId,
      addLocalDays(NEXT_WEEK, 2),
      0,
    );
    expect(freed.state).toBe("FREE");
    const rebooked = await claim(alfaCookie, {
      resourceId: raceLaundryId,
      apartmentId: jointApartmentId,
      startsAt: slot.startsAt,
    });
    expect(rebooked.statusCode).toBe(201);

    // And it is off the canceller's own list, which is what they hold.
    const mine = await inject({
      method: "GET",
      url: "/api/bookings/mine",
      headers: { cookie: gammaCookie },
    });
    expect(
      mine.json<OwnBookingView[]>().map((booking) => booking.id),
    ).not.toContain(held.id);
  });

  it("answers somebody else's booking as one that is not there", async () => {
    const slot = await slotOn(
      gammaCookie,
      raceLaundryId,
      addLocalDays(NEXT_WEEK, 3),
      0,
    );
    const booked = await claim(gammaCookie, {
      resourceId: raceLaundryId,
      apartmentId: otherApartmentId,
      startsAt: slot.startsAt,
    });
    const held = booked.json<OwnBookingView>();

    const byNeighbour = await inject({
      method: "POST",
      url: `/api/bookings/${held.id}/cancel`,
      headers: { cookie: alfaCookie },
    });
    const invented = await inject({
      method: "POST",
      url: `/api/bookings/be-nothing-${suffix}/cancel`,
      headers: { cookie: alfaCookie },
    });

    // The same answer either way, so this route cannot report whether a
    // booking exists for any identifier somebody cares to try.
    expect(byNeighbour.statusCode).toBe(404);
    expect(byNeighbour.json<{ reason: string }>().reason).toBe(
      "booking-not-found",
    );
    expect(invented.statusCode).toBe(404);
    expect(invented.json<{ reason: string }>().reason).toBe(
      "booking-not-found",
    );

    // And it is still live, which is the point of refusing.
    expect(
      (await prisma.booking.findUnique({ where: { id: held.id } }))?.status,
    ).toBe("BOOKED");
  });

  it("lets the board cancel anybody's, recorded against the board member", async () => {
    const listed = await inject({
      method: "GET",
      url: `/api/booking-admin?resourceId=${raceLaundryId}&from=${formatLocalDay(NEXT_WEEK)}&to=${formatLocalDay(addLocalDays(NEXT_WEEK, 6))}`,
      headers: { cookie: boardCookie },
    });
    expect(listed.statusCode).toBe(200);
    const managed = listed.json<ManagedBookingView[]>();
    const gammas = managed.find(
      (booking) =>
        booking.status === "BOOKED" &&
        booking.bookedBy.kind === "resident" &&
        booking.bookedBy.personId === gamma.personId,
    );
    // The board sees who booked what, which is what the capability is for.
    expect(gammas).toBeDefined();

    const response = await inject({
      method: "POST",
      url: `/api/booking-admin/${String(gammas?.id)}/cancel`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<OwnBookingView>().status).toBe("CANCELLED");

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_CANCELLED",
        targetKind: "booking",
        targetId: gammas?.id,
      },
    });
    // The board member acted; the resident is who it was about. That is what
    // puts it in the resident's access report as something done to them.
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetPersonId).toBe(gamma.personId);
    expect(entry?.context).toMatchObject({ resourceId: raceLaundryId });

    // A second cancellation is a conflict rather than a second entry.
    const again = await inject({
      method: "POST",
      url: `/api/booking-admin/${String(gammas?.id)}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("already-cancelled");
    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "BOOKING_CANCELLED",
          targetKind: "booking",
          targetId: gammas?.id,
        },
      }),
    ).toBe(1);
  });
});

describe("a resource booked by the night", () => {
  it("takes a stay of several nights as one booking", async () => {
    const checkIn = await slotOn(alfaCookie, guestApartmentId, NEXT_WEEK);
    const lastNight = await slotOn(
      alfaCookie,
      guestApartmentId,
      addLocalDays(NEXT_WEEK, 2),
    );

    const response = await claim(alfaCookie, {
      resourceId: guestApartmentId,
      apartmentId: jointApartmentId,
      startsAt: checkIn.startsAt,
      endsAt: lastNight.endsAt,
    });

    expect(response.statusCode).toBe(201);
    const stay = response.json<OwnBookingView>();
    expect(stay.startsAt).toBe(checkIn.startsAt);
    expect(stay.endsAt).toBe(lastNight.endsAt);

    // One row for the whole stay, with the number of nights in the entry.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "BOOKING_MADE",
        targetKind: "booking",
        targetId: stay.id,
      },
    });
    expect(entry?.context).toMatchObject({ mode: "DATE_RANGE", days: 3 });

    // And every night of it reads as taken, although only the first carries
    // the row: the calendar matches by overlap, not by an equal start.
    const nights = await slotsFor(
      gammaCookie,
      guestApartmentId,
      NEXT_WEEK,
      addLocalDays(NEXT_WEEK, 2),
    );
    expect(nights.map((night) => night.state)).toEqual([
      "TAKEN",
      "TAKEN",
      "TAKEN",
    ]);
  });

  it("refuses a stay that runs across one already held", async () => {
    const overlapping = await slotOn(
      gammaCookie,
      guestApartmentId,
      addLocalDays(NEXT_WEEK, 1),
    );
    const checkOut = await slotOn(
      gammaCookie,
      guestApartmentId,
      addLocalDays(NEXT_WEEK, 3),
    );

    const response = await claim(gammaCookie, {
      resourceId: guestApartmentId,
      apartmentId: otherApartmentId,
      startsAt: overlapping.startsAt,
      endsAt: checkOut.endsAt,
    });

    /*
     * The index cannot see this one: a stay is a single row keyed on its
     * check-in, and these two check in on different days. The transaction lock
     * and the overlap read are what refuse it, with the same reason the index
     * gives for a slot.
     */
    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe("slot-taken");
  });

  it("lets exactly one of two concurrent overlapping stays win", async () => {
    const from = addLocalDays(NEXT_WEEK, 20);
    const checkIn = await slotOn(alfaCookie, guestApartmentId, from);
    const middle = await slotOn(
      gammaCookie,
      guestApartmentId,
      addLocalDays(from, 1),
    );
    const firstOut = await slotOn(
      alfaCookie,
      guestApartmentId,
      addLocalDays(from, 2),
    );
    const secondOut = await slotOn(
      gammaCookie,
      guestApartmentId,
      addLocalDays(from, 3),
    );

    const [first, second] = await Promise.all([
      claim(alfaCookie, {
        resourceId: guestApartmentId,
        apartmentId: jointApartmentId,
        startsAt: checkIn.startsAt,
        endsAt: firstOut.endsAt,
      }),
      claim(gammaCookie, {
        resourceId: guestApartmentId,
        apartmentId: otherApartmentId,
        startsAt: middle.startsAt,
        endsAt: secondOut.endsAt,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort(
      (left, right) => left - right,
    );
    expect(statuses).toEqual([201, 409]);

    const live = await prisma.booking.count({
      where: {
        resourceId: guestApartmentId,
        status: "BOOKED",
        startsAt: { lt: new Date(secondOut.endsAt) },
        endsAt: { gt: new Date(checkIn.startsAt) },
      },
    });
    expect(live).toBe(1);
  });
});
