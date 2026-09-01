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
import { EventSignupPurgeService } from "./event-signup-purge.service";
import type { EventView } from "./event.service";
import type {
  AttendableOccurrenceView,
  RollCallView,
} from "./event-signup.service";

/**
 * Signing up to a date, against a real database.
 *
 * What a unit test cannot show, and nothing else.
 *
 * **The database and a lock decide a race.** Two residents claim the last place
 * at the same date in the same instant. One takes it, the other is refused with
 * the reason a read would have given, and the audit log holds exactly one entry -
 * which is what proves the loser's entry rolled back with its own claim rather
 * than being written beside it. The capacity is a count over a set of rows
 * measured against a number on another table, so no constraint can hold it and
 * the lock is the whole of the guarantee.
 *
 * **A place given back is takeable again**, because the places taken are the rows
 * with no withdrawal date. Standing down frees it the moment the date is written,
 * a neighbour can take it, and somebody who stood down and changed their mind
 * reopens the same row rather than getting a second one.
 *
 * **The refusal to reshape a date people are standing on is now real.** PR 5 left
 * that refusal reaching a function that answered "nobody, ever". A resident signs
 * up, the board's edit is refused with the date named, the resident stands down,
 * and the same edit goes through - which is the only way to show the two halves
 * are connected.
 *
 * **Names are behind the managing capability.** The list a resident reads carries
 * counts and never a neighbour's name or identifier; the roll-call carries names
 * and a person with protected personal data is on it as a place and not as a name.
 *
 * **The wall clock survives the date column trap.** A midsummer party starting at
 * half past midnight is on the 21st in Stockholm and on the 20th in UTC. Every
 * date this module states is the association's own, and this is the boundary day
 * that says so through the endpoint rather than against the calendar helpers.
 *
 * **The purge erases on the occurrence's clock and a legal hold stops it**, per
 * person, for real rows.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `es-address-${suffix}`;
const apartmentId = `es-apartment-${suffix}`;

const board = {
  personId: `es-board-${suffix}`,
  email: `es-board-${suffix}@exempel.se`,
};
const alfa = {
  personId: `es-alfa-${suffix}`,
  email: `es-alfa-${suffix}@exempel.se`,
};
const beta = {
  personId: `es-beta-${suffix}`,
  email: `es-beta-${suffix}@exempel.se`,
};
const gamma = {
  personId: `es-gamma-${suffix}`,
  email: `es-gamma-${suffix}@exempel.se`,
};
/** A resident the register masks, so the roll-call has one to withhold. */
const skyddad = {
  personId: `es-skyddad-${suffix}`,
  email: `es-skyddad-${suffix}@exempel.se`,
};
const manager = {
  personId: `es-manager-${suffix}`,
  email: `es-manager-${suffix}@exempel.se`,
};
const actors = [board, alfa, beta, gamma, skyddad, manager];
const personIds = actors.map((actor) => actor.personId);

/** Every series this suite creates, so afterAll takes its dates with it. */
const createdEventIds: string[] = [];

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
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
        // 10.33.0.0/16 is this suite's - the event series suite holds 10.30,
        // the motions suite 10.31 and the register suite 10.32; the others
        // each hold their own.
        "x-forwarded-for": `10.33.${String(subnet)}.${String(host + 1)}`,
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

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A "YYYY-MM-DD" a whole number of days ahead of today.
 *
 * Derived rather than written out, because everything below has to fall inside
 * the half-year the resident's calendar reaches: a year written by hand would
 * make these pass until it arrived and then fail on the calendar rather than on a
 * regression. Plain UTC arithmetic, so this helper shares nothing with the
 * calendar module it is used to test.
 */
function dayAhead(days: number): string {
  const day = new Date(Date.now() + days * MILLISECONDS_PER_DAY);
  return day.toISOString().slice(0, 10);
}

