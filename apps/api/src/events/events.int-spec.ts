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
import type { EventView } from "./event.service";

/**
 * The event calendar against a real database.
 *
 * What a unit test cannot show, and nothing else.
 *
 * The occurrences are rows. A series entered through the API leaves one row per
 * date it falls on, they come back in order, and the database refuses a second
 * row for the same series and start instant - which is what stops an edit
 * offering a resident two identical dates to sign up to.
 *
 * The dates survive the round trip through their columns. `firstOn` is a
 * `@db.Date` and the two instants are not, and reading a date column back as an
 * instant is this codebase's recurring bug, so a series stated for the 18th of
 * April at ten in the morning has to come back saying exactly that.
 *
 * The capability is the whole gate. A resident and the property manager reach
 * none of it, and the board reaches all of it.
 *
 * Members only unless the board says otherwise: a series created without a word
 * about who it is for is not on the street.
 *
 * Editing rewrites what is still to come and leaves what has happened alone -
 * which needs occurrences on both sides of now, so this suite writes a past one
 * directly.
 *
 * Calling off one date leaves the rest standing, removing a series takes its
 * dates with it, and every act is in the audit log carrying facts and no free
 * text.
 *
 * The refusals that only exist at the endpoint: a personal identity number in a
 * published series, named by field and offset and never echoed, and a rule
 * reaching past the two years a calendar is written out for.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `ev-address-${suffix}`;
const apartmentId = `ev-apartment-${suffix}`;

const board = {
  personId: `ev-board-${suffix}`,
  email: `ev-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `ev-resident-${suffix}`,
  email: `ev-resident-${suffix}@exempel.se`,
};
const manager = {
  personId: `ev-manager-${suffix}`,
  email: `ev-manager-${suffix}@exempel.se`,
};
const actors = [board, resident, manager];
const personIds = actors.map((actor) => actor.personId);

/**
 * The series this suite creates through the API, whose ids are the server's.
 *
 * Collected so afterAll can delete them: an assertion failing before the end of
 * a test would otherwise leave a series behind in a database other suites share.
 */
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
        // 10.30.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.30.${String(subnet)}.${String(host + 1)}`,
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
 * The year every date this suite states falls in: the next one.
 *
 * Derived rather than written out, and that is the whole reason it exists. The
 * service freezes an occurrence the moment it starts, so three of the
 * assertions below - the two about what an edit rewrites and the one about a
 * called-off date surviving an edit around it - describe the reconciliation
 * only while their dates are still ahead of the clock. A year written out would
 * make those pass until it arrived and then fail on the calendar rather than on
 * a regression, which is the opposite of what a test is for.
 *
 * Next year is between three and fifteen months ahead whenever this runs, so
 * every date below is future by a wide margin.
 *
 * The month, the day and every instant asserted stay written out by hand. April,
 * May and June are inside summer time in every year, so ten in the morning in
 * Stockholm is 08:00 UTC on all of these dates whichever year they fall in -
 * which is what lets the expectations come from the calendar rather than from
 * the generator they are checking.
 */
const YEAR = new Date().getUTCFullYear() + 1;

/**
 * A year that is behind us, for the occurrence this suite writes directly.
 *
 * The reconciliation test needs a date on each side of now, and a series' own
 * rule cannot name a past one without its first date being past too. Last year
 * is between three and fifteen months behind whenever this runs.
 */
const PAST_YEAR = YEAR - 2;

/**
 * A cleaning day every week at ten in the morning, four hours long.
 *
 * April is inside summer time, so ten in the morning in Stockholm is 08:00 UTC -
 * which is what every instant asserted below is written out from. The weekly
 * step is seven calendar days, so which weekday the 18th falls on differs
 * between years and no assertion depends on it.
 */
const cleaningDay = {
  title: `Stadag ${suffix}`,
  description: "Ta med krattor och sacksaxar.",
  category: "Stadag",
  location: "Innergarden",
  signupOpen: true,
  capacity: 20,
  firstOn: `${String(YEAR)}-04-18`,
  startsAtMinute: 10 * 60,
  durationMinutes: 4 * 60,
  recurrence: { frequency: "WEEKLY", interval: 1, count: 3 },
};

