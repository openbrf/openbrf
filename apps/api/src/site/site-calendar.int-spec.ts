import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import {
  dateColumnOf,
  instantAt,
  type LocalDay,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  calendarMonthOf,
  formatCalendarMonth,
  shiftCalendarMonth,
  SiteEventsService,
} from "./site-events.service";

/**
 * The association's calendar on its public website, against a real database and
 * through the real routing.
 *
 * The unit tests hold what a date renders as. This suite holds who is answered
 * with which dates, which is the part no rendering test can show, and every
 * assertion in it is a promise to somebody with no account:
 *
 *   An event the board published to the street is on the calendar for everybody.
 *   One published to the members is not, and neither is a draft.
 *
 *   A members-only event asked for by its own address answers with the website's
 *   own not-found document, byte for byte the same one an address naming nothing
 *   produces. That is the whole point of the service returning one null: an
 *   attacker holding a list of identifiers must not be able to tell an event
 *   that exists and is closed to them from one that does not exist.
 *
 *   How many places are gone is on the page. Who has taken them never is, and
 *   the person who signed up here carries a surname nothing else in the database
 *   holds, so an assertion that it is absent is an assertion about this page.
 *
 *   The page runs no script, sets no cookie and names no host but this one.
 *
 *   Nothing on the payload says who an event was published to. Who may read one
 *   is decided from whether the request carried a session and from nothing else,
 *   which is what keeps that rule in one place; a field describing audiences
 *   would be a second answer for the two to disagree on. The application's own
 *   calendar carries it, for a reader already entitled to both, and this one
 *   does not.
 *
 * The month arithmetic is the other half, and the assertion worth breaking the
 * implementation for is the one about the first of the month: an event at half
 * past midnight local time is 22:30 or 23:30 UTC on the day before, so a month
 * window computed in UTC would file it under the wrong month. It is asserted in
 * both directions - in the month it belongs to, and absent from the one before.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const member = {
  personId: `cal-member-${suffix}`,
  email: `cal-member-${suffix}@exempel.se`,
};
/** Signed up to the public cleaning day, and named nowhere on the website. */
const attendee = { personId: `cal-attendee-${suffix}` };
const ATTENDEE_SURNAME = `Anmald${suffix}`;
/** Signed up and stood down again, so their place is free and uncounted. */
const withdrawn = { personId: `cal-withdrawn-${suffix}` };
const WITHDRAWN_SURNAME = `Avanmald${suffix}`;

const personIds = [member.personId, attendee.personId, withdrawn.personId];

/*
 * The board's own words, non-ASCII included: the association's content is stored
 * as written and never translated, and a title that survives the round trip
 * through the renderer is part of what this suite says.
 */
const PUBLIC_TITLE = `Städdag ${suffix}`;
const MEMBER_TITLE = `Styrelsemöte ${suffix}`;
const DRAFT_TITLE = `Utkast ${suffix}`;
const BOUNDARY_TITLE = `Midnattsvandring ${suffix}`;
const THIS_MONTH_TITLE = `Innevarande ${suffix}`;
const LOCATION = `Innergården ${suffix}`;

const pageSlug = `cal-page-${suffix}`;

/** The months this suite arranges its fixtures in, relative to the run. */
const currentMonth = calendarMonthOf(new Date());
/** Far enough out to be empty of anything else, well inside the clamp. */
const fixtureMonth = shiftCalendarMonth(currentMonth, 6);
const monthBefore = shiftCalendarMonth(currentMonth, 5);

const eventIds = {
  public: `cal-public-${suffix}`,
  member: `cal-member-event-${suffix}`,
  draft: `cal-draft-${suffix}`,
  boundary: `cal-boundary-${suffix}`,
  thisMonth: `cal-this-month-${suffix}`,
};