/** The calendar date before a "YYYY-MM-DD", by the same plain arithmetic. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) - MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** A single-date series the board has entered, published, taking sign-ups. */
async function publishedSeries(options: {
  firstOn: string;
  capacity?: number | null;
  signupOpen?: boolean;
  startsAtMinute?: number;
  title?: string;
}): Promise<EventView> {
  const created = await inject({
    method: "POST",
    url: "/api/events",
    payload: {
      title: options.title ?? `Stadag ${suffix}`,
      description: "Ta med krattor.",
      category: "Stadag",
      location: "Innergarden",
      signupOpen: options.signupOpen ?? true,
      capacity: options.capacity ?? null,
      firstOn: options.firstOn,
      startsAtMinute: options.startsAtMinute ?? 10 * 60,
      durationMinutes: 4 * 60,
      recurrence: null,
    },
    headers: { cookie: boardCookie },
  });
  expect(created.statusCode).toBe(201);
  const series = created.json<EventView>();
  createdEventIds.push(series.id);

  const published = await inject({
    method: "POST",
    url: `/api/events/${series.id}/publish`,
    payload: { published: true },
    headers: { cookie: boardCookie },
  });
  expect(published.statusCode).toBe(201);
  return published.json<EventView>();
}

/** The one occurrence of a single-date series. */
function onlyOccurrence(series: EventView): string {
  expect(series.occurrences).toHaveLength(1);
  const occurrence = series.occurrences[0];
  if (occurrence === undefined) {
    throw new Error("The series has no dates.");
  }
  return occurrence.id;
}

function claim(cookie: string, occurrenceId: string) {
  return inject({
    method: "POST",
    url: `/api/event-signups/${occurrenceId}`,
    headers: { cookie },
  });
}

function withdraw(cookie: string, occurrenceId: string) {
  return inject({
    method: "POST",
    url: `/api/event-signups/${occurrenceId}/withdraw`,
    headers: { cookie },
  });
}