/** Creates a series as the board, keeping its id for the cleanup. */
async function createSeries(payload: object): Promise<EventView> {
  const response = await inject({
    method: "POST",
    url: "/api/events",
    payload,
    headers: { cookie: boardCookie },
  });
  expect(response.statusCode).toBe(201);
  const created = response.json<EventView>();
  createdEventIds.push(created.id);
  return created;
}

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
      street: "Kalendergatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1201", floor: 4 },
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

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  if (prisma !== undefined) {
    /*
     * The series this run owns, resolved before anything is deleted.
     *
     * By title as well as by id: a test that failed an assertion before its own
     * cleanup line would otherwise leave a series behind, and the occurrences
     * cascade with it so both go together.
     */
    await prisma.event.deleteMany({
      where: {
        OR: [{ id: { in: createdEventIds } }, { title: { endsWith: suffix } }],
      },
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
    // assertion above selects on this run's target ids rather than on a count.
    if (associationCreatedHere) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
  }

  await app.close();
});

describe("entering a series", () => {
  it("writes out one row per date, in order, on the association's clock", async () => {
    const created = await createSeries(cleaningDay);

    expect(
      created.occurrences.map((occurrence) => occurrence.startsAt),
    ).toEqual([
      `${String(YEAR)}-04-18T08:00:00.000Z`,
      `${String(YEAR)}-04-25T08:00:00.000Z`,
      `${String(YEAR)}-05-02T08:00:00.000Z`,
    ]);
    expect(created.occurrences.map((occurrence) => occurrence.endsAt)).toEqual([
      `${String(YEAR)}-04-18T12:00:00.000Z`,
      `${String(YEAR)}-04-25T12:00:00.000Z`,
      `${String(YEAR)}-05-02T12:00:00.000Z`,
    ]);
    // The local date each one is filed under, which is what a calendar reads.
    expect(created.occurrences.map((occurrence) => occurrence.on)).toEqual([
      `${String(YEAR)}-04-18`,
      `${String(YEAR)}-04-25`,
      `${String(YEAR)}-05-02`,
    ]);

    // They are rows, not a computed answer.
    const rows = await prisma.eventOccurrence.count({
      where: { eventId: created.id },
    });
    expect(rows).toBe(3);
  });

  it("keeps the first date and the time of day as stated", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Datumrundtur ${suffix}`,
    });

    // The date column round trip: stated as the 18th, stored as a date, read
    // back as the 18th rather than as the evening before.
    expect(created.firstOn).toBe(`${String(YEAR)}-04-18`);
    expect(created.startsAtMinute).toBe(600);
    expect(created.durationMinutes).toBe(240);
    expect(created.recurrence).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      count: 3,
      until: null,
    });
  });

  it("is for the members unless the board says otherwise", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Medlemsdefault ${suffix}`,
    });

    expect(created.visibility).toBe("MEMBER");
    expect(created.published).toBe(false);
    expect(created.publishedAt).toBeNull();
  });

  it("is one date when it carries no rule", async () => {
    const created = await createSeries({
      title: `Engangsmote ${suffix}`,
      description: null,
      category: null,
      location: "Foreningslokalen",
      signupOpen: false,
      capacity: null,
      firstOn: `${String(YEAR)}-06-25`,
      startsAtMinute: 18 * 60,
      durationMinutes: 120,
      recurrence: null,
    });

    expect(created.recurrence).toBeNull();
    expect(created.occurrences).toHaveLength(1);
    expect(created.occurrences[0]?.startsAt).toBe(
      `${String(YEAR)}-06-25T16:00:00.000Z`,
    );
  });

  it("is in the audit log with the shape of the series and no free text", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Loggad ${suffix}`,
    });

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "EVENT_SERIES_CREATED",
        targetKind: "event",
        targetId: created.id,
      },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      occurrences: 3,
      firstOn: `${String(YEAR)}-04-18`,
      signupOpen: true,
    });
    // The title, the description, the category and the location are free text
    // belonging to a row with a lifecycle. A copy here would outlive it.
    expect(JSON.stringify(entry?.context)).not.toContain("Loggad");
    expect(JSON.stringify(entry?.context)).not.toContain("Innergarden");
  });

  it("refuses a rule reaching past the two years a calendar is written out for", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/events",
      payload: {
        ...cleaningDay,
        title: `For langt ${suffix}`,
        recurrence: {
          frequency: "WEEKLY",
          interval: 1,
          until: `${String(YEAR + 3)}-01-01`,
        },
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "recurrence-past-horizon",
    );
  });

  it("refuses a rule that states no end", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/events",
      payload: {
        ...cleaningDay,
        title: `Utan slut ${suffix}`,
        recurrence: { frequency: "WEEKLY", interval: 1 },
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe(
      "recurrence-end-required",
    );
  });
});

describe("the database's own rule", () => {
  it("refuses a second row for the same series and start instant", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Dubblett ${suffix}`,
      recurrence: null,
    });

    await expect(
      prisma.eventOccurrence.create({
        data: {
          eventId: created.id,
          startsAt: new Date(`${String(YEAR)}-04-18T08:00:00.000Z`),
          endsAt: new Date(`${String(YEAR)}-04-18T12:00:00.000Z`),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same instant in a different series", async () => {
    const first = await createSeries({
      ...cleaningDay,
      title: `Parallell A ${suffix}`,
      recurrence: null,
    });
    const second = await createSeries({
      ...cleaningDay,
      title: `Parallell B ${suffix}`,
      recurrence: null,
    });

    expect(first.occurrences[0]?.startsAt).toBe(
      second.occurrences[0]?.startsAt,
    );
  });
});