/**
 * A distinct forwarded address per request, inside this suite's own block.
 *
 * The auth rate limiter buckets by forwarded address, so a repeat would make one
 * suite's requests count against another's budget. 10.36.0.0/16 is this suite's;
 * the other integration suites each hold their own second octet, and 10.35 is
 * taken by a branch in flight beside this one.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return `10.36.${String(subnet)}.${String(host + 1)}`;
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
        // Fixed, so two responses compared for equality were rendered in the
        // same language and differ only where the test says they do.
        "accept-language": "sv-SE,sv;q=0.9",
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

/** The instant a local time of day on one calendar date names. */
function at(day: LocalDay, minuteOfDay: number): Date {
  const instant = instantAt(day, minuteOfDay);
  if (instant === null) {
    throw new Error("The fixture asked for a local time that does not happen.");
  }
  return instant;
}

/** One day of a month, as the fixtures name their dates. */
function on(month: { year: number; month: number }, day: number): LocalDay {
  return { ...month, day };
}

/** One month of the calendar, as one reader gets it. No cookie is a visitor. */
async function monthAs(
  month: { year: number; month: number },
  cookie?: string,
): Promise<string> {
  const response = await inject({
    method: "GET",
    url: `/kalender?manad=${formatCalendarMonth(month)}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/**
 * A series with one date, written straight to the database.
 *
 * Written rather than posted, because what this suite is about is who the
 * website answers with which dates: the write path, the recurrence generator and
 * the audit entries are held by the events module's own suites. Every field is
 * set to what that path would have set, the occurrence's instants included -
 * derived from the same conversion, so a fixture cannot disagree with the
 * calendar about what "half past midnight" means.
 */
async function series(input: {
  id: string;
  title: string;
  visibility: "PUBLIC" | "MEMBER";
  published: boolean;
  day: LocalDay;
  startsAtMinute: number;
  durationMinutes: number;
  signupOpen?: boolean;
  capacity?: number | null;
  location?: string | null;
}): Promise<void> {
  await prisma.event.create({
    data: {
      id: input.id,
      title: input.title,
      location: input.location ?? null,
      visibility: input.visibility,
      published: input.published,
      publishedAt: input.published ? new Date() : null,
      signupOpen: input.signupOpen ?? false,
      capacity: input.capacity ?? null,
      authorPersonId: member.personId,
      firstOn: dateColumnOf(input.day),
      startsAtMinute: input.startsAtMinute,
      durationMinutes: input.durationMinutes,
      occurrences: {
        create: {
          startsAt: at(input.day, input.startsAtMinute),
          endsAt: at(input.day, input.startsAtMinute + input.durationMinutes),
        },
      },
    },
  });
}

let memberCookie: string;
let publicOccurrenceId: string;

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

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      { id: member.personId, firstName: "Signe", lastName: `Cal${suffix}` },
      {
        id: attendee.personId,
        firstName: "Alva",
        lastName: ATTENDEE_SURNAME,
      },
      {
        id: withdrawn.personId,
        firstName: "Vera",
        lastName: WITHDRAWN_SURNAME,
      },
    ],
  });
  await app.get(AuthService).createAccountForPerson({
    personId: member.personId,
    email: member.email,
    name: "Signe Medlem",
    password: PASSWORD,
  });

  /*
   * The members' meeting is the 12th and the public cleaning day the 13th, and
   * that order is deliberate. The calendar block on a page takes the soonest
   * dates, so a visitor who is shown the 13th would necessarily have been shown
   * the 12th had it been theirs to see - which is what makes the assertion that
   * it is absent an assertion about the audience rather than about a cut-off.
   */
  await series({
    id: eventIds.member,
    title: MEMBER_TITLE,
    visibility: "MEMBER",
    published: true,
    day: on(fixtureMonth, 12),
    startsAtMinute: 18 * 60,
    durationMinutes: 120,
  });
  await series({
    id: eventIds.public,
    title: PUBLIC_TITLE,
    visibility: "PUBLIC",
    published: true,
    day: on(fixtureMonth, 13),
    startsAtMinute: 10 * 60,
    durationMinutes: 180,
    signupOpen: true,
    capacity: 2,
    location: LOCATION,
  });
  await series({
    id: eventIds.draft,
    title: DRAFT_TITLE,
    visibility: "PUBLIC",
    published: false,
    day: on(fixtureMonth, 14),
    startsAtMinute: 10 * 60,
    durationMinutes: 60,
  });
  /*
   * Half past midnight on the first of the month, which is the evening before in
   * UTC. The one fixture in here that is about arithmetic rather than about
   * disclosure.
   */
  await series({
    id: eventIds.boundary,
    title: BOUNDARY_TITLE,
    visibility: "PUBLIC",
    published: true,
    day: on(fixtureMonth, 1),
    startsAtMinute: 30,
    durationMinutes: 60,
  });
  // The 15th of the current month, for the address with no parameter on it.
  await series({
    id: eventIds.thisMonth,
    title: THIS_MONTH_TITLE,
    visibility: "PUBLIC",
    published: true,
    day: on(currentMonth, 15),
    startsAtMinute: 12 * 60,
    durationMinutes: 60,
  });

  // A second date of the cleaning day, called off. The board announced it, so it
  // stays on the calendar saying that it is off.
  await prisma.eventOccurrence.create({
    data: {
      eventId: eventIds.public,
      startsAt: at(on(fixtureMonth, 20), 10 * 60),
      endsAt: at(on(fixtureMonth, 20), 13 * 60),
      cancelledAt: new Date(),
    },
  });

  const claimed = await prisma.eventOccurrence.findFirstOrThrow({
    where: { eventId: eventIds.public, cancelledAt: null },
    select: { id: true },
  });
  publicOccurrenceId = claimed.id;

  await prisma.eventSignup.createMany({
    data: [
      { occurrenceId: publicOccurrenceId, personId: attendee.personId },
      {
        occurrenceId: publicOccurrenceId,
        personId: withdrawn.personId,
        withdrawnAt: new Date(),
      },
    ],
  });

  // One page carrying the calendar block, public, so the visitor and the member
  // below are rendering the same stored body.
  await prisma.page.create({
    data: {
      slug: pageSlug,
      title: "Valkommen",
      content: {
        version: 1,
        blocks: [{ type: "eventCalendar", count: 10 }],
      },
      visibility: "PUBLIC",
      published: true,
      publishedAt: new Date(),
      sortOrder: 900,
    },
  });

  memberCookie = await signIn(member.email);
}, 180_000);

/**
 * Runs every cleanup step, then reports whichever of them failed.
 *
 * One step must not be able to stop the next: this database is shared with the
 * other integration suites, so a row this one leaves behind turns up later as a
 * stranger in a suite that scans the person table.
 */
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
      "The site calendar suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () => prisma.page.deleteMany({ where: { slug: pageSlug } }),
        // The occurrences and their sign-ups go with the series, by the
        // cascades on both relations.
        () =>
          prisma.event.deleteMany({
            where: { id: { in: Object.values(eventIds) } },
          }),
        () => prisma.user.deleteMany({ where: { personId: member.personId } }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("what an anonymous visitor gets from the calendar", () => {
  it("serves the month as plain HTML, with the headers a page carries", async () => {
    const response = await inject({ method: "GET", url: "/kalender" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body.startsWith("<!doctype html>")).toBe(true);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
        "font-src 'self'; form-action 'self'",
    );
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["vary"]).toBe("cookie");
  });

  it("runs no script, sets no cookie and names no host but this one", async () => {
    for (const url of [
      "/kalender",
      `/kalender?manad=${formatCalendarMonth(fixtureMonth)}`,
      `/kalender/${eventIds.public}`,
      `/kalender/${eventIds.member}`,
      "/kalender/finns-inte",
    ]) {
      const response = await inject({ method: "GET", url });

      expect(response.headers["set-cookie"], url).toBeUndefined();
      expect(response.body.includes("<script"), url).toBe(false);
      expect(/\son[a-z]+=/i.test(response.body), url).toBe(false);
      // The typefaces are the risk: a stylesheet naming a font host would
      // disclose every visitor's address to that host on every page view.
      expect(/(?:src|href|url\()\s*"?https?:/i.test(response.body), url).toBe(
        false,
      );
    }
  });

  it("lists what the board published to the street and nothing else", async () => {
    const body = await monthAs(fixtureMonth);

    expect(body).toContain(PUBLIC_TITLE);
    expect(body).toContain(LOCATION);
    // A series published to the members, and a draft. Neither is anybody's to
    // read from the street, and the calendar says nothing about either.
    expect(body.includes(MEMBER_TITLE)).toBe(false);
    expect(body.includes(DRAFT_TITLE)).toBe(false);
  });

  it("says that a date the board called off is off", async () => {
    const body = await monthAs(fixtureMonth);

    expect(body).toContain("Inställt");
  });

  it("shows the current month when the address carries no parameter", async () => {
    const response = await inject({ method: "GET", url: "/kalender" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(THIS_MONTH_TITLE);
  });
});

describe("what a signed-in member gets", () => {
  it("sees the members' events among the public ones", async () => {
    const body = await monthAs(fixtureMonth, memberCookie);

    expect(body).toContain(MEMBER_TITLE);
    expect(body).toContain(PUBLIC_TITLE);
    // A draft is nobody's, session or no session.
    expect(body.includes(DRAFT_TITLE)).toBe(false);
  });

  it("is not handed a cookie for having read the calendar", async () => {
    // Better Auth can refresh a session row on a read, and copying its headers
    // onto the reply would turn the public website into something that sets
    // cookies.
    const response = await inject({
      method: "GET",
      url: "/kalender",
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});

describe("an event nobody may read", () => {
  it("is byte-identical to an event that does not exist", async () => {
    const closed = await inject({
      method: "GET",
      url: `/kalender/${eventIds.member}`,
    });
    const missing = await inject({
      method: "GET",
      url: "/kalender/finns-inte",
    });
    const draft = await inject({
      method: "GET",
      url: `/kalender/${eventIds.draft}`,
    });
    const page = await inject({
      method: "GET",
      url: "/en-sida-som-inte-finns",
    });

    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(draft.statusCode).toBe(404);
    /*
     * The whole guarantee, in three assertions. Anything that made these differ
     * - a title, a length, a header - would tell somebody holding a list of
     * identifiers which of them the association has an event behind. The page
     * route's own not-found is in the comparison as well, because the website
     * has exactly one refusal and this is where a second one would show up.
     */
    expect(closed.body).toBe(missing.body);
    expect(draft.body).toBe(missing.body);
    expect(page.body).toBe(missing.body);
    expect(closed.body.includes(MEMBER_TITLE)).toBe(false);
  });

  it("opens for a signed-in member", async () => {
    const response = await inject({
      method: "GET",
      url: `/kalender/${eventIds.member}`,
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(MEMBER_TITLE);
  });

  it("answers an identifier that is not shaped like one the same way", async () => {
    const malformed = await inject({
      method: "GET",
      url: "/kalender/INTE%20ETT%20ID",
    });

    expect(malformed.statusCode).toBe(404);
  });
});

describe("what the calendar says about who is coming", () => {
  it("is a count of the places taken, and never a name", async () => {
    const body = await monthAs(fixtureMonth);

    // One standing sign-up out of two places. The withdrawal does not hold a
    // place, so it is not counted - and neither person is named.
    expect(body).toContain("1 av 2 platser tagna");
    expect(body.includes(ATTENDEE_SURNAME)).toBe(false);
    expect(body.includes(WITHDRAWN_SURNAME)).toBe(false);
  });

  it("names nobody on the event's own page either", async () => {
    const response = await inject({
      method: "GET",
      url: `/kalender/${eventIds.public}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(PUBLIC_TITLE);
    expect(response.body).toContain("1 av 2 platser tagna");
    expect(response.body.includes(ATTENDEE_SURNAME)).toBe(false);
    expect(response.body.includes(WITHDRAWN_SURNAME)).toBe(false);
  });
});