async function rollCall(occurrenceId: string): Promise<RollCallView> {
  const response = await inject({
    method: "GET",
    url: `/api/event-attendance/occurrences/${occurrenceId}`,
    headers: { cookie: boardCookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<RollCallView>();
}

/** The caller's own view of one date, out of the calendar they may read. */
async function ownViewOf(
  cookie: string,
  occurrenceId: string,
): Promise<AttendableOccurrenceView | undefined> {
  const response = await inject({
    method: "GET",
    url: "/api/event-signups",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response
    .json<AttendableOccurrenceView[]>()
    .find((entry) => entry.occurrenceId === occurrenceId);
}

let boardCookie = "";
let alfaCookie = "";
let betaCookie = "";
let gammaCookie = "";
let skyddadCookie = "";
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
      street: "Anmalningsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1301", floor: 5 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...alfa, firstName: "Alfa", lastName: "Boende" },
    { ...beta, firstName: "Beta", lastName: "Boende" },
    { ...gamma, firstName: "Gamma", lastName: "Boende" },
    { ...skyddad, firstName: "Signe", lastName: "Skyddad" },
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
        protectedPersonalData: person.personId === skyddad.personId,
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
  for (const person of [alfa, beta, gamma, skyddad]) {
    await prisma.residency.create({
      data: {
        personId: person.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2025-01-01"),
      },
    });
  }
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  boardCookie = await signIn(board.email);
  alfaCookie = await signIn(alfa.email);
  betaCookie = await signIn(beta.email);
  gammaCookie = await signIn(gamma.email);
  skyddadCookie = await signIn(skyddad.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    /*
     * The series this run owns, by id and by title: a test that failed an
     * assertion before its own cleanup would otherwise leave one behind. The
     * dates cascade with the series and the sign-ups cascade with the dates, so
     * all three go together.
     */
    await prisma.event.deleteMany({
      where: {
        OR: [{ id: { in: createdEventIds } }, { title: { endsWith: suffix } }],
      },
    });
    await prisma.eventSignup.deleteMany({
      where: { personId: { in: personIds } },
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
    // assertion below selects on this run's own target ids.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("who may sign up at all", () => {
  it("lets a resident read the calendar and take a place", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(30) });
    const occurrenceId = onlyOccurrence(series);

    const response = await claim(alfaCookie, occurrenceId);

    expect(response.statusCode).toBe(200);
    const view = response.json<AttendableOccurrenceView>();
    expect(view.placesTaken).toBe(1);
    expect(view.own?.withdrawnAt).toBeNull();
    expect(view.placesLeft).toBeNull();
  });

  it("refuses the property manager every route", async () => {
    // They handle the association's issues; they do not live in the building,
    // and a place taken by an external contractor is a place taken from a
    // household.
    const series = await publishedSeries({ firstOn: dayAhead(31) });
    const occurrenceId = onlyOccurrence(series);

    for (const response of await Promise.all([
      inject({
        method: "GET",
        url: "/api/event-signups",
        headers: { cookie: managerCookie },
      }),
      claim(managerCookie, occurrenceId),
      inject({
        method: "GET",
        url: `/api/event-attendance/occurrences/${occurrenceId}`,
        headers: { cookie: managerCookie },
      }),
    ])) {
      expect(response.statusCode).toBe(403);
    }
  });

  it("refuses a resident the roll-call", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(32) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    const response = await inject({
      method: "GET",
      url: `/api/event-attendance/occurrences/${occurrenceId}`,
      headers: { cookie: betaCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("answers a date of a draft exactly as one that does not exist", async () => {
    /*
     * The difference between "no such date" and "that date is not taking
     * sign-ups" would let anybody holding events:attend enumerate what the board
     * is drafting, one identifier at a time.
     */
    const created = await inject({
      method: "POST",
      url: "/api/events",
      payload: {
        title: `Hemligt mote ${suffix}`,
        signupOpen: true,
        firstOn: dayAhead(33),
        startsAtMinute: 18 * 60,
        durationMinutes: 60,
        recurrence: null,
      },
      headers: { cookie: boardCookie },
    });
    const draft = created.json<EventView>();
    createdEventIds.push(draft.id);
    const occurrenceId = onlyOccurrence(draft);

    const response = await claim(alfaCookie, occurrenceId);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ reason: string }>().reason).toBe(
      "occurrence-not-found",
    );

    // And it is not on the calendar a resident reads either, which is the other
    // half of the same promise.
    await expect(ownViewOf(alfaCookie, occurrenceId)).resolves.toBeUndefined();
  });
});

describe("the places", () => {
  it("lets exactly one of two concurrent claims take the last place", async () => {
    const series = await publishedSeries({
      firstOn: dayAhead(34),
      capacity: 1,
    });
    const occurrenceId = onlyOccurrence(series);
    const before = new Date();

    /*
     * Two residents, one place. The capacity is a count over a set of rows
     * measured against a number stored on the series, so no unique index can
     * refuse the second - which leaves the lock in `event-signup-lock.ts` as the
     * only thing that can, and this is the assertion that says it does.
     */
    const [first, second] = await Promise.all([
      claim(alfaCookie, occurrenceId),
      claim(betaCookie, occurrenceId),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort(
      (left, right) => left - right,
    );
    // Neither both winning nor both losing: exactly one of each.
    expect(statuses).toEqual([200, 409]);

    const loser = first.statusCode === 409 ? first : second;
    // The same reason a read would have given, and a reason that never says who
    // took the place.
    expect(loser.json<{ reason: string }>().reason).toBe("occurrence-full");
    expect(JSON.stringify(loser.json())).not.toContain(alfa.personId);
    expect(JSON.stringify(loser.json())).not.toContain(beta.personId);

    const standing = await prisma.eventSignup.findMany({
      where: { occurrenceId, withdrawnAt: null },
    });
    expect(standing).toHaveLength(1);

    /*
     * And exactly one audit entry. The loser's entry was written in the same
     * transaction as the claim that took no place, so it rolled back with it -
     * which is the property that cannot be shown any other way. Two entries here
     * would mean the log claimed a sign-up that does not exist, in a table nobody
     * can correct.
     */
    const written = await prisma.auditLogEntry.findMany({
      where: {
        action: "EVENT_SIGNUP_MADE",
        targetKind: "eventSignup",
        createdAt: { gte: before },
      },
      select: { context: true },
    });
    const forThisDate = written.filter((entry) => {
      const context = entry.context as { occurrenceId?: string } | null;
      return context?.occurrenceId === occurrenceId;
    });
    expect(forThisDate).toHaveLength(1);
  });

  it("refuses a second place to somebody who already has one", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(35) });
    const occurrenceId = onlyOccurrence(series);
    expect((await claim(alfaCookie, occurrenceId)).statusCode).toBe(200);

    const again = await claim(alfaCookie, occurrenceId);

    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("already-signed-up");
    expect(
      await prisma.eventSignup.count({
        where: { occurrenceId, personId: alfa.personId },
      }),
    ).toBe(1);
  });

  it("counts the places taken and says how many are left", async () => {
    const series = await publishedSeries({
      firstOn: dayAhead(36),
      capacity: 3,
    });
    const occurrenceId = onlyOccurrence(series);

    await claim(alfaCookie, occurrenceId);
    const second = await claim(betaCookie, occurrenceId);

    expect(second.json<AttendableOccurrenceView>()).toMatchObject({
      capacity: 3,
      placesTaken: 2,
      placesLeft: 1,
    });
  });

  it("refuses a date the series does not take sign-ups for", async () => {
    const series = await publishedSeries({
      firstOn: dayAhead(37),
      signupOpen: false,
    });
    const occurrenceId = onlyOccurrence(series);

    const response = await claim(alfaCookie, occurrenceId);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "signup-not-offered",
    );
  });

  it("refuses a date the board has called off", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(38) });
    const occurrenceId = onlyOccurrence(series);
    const calledOff = await inject({
      method: "POST",
      url: `/api/events/occurrences/${occurrenceId}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(calledOff.statusCode).toBe(201);

    const response = await claim(alfaCookie, occurrenceId);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "occurrence-cancelled",
    );
  });

  it("keeps a date that has begun on the calendar and refuses a place at it", async () => {
    /*
     * The boundary between the read and the claim, which are two different lines.
     * The read keeps a date until it ENDS, because a resident looking at today's
     * cleaning day while it runs is entitled to see it rather than find it gone.
     * The claim refuses from the moment it STARTS, because signing up for the
     * hour somebody is standing in is a claim on time that has gone.
     */
    const series = await publishedSeries({ firstOn: dayAhead(39) });
    const occurrenceId = onlyOccurrence(series);
    const now = new Date();
    await prisma.eventOccurrence.update({
      where: { id: occurrenceId },
      data: {
        startsAt: new Date(now.getTime() - 60 * 60 * 1000),
        endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });

    const response = await claim(alfaCookie, occurrenceId);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ reason: string }>().reason).toBe(
      "occurrence-started",
    );
    // Still on the calendar, which is the half a filter on `startsAt` would have
    // silently taken away.
    await expect(
      ownViewOf(alfaCookie, occurrenceId),
    ).resolves.not.toBeUndefined();
  });
});

describe("standing down", () => {
  it("gives the place back to somebody else", async () => {
    const series = await publishedSeries({
      firstOn: dayAhead(40),
      capacity: 1,
    });
    const occurrenceId = onlyOccurrence(series);
    expect((await claim(alfaCookie, occurrenceId)).statusCode).toBe(200);
    expect((await claim(betaCookie, occurrenceId)).statusCode).toBe(409);

    const stoodDown = await withdraw(alfaCookie, occurrenceId);
    expect(stoodDown.statusCode).toBe(200);
    expect(stoodDown.json<AttendableOccurrenceView>()).toMatchObject({
      placesTaken: 0,
      placesLeft: 1,
    });

    // The place is free the moment the date is written, because the places taken
    // are the rows with no withdrawal date. Nothing was recomputed.
    const neighbour = await claim(betaCookie, occurrenceId);
    expect(neighbour.statusCode).toBe(200);
    expect(neighbour.json<AttendableOccurrenceView>().placesTaken).toBe(1);
  });

  it("keeps the withdrawal as a date rather than deleting the row", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(41) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    await withdraw(alfaCookie, occurrenceId);

    const row = await prisma.eventSignup.findUniqueOrThrow({
      where: {
        occurrenceId_personId: { occurrenceId, personId: alfa.personId },
      },
      select: { withdrawnAt: true },
    });
    expect(row.withdrawnAt).not.toBeNull();
    // And the caller's own state says so, so a screen can offer to sign up again
    // rather than pretending nothing ever happened.
    const own = await ownViewOf(alfaCookie, occurrenceId);
    expect(own?.own?.withdrawnAt).not.toBeNull();
    expect(own?.placesTaken).toBe(0);
  });

  it("reopens the same row when somebody changes their mind", async () => {
    // One person is one line on the roll-call, ever. A second row would be one
    // person counted twice against the places.
    const series = await publishedSeries({ firstOn: dayAhead(42) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);
    await withdraw(alfaCookie, occurrenceId);

    const again = await claim(alfaCookie, occurrenceId);

    expect(again.statusCode).toBe(200);
    expect(again.json<AttendableOccurrenceView>()).toMatchObject({
      placesTaken: 1,
    });
    expect(again.json<AttendableOccurrenceView>().own?.withdrawnAt).toBeNull();
    expect(
      await prisma.eventSignup.count({
        where: { occurrenceId, personId: alfa.personId },
      }),
    ).toBe(1);
  });

  it("takes a place at the back of the queue rather than keeping one in reserve", async () => {
    /*
     * Somebody who stood down has no claim on the place they gave up. Their
     * neighbour took it, and changing their mind is a new claim against a date
     * that is now full.
     */
    const series = await publishedSeries({
      firstOn: dayAhead(43),
      capacity: 1,
    });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);
    await withdraw(alfaCookie, occurrenceId);
    expect((await claim(betaCookie, occurrenceId)).statusCode).toBe(200);

    const again = await claim(alfaCookie, occurrenceId);

    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("occurrence-full");
  });

  it("refuses a second withdrawal, and one from somebody with no place", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(44) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);
    await withdraw(alfaCookie, occurrenceId);

    const twice = await withdraw(alfaCookie, occurrenceId);
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ reason: string }>().reason).toBe("already-withdrawn");

    const never = await withdraw(gammaCookie, occurrenceId);
    expect(never.statusCode).toBe(404);
    expect(never.json<{ reason: string }>().reason).toBe("signup-not-found");
  });

  it("lets somebody stand down after the board has taken the series down", async () => {
    /*
     * Publication decides who may take a place. It must not decide who may give
     * one back: a board that unpublished a series would otherwise hold everybody
     * standing on its dates to something they can no longer see on their own
     * calendar and cannot leave, with a request to the board as the only way out,
     * and their place would go on being counted the whole time.
     *
     * A date of a series nobody published is still answered as absent to somebody
     * with no row on it, which is the other half of the same promise. It is
     * asserted here rather than in a test of its own because the two answers are
     * the same request from two callers, and it is the pair that says the reason
     * this is allowed is the caller's own row and not the date.
     */
    const series = await publishedSeries({ firstOn: dayAhead(46) });
    const occurrenceId = onlyOccurrence(series);
    expect((await claim(alfaCookie, occurrenceId)).statusCode).toBe(200);

    const takenDown = await inject({
      method: "POST",
      url: `/api/events/${series.id}/publish`,
      payload: { published: false },
      headers: { cookie: boardCookie },
    });
    expect(takenDown.statusCode).toBe(201);
    // Off the calendar a resident reads, which is what makes a refusal here a
    // trap rather than an inconvenience.
    await expect(ownViewOf(alfaCookie, occurrenceId)).resolves.toBeUndefined();

    const stoodDown = await withdraw(alfaCookie, occurrenceId);

    expect(stoodDown.statusCode).toBe(200);
    const view = stoodDown.json<AttendableOccurrenceView>();
    expect(view.placesTaken).toBe(0);
    expect(view.own?.withdrawnAt).not.toBeNull();
    // And the place is genuinely back, on the board's own reading of the date.
    expect((await rollCall(occurrenceId)).placesTaken).toBe(0);

    const stranger = await withdraw(gammaCookie, occurrenceId);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json<{ reason: string }>().reason).toBe(
      "occurrence-not-found",
    );
  });

  it("lets the board stand somebody down and records whose place it was", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(45) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);
    const before = new Date();
    const roll = await rollCall(occurrenceId);
    const entry = roll.entries[0];
    if (entry === undefined) {
      throw new Error("The roll-call names nobody.");
    }

    const response = await inject({
      method: "POST",
      url: `/api/event-attendance/signups/${entry.signupId}/withdraw`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<RollCallView>().placesTaken).toBe(0);

    // The subject is the person whose place it was, whoever withdrew it, so
    // their own access report shows a withdrawal somebody else decided on.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "EVENT_SIGNUP_WITHDRAWN",
        targetId: entry.signupId,
        createdAt: { gte: before },
      },
      select: { actorPersonId: true, targetPersonId: true },
    });
    expect(entries).toEqual([
      { actorPersonId: board.personId, targetPersonId: alfa.personId },
    ]);
  });
});

describe("who is coming", () => {
  it("names nobody on the calendar a resident reads", async () => {
    /*
     * The whole of the promise, asserted at the boundary: which resident is going
     * to which of the association's dates is personal data no other resident is
     * shown, and the count is what somebody choosing needs.
     */
    const series = await publishedSeries({ firstOn: dayAhead(46) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    const response = await inject({
      method: "GET",
      url: "/api/event-signups",
      headers: { cookie: betaCookie },
    });
    const body = JSON.stringify(response.json());

    expect(response.statusCode).toBe(200);
    expect(body).not.toContain("Alfa");
    expect(body).not.toContain(alfa.personId);
    const own = response
      .json<AttendableOccurrenceView[]>()
      .find((entry) => entry.occurrenceId === occurrenceId);
    expect(own?.placesTaken).toBe(1);
    expect(own?.own).toBeNull();
  });

  it("names the attendees to whoever manages events", async () => {
    const series = await publishedSeries({ firstOn: dayAhead(47) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    const roll = await rollCall(occurrenceId);

    expect(roll.entries).toHaveLength(1);
    expect(roll.entries[0]?.attendee).toEqual({
      kind: "resident",
      personId: alfa.personId,
      name: "Alfa Boende",
    });
  });

  it("counts a protected person's place and names them to nobody", async () => {
    /*
     * The board's own address book prints these names, because the statutory
     * register has a reason to. A roll-call has none - and the place still has to
     * be counted, or the board would hand it to somebody else.
     */
    const series = await publishedSeries({
      firstOn: dayAhead(48),
      capacity: 2,
    });
    const occurrenceId = onlyOccurrence(series);
    expect((await claim(skyddadCookie, occurrenceId)).statusCode).toBe(200);

    const roll = await rollCall(occurrenceId);

    expect(roll.placesTaken).toBe(1);
    expect(roll.entries[0]?.attendee).toEqual({
      kind: "protected",
      personId: skyddad.personId,
    });
    expect(JSON.stringify(roll)).not.toContain("Signe");
    expect(JSON.stringify(roll)).not.toContain("Skyddad");
  });

  it("keeps the ones who stood down on the roll-call, with the date", async () => {
    // Somebody who never signed up and somebody who changed their mind are two
    // different answers, and the dated close is what keeps the second.
    const series = await publishedSeries({ firstOn: dayAhead(49) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);
    await claim(betaCookie, occurrenceId);
    await withdraw(alfaCookie, occurrenceId);

    const roll = await rollCall(occurrenceId);

    expect(roll.placesTaken).toBe(1);
    expect(roll.entries).toHaveLength(2);
    const stoodDown = roll.entries.find(
      (candidate) =>
        candidate.attendee.kind === "resident" &&
        candidate.attendee.personId === alfa.personId,
    );
    expect(stoodDown?.withdrawnAt).not.toBeNull();
  });
});

describe("the refusal to reshape a date people are standing on", () => {
  it("refuses the board's edit, names the date, and lifts once nobody holds it", async () => {
    /*
     * The seam between the two halves of this module, and the one property that
     * needs both. The refusal, the displaced set and their unit tests already
     * existed against a function that answered "nobody, ever"; this is the
     * assertion that the sign-up table is what it now answers from.
     */
    const firstOn = dayAhead(50);
    const series = await publishedSeries({ firstOn, capacity: 5 });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    const moved = await inject({
      method: "PUT",
      url: `/api/events/${series.id}`,
      payload: {
        title: series.title,
        description: series.description,
        category: series.category,
        location: series.location,
        signupOpen: true,
        capacity: 5,
        firstOn,
        // An hour earlier: the date stays, its instants move, so the row is
        // displaced and the sign-up pointing at it is what refuses the edit.
        startsAtMinute: 9 * 60,
        durationMinutes: 4 * 60,
        recurrence: null,
      },
      headers: { cookie: boardCookie },
    });

    expect(moved.statusCode).toBe(409);
    const refusal = moved.json<{ reason: string; dates: string[] }>();
    expect(refusal.reason).toBe("occurrence-in-use");
    // The association's own calendar, and never who signed up to it.
    expect(refusal.dates).toEqual([firstOn]);
    expect(JSON.stringify(refusal)).not.toContain(alfa.personId);
    expect(JSON.stringify(refusal)).not.toContain("Alfa");

    // Nothing moved.
    const unchanged = await prisma.eventOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      select: { startsAt: true },
    });

    await withdraw(alfaCookie, occurrenceId);

    const again = await inject({
      method: "PUT",
      url: `/api/events/${series.id}`,
      payload: {
        title: series.title,
        description: series.description,
        category: series.category,
        location: series.location,
        signupOpen: true,
        capacity: 5,
        firstOn,
        startsAtMinute: 9 * 60,
        durationMinutes: 4 * 60,
        recurrence: null,
      },
      headers: { cookie: boardCookie },
    });

    expect(again.statusCode).toBe(200);
    const afterwards = await prisma.eventOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      select: { startsAt: true },
    });
    // A withdrawal does not hold a date. The same edit, refused while somebody
    // was standing on it, goes through once nobody is - and the row keeps its id,
    // so it is the same date at a different time of day.
    expect(afterwards.startsAt.getTime()).toBeLessThan(
      unchanged.startsAt.getTime(),
    );
  });

  it("refuses removing a series while somebody holds a date, and allows it after", async () => {
    /*
     * The same rule read from the other end, and the answer to whether a
     * withdrawal should veto a removal: it must not. The rows are never deleted,
     * so a withdrawal that refused this would mean a series nobody is attending
     * could never be removed again - a dated close turned into a lock on the
     * calendar.
     */
    const series = await publishedSeries({ firstOn: dayAhead(51) });
    const occurrenceId = onlyOccurrence(series);
    await claim(alfaCookie, occurrenceId);

    const refused = await inject({
      method: "DELETE",
      url: `/api/events/${series.id}`,
      headers: { cookie: boardCookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ reason: string }>().reason).toBe("occurrence-in-use");

    await withdraw(alfaCookie, occurrenceId);

    const removed = await inject({
      method: "DELETE",
      url: `/api/events/${series.id}`,
      headers: { cookie: boardCookie },
    });
    expect(removed.statusCode).toBe(204);
    // The sign-up went with the date, which went with the series: a sign-up says
    // what it is only through the date it names.
    expect(await prisma.eventSignup.count({ where: { occurrenceId } })).toBe(0);
  });
});

describe("the association's own calendar date", () => {
  it("files a date starting after local midnight under the day the notice says", async () => {
    /*
     * The boundary day. Stockholm is an hour or two ahead of UTC all year, so a
     * date starting at half past midnight local always falls on the previous day
     * as an instant. A `on` derived from the instant - or from the series'
     * `firstOn` date column, which reads back as midnight UTC - would name the
     * day before on every screen and on the access report.
     */
    const firstOn = dayAhead(52);
    const series = await publishedSeries({
      firstOn,
      startsAtMinute: 30,
      title: `Midsommar ${suffix}`,
    });
    const occurrenceId = onlyOccurrence(series);

    const roll = await rollCall(occurrenceId);

    expect(roll.on).toBe(firstOn);
    // And the instant really is on the day before, which is what makes the
    // assertion above load-bearing rather than a tautology.
    expect(roll.startsAt.slice(0, 10)).toBe(dayBefore(firstOn));

    const own = await ownViewOf(alfaCookie, occurrenceId);
    expect(own?.on).toBe(firstOn);
  });
});

describe("the purge", () => {
  /**
   * A sign-up to a date that ended long enough ago to be erasable.
   *
   * Written directly rather than through the endpoint: a sign-up to a date in the
   * past is refused, which is the point of the refusal, and the row that has to
   * be purged is one made when the date was still ahead.
   */
  async function expiredSignup(personId: string, title: string) {
    const series = await prisma.event.create({
      data: {
        title,
        signupOpen: true,
        published: true,
        authorPersonId: board.personId,
        firstOn: new Date(Date.UTC(2020, 3, 18)),
        startsAtMinute: 10 * 60,
        durationMinutes: 4 * 60,
      },
      select: { id: true },
    });
    createdEventIds.push(series.id);

    const occurrence = await prisma.eventOccurrence.create({
      data: {
        eventId: series.id,
        startsAt: new Date("2020-04-18T08:00:00.000Z"),
        endsAt: new Date("2020-04-18T12:00:00.000Z"),
      },
      select: { id: true, endsAt: true },
    });
    const signup = await prisma.eventSignup.create({
      data: { occurrenceId: occurrence.id, personId },
      select: { id: true },
    });
    return { signupId: signup.id, occurrenceEndsAt: occurrence.endsAt };
  }

  it("erases a sign-up a year after the date it was for, and keeps a recent one", async () => {
    const expired = await expiredSignup(
      gamma.personId,
      `Gammal stadag ${suffix}`,
    );
    const recent = await publishedSeries({ firstOn: dayAhead(53) });
    const recentOccurrenceId = onlyOccurrence(recent);
    await claim(gammaCookie, recentOccurrenceId);

    // A day past the year, judged from the end of the date itself.
    const now = new Date(
      expired.occurrenceEndsAt.getTime() + 366 * MILLISECONDS_PER_DAY,
    );
    await expect(
      app.get(EventSignupPurgeService).eligible(now, 365),
    ).resolves.toContain(gamma.personId);

    await app.get(EventSignupPurgeService).run(now, 365);

    expect(
      await prisma.eventSignup.count({ where: { id: expired.signupId } }),
    ).toBe(0);
    // The date still to come is untouched: its own year has not started.
    expect(
      await prisma.eventSignup.count({
        where: { occurrenceId: recentOccurrenceId, personId: gamma.personId },
      }),
    ).toBe(1);

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "eventSignup",
        targetPersonId: gamma.personId,
      },
      select: { context: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toEqual({
      signups: 1,
      retentionDaysAfterOccurrence: 365,
    });
  });

  it("leaves a held person's sign-ups where they are", async () => {
    /*
     * The hold is about the person's data rather than about one table, so a
     * dispute that keeps somebody's contact details keeps the sign-ups that may
     * be what the dispute is about. Asserted beside somebody unheld with an
     * identically expired row, so the run is shown to have done its work and left
     * this one alone rather than having done nothing at all.
     */
    const heldRow = await expiredSignup(
      skyddad.personId,
      `Haallen stadag ${suffix}`,
    );
    const unheldRow = await expiredSignup(
      beta.personId,
      `Ohaallen stadag ${suffix}`,
    );
    await prisma.legalHold.create({
      data: {
        personId: skyddad.personId,
        reason: "En tvist om stadagen",
        placedByPersonId: board.personId,
      },
    });

    const now = new Date(
      heldRow.occurrenceEndsAt.getTime() + 366 * MILLISECONDS_PER_DAY,
    );
    await expect(
      app.get(EventSignupPurgeService).eligible(now, 365),
    ).resolves.not.toContain(skyddad.personId);

    await app.get(EventSignupPurgeService).run(now, 365);

    expect(
      await prisma.eventSignup.count({ where: { id: heldRow.signupId } }),
    ).toBe(1);
    expect(
      await prisma.eventSignup.count({ where: { id: unheldRow.signupId } }),
    ).toBe(0);

    /*
     * And the check inside the deleting transaction, which is the one that
     * counts. The scan above already leaves this person out, so a re-check that
     * had been dropped would never show up in a run - and a hold placed while a
     * run was in flight would erase exactly the rows it was placed to preserve.
     * Asked of the transaction directly, which is the only way to reach it.
     */
    await expect(
      app.get(EventSignupPurgeService).purgePerson(skyddad.personId, now, 365),
    ).resolves.toBe(0);
    expect(
      await prisma.eventSignup.count({ where: { id: heldRow.signupId } }),
    ).toBe(1);
  });
});