/**
 * The row-level rules of a series, asserted against the table and not the API.
 *
 * Every one of these is refused by the write service too, so each write below
 * goes round it - straight through the Prisma client, the way the seed, an
 * import or a later module would reach the table. That is the whole point of the
 * constraints: the service is not the only writer, and these four recurrence
 * columns mean nothing except by agreeing with each other.
 *
 * A CHECK violation surfaces as PostgreSQL 23514, which Prisma reports as P2010
 * with the constraint's own name in the message - so each assertion names the
 * constraint it is about rather than just "some write failed", and a test would
 * fail if the write were refused by a different rule than the one it means.
 */
describe("the database's own rules about a recurrence", () => {
  /** A valid series row, as the columns hold it, with no rule at all. */
  function row(overrides: Record<string, unknown>) {
    return {
      title: `Direkt ${suffix}`,
      authorPersonId: board.personId,
      firstOn: new Date(Date.UTC(YEAR, 3, 18)),
      startsAtMinute: 600,
      durationMinutes: 240,
      ...overrides,
    };
  }

  /** The constraint a direct write trips, or "" when it is allowed through. */
  async function violation(
    overrides: Record<string, unknown>,
  ): Promise<string> {
    try {
      const created = await prisma.event.create({
        data: row(overrides) as never,
        select: { id: true },
      });
      createdEventIds.push(created.id);
      return "";
    } catch (error) {
      return String((error as { message?: string }).message ?? error);
    }
  }

  it("takes a series with no rule at all", async () => {
    expect(await violation({})).toBe("");
  });

  it("takes a rule that states a count, and one that states a last date", async () => {
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceInterval: 1,
        recurrenceCount: 3,
      }),
    ).toBe("");
    expect(
      await violation({
        recurrenceFrequency: "MONTHLY",
        recurrenceInterval: 1,
        recurrenceUntil: new Date(Date.UTC(YEAR, 9, 18)),
      }),
    ).toBe("");
  });

  it("refuses a frequency with no end", async () => {
    // Exactly the row the API would answer as a rule whose end is absent.
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceInterval: 1,
      }),
    ).toContain("event_recurrence_states_one_end");
  });

  it("refuses a frequency with both ends", async () => {
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceInterval: 1,
        recurrenceCount: 3,
        recurrenceUntil: new Date(Date.UTC(YEAR, 9, 18)),
      }),
    ).toContain("event_recurrence_states_one_end");
  });

  it("refuses a frequency with no interval", async () => {
    // The API reads this row as having no rule while the row says it has one.
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceCount: 3,
      }),
    ).toContain("event_recurrence_states_one_end");
  });

  it("refuses an end with no frequency", async () => {
    expect(await violation({ recurrenceCount: 3 })).toContain(
      "event_recurrence_states_one_end",
    );
  });

  it("refuses an interval of nothing", async () => {
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceInterval: 0,
        recurrenceCount: 3,
      }),
    ).toContain("event_recurrence_interval_positive");
  });

  it("refuses a count of one, which repeats nothing", async () => {
    expect(
      await violation({
        recurrenceFrequency: "WEEKLY",
        recurrenceInterval: 1,
        recurrenceCount: 1,
      }),
    ).toContain("event_recurrence_count_repeats");
  });

  it("refuses a time of day outside the day", async () => {
    expect(await violation({ startsAtMinute: 1440 })).toContain(
      "event_starts_at_minute_within_the_day",
    );
    expect(await violation({ startsAtMinute: -1 })).toContain(
      "event_starts_at_minute_within_the_day",
    );
  });

  it("refuses a duration of nothing and one longer than a day", async () => {
    expect(await violation({ durationMinutes: 0 })).toContain(
      "event_duration_within_a_day",
    );
    expect(await violation({ durationMinutes: 1441 })).toContain(
      "event_duration_within_a_day",
    );
  });

  it("refuses a capacity of no places, and takes no capacity at all", async () => {
    expect(await violation({ capacity: 0 })).toContain(
      "event_capacity_positive",
    );
    expect(await violation({ capacity: null })).toBe("");
  });

  it("refuses an occurrence that ends before it starts", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Baklanges ${suffix}`,
      recurrence: null,
    });

    await expect(
      prisma.eventOccurrence.create({
        data: {
          eventId: created.id,
          startsAt: new Date(`${String(YEAR)}-05-09T08:00:00.000Z`),
          endsAt: new Date(`${String(YEAR)}-05-09T07:00:00.000Z`),
        },
      }),
    ).rejects.toThrow(/event_occurrence_ends_after_it_starts/);
  });
});

describe("who reaches the calendar", () => {
  it("refuses a resident, who is not the board", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/events",
      headers: { cookie: residentCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses the property manager, who does not arrange cleaning days", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/events",
      headers: { cookie: managerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a visitor with no session", async () => {
    const response = await inject({ method: "GET", url: "/api/events" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident writing one", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/events",
      payload: { ...cleaningDay, title: `Otillaten ${suffix}` },
      headers: { cookie: residentCookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("publishing a series", () => {
  it("records the publication and its audience, and stamps the date once", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Publicerad ${suffix}`,
    });

    const first = await inject({
      method: "POST",
      url: `/api/events/${created.id}/publish`,
      payload: { published: true, visibility: "PUBLIC" },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);
    const published = first.json<EventView>();
    expect(published.published).toBe(true);
    expect(published.visibility).toBe("PUBLIC");
    expect(published.publishedAt).not.toBeNull();

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "EVENT_SERIES_PUBLISHED",
        targetKind: "event",
        targetId: created.id,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry?.context).toEqual({
      published: true,
      visibility: "PUBLIC",
      occurrences: 3,
    });

    // Pressing it again changes nothing and writes nothing.
    const before = await prisma.auditLogEntry.count({
      where: { action: "EVENT_SERIES_PUBLISHED", targetId: created.id },
    });
    const again = await inject({
      method: "POST",
      url: `/api/events/${created.id}/publish`,
      payload: { published: true, visibility: "PUBLIC" },
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json<EventView>().publishedAt).toBe(published.publishedAt);
    expect(
      await prisma.auditLogEntry.count({
        where: { action: "EVENT_SERIES_PUBLISHED", targetId: created.id },
      }),
    ).toBe(before);
  });

  it("refuses a personal identity number, by field and offset and never by value", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Personnummer ${suffix}`,
      description: "Kontakta Anna, 811228-9874, om du undrar.",
    });

    const response = await inject({
      method: "POST",
      url: `/api/events/${created.id}/publish`,
      payload: { published: true },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      reason: string;
      locations: { field: string; offset: number }[];
    }>();
    expect(body.reason).toBe("personal-identity-number");
    expect(body.locations).toEqual([{ field: "description", offset: 15 }]);
    expect(response.body).not.toContain("811228");

    // Refused, so it is still a draft nobody can read.
    const row = await prisma.event.findUnique({
      where: { id: created.id },
      select: { published: true },
    });
    expect(row?.published).toBe(false);
  });
});

describe("editing a series", () => {
  it("rewrites what is still to come and leaves what has happened alone", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Omplanerad ${suffix}`,
      recurrence: null,
    });

    /*
     * A date behind us, written directly: the series' own rule cannot name one
     * without the first date being in the past too, and what is under test is
     * the reconciliation rather than the rule.
     */
    const past = await prisma.eventOccurrence.create({
      data: {
        eventId: created.id,
        startsAt: new Date(`${String(PAST_YEAR)}-05-10T08:00:00.000Z`),
        endsAt: new Date(`${String(PAST_YEAR)}-05-10T12:00:00.000Z`),
      },
      select: { id: true },
    });

    const response = await inject({
      method: "PUT",
      url: `/api/events/${created.id}`,
      payload: {
        ...cleaningDay,
        title: `Omplanerad ${suffix}`,
        // Nine in the morning instead of ten, and two dates instead of one.
        startsAtMinute: 9 * 60,
        recurrence: { frequency: "WEEKLY", interval: 1, count: 2 },
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json<EventView>();
    expect(
      updated.occurrences.map((occurrence) => [
        occurrence.on,
        occurrence.startsAt,
      ]),
    ).toEqual([
      // Untouched: it happened, at the time it happened.
      [
        `${String(PAST_YEAR)}-05-10`,
        `${String(PAST_YEAR)}-05-10T08:00:00.000Z`,
      ],
      // Moved to nine, keeping its row.
      [`${String(YEAR)}-04-18`, `${String(YEAR)}-04-18T07:00:00.000Z`],
      // New.
      [`${String(YEAR)}-04-25`, `${String(YEAR)}-04-25T07:00:00.000Z`],
    ]);
    expect(updated.occurrences[0]?.id).toBe(past.id);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "EVENT_SERIES_UPDATED",
        targetKind: "event",
        targetId: created.id,
      },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entry?.context).toEqual({
      changed: [
        "startsAtMinute",
        "recurrenceFrequency",
        "recurrenceInterval",
        "recurrenceCount",
      ],
      frequency: "WEEKLY",
      occurrencesMoved: 1,
      occurrencesDropped: 0,
      occurrencesAdded: 1,
    });
  });

  it("keeps the row a date sits on when only the time of day changes", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Samma rad ${suffix}`,
      recurrence: null,
    });
    const before = created.occurrences[0]?.id;

    const response = await inject({
      method: "PUT",
      url: `/api/events/${created.id}`,
      payload: {
        ...cleaningDay,
        title: `Samma rad ${suffix}`,
        startsAtMinute: 11 * 60,
        recurrence: null,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const after = response.json<EventView>().occurrences[0];
    // The same row, at a new time: a sign-up pointing at it survives the edit.
    expect(after?.id).toBe(before);
    expect(after?.startsAt).toBe(`${String(YEAR)}-04-18T09:00:00.000Z`);
  });
});

describe("calling off one date", () => {
  it("leaves the rest of the series standing", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Avbrutet tillfalle ${suffix}`,
    });
    const second = created.occurrences[1];

    const response = await inject({
      method: "POST",
      url: `/api/events/occurrences/${second?.id ?? ""}/cancel`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    const after = response.json<EventView>();
    expect(
      after.occurrences.map((occurrence) => occurrence.cancelledAt === null),
    ).toEqual([true, false, true]);
    // The row is still there, on the date it was.
    expect(after.occurrences[1]?.on).toBe(`${String(YEAR)}-04-25`);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "EVENT_OCCURRENCE_CANCELLED",
        targetKind: "eventOccurrence",
        targetId: second?.id,
      },
    });
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toEqual({
      eventId: created.id,
      on: `${String(YEAR)}-04-25`,
    });
  });

  it("refuses a date already called off", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Dubbelt avbrutet ${suffix}`,
      recurrence: null,
    });
    const only = created.occurrences[0]?.id ?? "";

    const first = await inject({
      method: "POST",
      url: `/api/events/occurrences/${only}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);

    const again = await inject({
      method: "POST",
      url: `/api/events/occurrences/${only}/cancel`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe(
      "occurrence-already-cancelled",
    );
  });

  it("keeps a called-off date called off when the series is edited around it", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Fortsatt avbrutet ${suffix}`,
    });
    const second = created.occurrences[1];

    await inject({
      method: "POST",
      url: `/api/events/occurrences/${second?.id ?? ""}/cancel`,
      headers: { cookie: boardCookie },
    });

    const response = await inject({
      method: "PUT",
      url: `/api/events/${created.id}`,
      payload: {
        ...cleaningDay,
        title: `Fortsatt avbrutet ${suffix}`,
        startsAtMinute: 12 * 60,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const after = response.json<EventView>().occurrences[1];
    // Moved with the rest, and still called off: the board's decision about
    // that date is not undone by a change to the series' time.
    expect(after?.id).toBe(second?.id);
    expect(after?.startsAt).toBe(`${String(YEAR)}-04-25T10:00:00.000Z`);
    expect(after?.cancelledAt).not.toBeNull();
  });
});

describe("removing a series", () => {
  it("takes its dates with it", async () => {
    const created = await createSeries({
      ...cleaningDay,
      title: `Borttagen ${suffix}`,
    });

    const response = await inject({
      method: "DELETE",
      url: `/api/events/${created.id}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(204);
    expect(
      await prisma.eventOccurrence.count({ where: { eventId: created.id } }),
    ).toBe(0);
    expect(await prisma.event.count({ where: { id: created.id } })).toBe(0);
  });

  it("records taking a published series down, and says nothing about a draft", async () => {
    const draft = await createSeries({
      ...cleaningDay,
      title: `Utkast bort ${suffix}`,
      recurrence: null,
    });
    await inject({
      method: "DELETE",
      url: `/api/events/${draft.id}`,
      headers: { cookie: boardCookie },
    });
    expect(
      await prisma.auditLogEntry.count({ where: { targetId: draft.id } }),
    ).toBe(1);

    const announced = await createSeries({
      ...cleaningDay,
      title: `Publicerad bort ${suffix}`,
      recurrence: null,
    });
    await inject({
      method: "POST",
      url: `/api/events/${announced.id}/publish`,
      payload: { published: true },
      headers: { cookie: boardCookie },
    });
    await inject({
      method: "DELETE",
      url: `/api/events/${announced.id}`,
      headers: { cookie: boardCookie },
    });

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "EVENT_SERIES_PUBLISHED",
        targetId: announced.id,
      },
      orderBy: [{ createdAt: "asc" }],
    });
    expect(entries).toHaveLength(2);
    expect(entries[1]?.context).toEqual({
      published: false,
      deleted: true,
      visibility: "MEMBER",
      occurrences: 1,
    });
  });
});

describe("a date that is not a date", () => {
  it("is refused as its own mistake and not as a complaint about the rule", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/events",
      payload: {
        ...cleaningDay,
        title: `Omojligt datum ${suffix}`,
        // The 30th of February, which Date.parse would silently read as March.
        firstOn: `${String(YEAR)}-02-30`,
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ reason: string }>().reason).toBe("invalid-date");
  });
});