describe("what the payload the website is built from carries", () => {
  it("says nothing about who an event was published to", async () => {
    /*
     * Asserted on the whole key set rather than on the absence of one name, so a
     * field called `visibility`, `audience` or anything else fails here. The
     * audience is a fact about the association's own decision and the website's
     * answer is built from one question - whether the request carried a session -
     * which is what keeps that rule in a single line of a single query.
     *
     * The application's own calendar does carry it: a resident who may read the
     * members' events and the public ones both cannot otherwise tell which is in
     * front of them. That is a different answer to a different audience, and
     * `AttendableOccurrenceView` is where it lives.
     */
    const page = await app
      .get(SiteEventsService)
      .month(true, formatCalendarMonth(fixtureMonth));

    expect(page.dates.length).toBeGreaterThan(0);
    for (const date of page.dates) {
      expect(Object.keys(date).sort()).toEqual([
        "cancelled",
        "capacity",
        "category",
        "endsAt",
        "eventId",
        "location",
        "placesTaken",
        "signupOpen",
        "startsAt",
        "title",
      ]);
    }
  });
});

describe("the month a parameter asks for", () => {
  it("files a date after local midnight under the month it falls in", async () => {
    /*
     * Half past midnight on the first, which is 22:30 or 23:30 UTC the evening
     * before. A window computed in UTC would put this date in the month before,
     * so both directions are asserted: it is in its own month and it is not in
     * the one before.
     */
    expect(await monthAs(fixtureMonth)).toContain(BOUNDARY_TITLE);
    expect((await monthAs(monthBefore)).includes(BOUNDARY_TITLE)).toBe(false);
  });

  it("offers the months either side as plain anchors", async () => {
    const body = await monthAs(fixtureMonth);

    expect(body).toContain(
      `href="/kalender?manad=${formatCalendarMonth(monthBefore)}"`,
    );
    expect(body).toContain(
      `href="/kalender?manad=${formatCalendarMonth(shiftCalendarMonth(fixtureMonth, 1))}"`,
    );
  });

  it("is pulled to the far edge of the span rather than refused", async () => {
    const response = await inject({
      method: "GET",
      url: "/kalender?manad=2099-01",
    });

    expect(response.statusCode).toBe(200);
    // The last month the calendar reaches: its prev anchor is the month before
    // it, and there is no next anchor at all.
    expect(response.body).toContain(
      `href="/kalender?manad=${formatCalendarMonth(shiftCalendarMonth(currentMonth, 23))}"`,
    );
    expect(response.body.includes('rel="next"')).toBe(false);
  });

  it("is pulled to the near edge the same way", async () => {
    const response = await inject({
      method: "GET",
      url: "/kalender?manad=1900-01",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `href="/kalender?manad=${formatCalendarMonth(shiftCalendarMonth(currentMonth, -11))}"`,
    );
    expect(response.body.includes('rel="prev"')).toBe(false);
  });

  it("leaves the reader on the current month when it is not a month at all", async () => {
    for (const value of ["april", "2099", "2026-4", "2026-13", "2026-04-18"]) {
      const response = await inject({
        method: "GET",
        url: `/kalender?manad=${value}`,
      });

      expect(response.statusCode, value).toBe(200);
      expect(response.body, value).toContain(THIS_MONTH_TITLE);
    }
  });

  it("takes neither value when the parameter arrives twice", async () => {
    // A caller sending the same name twice is not a browser following a link
    // this page printed.
    const response = await inject({
      method: "GET",
      url: `/kalender?manad=${formatCalendarMonth(fixtureMonth)}&manad=${formatCalendarMonth(monthBefore)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(THIS_MONTH_TITLE);
  });
});

describe("a page carrying the calendar block", () => {
  it("shows a visitor the public dates and a member theirs as well", async () => {
    const asVisitor = await inject({ method: "GET", url: `/${pageSlug}` });
    const asMember = await inject({
      method: "GET",
      url: `/${pageSlug}`,
      headers: { cookie: memberCookie },
    });

    expect(asVisitor.statusCode).toBe(200);
    expect(asMember.statusCode).toBe(200);
    expect(asVisitor.body).toContain(PUBLIC_TITLE);
    expect(asMember.body).toContain(PUBLIC_TITLE);
    /*
     * One stored page, two readers, two answers. The members' meeting is the
     * earlier of the two dates, so a visitor shown the later one would have
     * been shown this one first if it were theirs to see.
     */
    expect(asVisitor.body.includes(MEMBER_TITLE)).toBe(false);
    expect(asMember.body).toContain(MEMBER_TITLE);
    // And the way to the rest of the calendar.
    expect(asVisitor.body).toContain('href="/kalender"');
  });
});
