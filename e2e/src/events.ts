import type { APIRequestContext } from "@playwright/test";

import { stack } from "./stack";

/**
 * The association's event calendar (evenemangskalendern), over HTTP.
 *
 * The screens are what the spec drives, because the screens are what the module
 * promises: a series entered and published to one audience or the other, a place
 * taken and given up again, a refusal read as a sentence, and a roll-call behind
 * the capability that exists for it. What lives here is the arrangement around
 * those.
 *
 * Three things are deliberately not done through a browser.
 *
 * A series a test signs up to has to exist before the test is about anything,
 * and entering one takes a form of thirteen fields. The board's own form has its
 * own coverage - it is photographed for a pull request, every refusal it can meet
 * is an integration spec, and the first test of the suite drives it end to end -
 * so arranging one here through the screen would make each test in the file pay
 * for a second sign-in and assert on a form it is not about.
 *
 * The sign-up somebody else already holds is the harder one, and the reason is
 * the behaviour under test. A date whose places are gone is drawn as a statement
 * rather than as a control, so a second resident cannot click it: reaching the
 * refusal at all means the last place has to go while the second reader's page is
 * open, which is exactly the race a resident meets in life. So those claims are
 * made from a context of their own, and what the browser then clicks is a control
 * that was offered when it was drawn.
 *
 * And what a refusal did not write is read back here rather than looked for on a
 * screen. "Nothing was recorded" is a claim about the instance, and a screen that
 * simply never drew the row would satisfy an assertion made against the page.
 *
 * Nothing here reads a roll-call. Who is coming is the one thing in this module
 * that names residents, and the assertion about it is what a board member is
 * shown - so it is made against the screen and nowhere else.
 */

/** Who a series is published to: the street, or the people with an account. */
export type EventVisibility = "PUBLIC" | "MEMBER";

/** How a series repeats, as a request states it and a response answers with it. */
export type EventRecurrence = {
  readonly frequency: "WEEKLY" | "MONTHLY" | "ANNUAL";
  readonly interval: number;
  /** How many occurrences in total, or null when the rule ends on a date. */
  readonly count: number | null;
  /** "YYYY-MM-DD", or null when the rule ends on a count. */
  readonly until: string | null;
};

/** One date in a series, as the board's own path answers with it. */
export type EventOccurrence = {
  readonly id: string;
  /** ISO instants. */
  readonly startsAt: string;
  readonly endsAt: string;
  /** "YYYY-MM-DD", the local date it falls on, as the API worked it out. */
  readonly on: string;
  readonly cancelledAt: string | null;
};

/** A series as the board reads it: drafts included. */
export type EventSeries = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly location: string | null;
  readonly visibility: EventVisibility;
  readonly published: boolean;
  readonly publishedAt: string | null;
  readonly signupOpen: boolean;
  /** Places at ONE occurrence. Null is no limit. */
  readonly capacity: number | null;
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  readonly firstOn: string;
  /** Minutes past local midnight, so 600 is 10:00. */
  readonly startsAtMinute: number;
  readonly durationMinutes: number;
  readonly recurrence: EventRecurrence | null;
  /** Every date in the series, earliest first, called-off ones included. */
  readonly occurrences: readonly EventOccurrence[];
};

/** What the board states about a series. Every field, every time. */
export type EventSeriesInput = {
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly location: string | null;
  readonly signupOpen: boolean;
  readonly capacity: number | null;
  readonly firstOn: string;
  readonly startsAtMinute: number;
  readonly durationMinutes: number;
  readonly recurrence: EventRecurrence | null;
};

/** The caller's own sign-up to one date, standing or stood down. */
export type OwnSignup = {
  readonly signupId: string;
  readonly signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  readonly withdrawnAt: string | null;
};

/**
 * One date, as somebody deciding whether to go is shown it.
 *
 * A count of the places and never a name. Who is coming is behind events:manage,
 * and there is no field on this shape for an attendee.
 */
export type AttendableOccurrence = {
  readonly occurrenceId: string;
  readonly eventId: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly location: string | null;
  /** ISO instants. */
  readonly startsAt: string;
  readonly endsAt: string;
  /** "YYYY-MM-DD", the local date it falls on, as the API worked it out. */
  readonly on: string;
  readonly cancelledAt: string | null;
  readonly signupOpen: boolean;
  readonly capacity: number | null;
  /** Standing sign-ups at this date, withdrawals not counted. */
  readonly placesTaken: number;
  /** Places still free, or null when there is no limit. */
  readonly placesLeft: number | null;
  readonly own: OwnSignup | null;
};

async function expectOk(
  response: {
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  },
  what: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${what} answered ${String(response.status())}: ${await response.text()}`,
    );
  }
}

/**
 * A series happening once, with sign-up open and a stated number of places.
 *
 * One date rather than a rule, because a test that asserts on a date has to name
 * which one, and a series of one date is the shape where "the cleaning day on the
 * 18th" is unambiguous. The recurrence generator has unit coverage across both
 * daylight saving transitions, which is where a rule belongs: reading its
 * hundredth date out of a browser would say nothing the generator's own tests do
 * not already say.
 *
 * The date is stated by the caller and never defaulted. Every date in this suite
 * is computed from the day the run happens, because the API refuses a sign-up to
 * a date that has begun and a date written into a file stops being in the future.
 */
export function signupSeries(input: {
  title: string;
  category: string;
  location: string;
  description: string;
  /** "YYYY-MM-DD" on the association's own clock. */
  firstOn: string;
  /** Minutes past local midnight, so 600 is 10:00. */
  startsAtMinute: number;
  durationMinutes: number;
  /** Places at the date. Null is no limit. */
  capacity: number | null;
}): EventSeriesInput {
  return {
    title: input.title,
    description: input.description,
    category: input.category,
    location: input.location,
    signupOpen: true,
    capacity: input.capacity,
    firstOn: input.firstOn,
    startsAtMinute: input.startsAtMinute,
    durationMinutes: input.durationMinutes,
    recurrence: null,
  };
}

/** Every series the board keeps, drafts included. */
async function listEventSeries(
  request: APIRequestContext,
): Promise<readonly EventSeries[]> {
  const response = await request.get(`${stack.baseUrl}/api/events`);
  await expectOk(response, "GET /api/events");
  return (await response.json()) as readonly EventSeries[];
}

/**
 * The one series with this title, or a failure naming it.
 *
 * Titles in this suite are unique to the run, so one title is one series. The
 * failure is named because the alternative is an assertion several lines later
 * about a page that never had anything on it: a series the test above was meant
 * to have entered is a broken chain and has to read as one.
 *
 * The caller's context has to be signed in as somebody holding events:manage.
 */
export async function eventSeriesTitled(
  request: APIRequestContext,
  title: string,
): Promise<EventSeries> {
  const found = (await listEventSeries(request)).filter(
    (series) => series.title === title,
  );
  const [series] = found;
  if (series === undefined) {
    throw new Error(`the board's calendar holds no series called ${title}`);
  }
  if (found.length > 1) {
    throw new Error(
      `the board's calendar holds ${String(found.length)} series called ${title}`,
    );
  }
  return series;
}

/**
 * Enters a series and publishes it, unless one by that title is already there.
 *
 * Looked up before it is written, because creating one is not idempotent and
 * every test in a file calls its fixture: unconditional creation would leave one
 * identical series per test per run on a calendar the suite cannot delete from
 * once anybody has signed up. The title is what settles it, and the specs make
 * theirs unique to the run for exactly that reason.
 *
 * Published as a second act, the way the API has it: saving a series does not
 * decide who may read it, and a series is for the members until somebody says
 * otherwise.
 *
 * The caller's context has to be signed in as somebody holding events:manage.
 */
export async function ensureEventSeries(
  request: APIRequestContext,
  input: EventSeriesInput,
  visibility: EventVisibility,
): Promise<EventSeries> {
  const already = (await listEventSeries(request)).find(
    (series) => series.title === input.title,
  );
  if (already !== undefined) {
    return already;
  }

  const created = await request.post(`${stack.baseUrl}/api/events`, {
    data: input,
  });
  await expectOk(created, "POST /api/events");
  const { id } = (await created.json()) as { id: string };

  const published = await request.post(
    `${stack.baseUrl}/api/events/${id}/publish`,
    { data: { published: true, visibility } },
  );
  await expectOk(published, "POST /api/events/:id/publish");
  return (await published.json()) as EventSeries;
}

/** The dates still to come, with this context's own place on each. */
async function upcomingOccurrences(
  request: APIRequestContext,
): Promise<readonly AttendableOccurrence[]> {
  const response = await request.get(`${stack.baseUrl}/api/event-signups`);
  await expectOk(response, "GET /api/event-signups");
  return (await response.json()) as readonly AttendableOccurrence[];
}

/**
 * The date of this series that this context is offered, or a failure naming it.
 *
 * The identifier comes from the answer rather than being carried in from the
 * board's own list, so a claim made here is made against the date the person
 * signing up is actually offered. A series of one date has one, and asserting
 * that keeps a series that quietly grew a second one from being claimed on by
 * whichever came back first.
 */
export async function offeredOccurrence(
  request: APIRequestContext,
  title: string,
): Promise<AttendableOccurrence> {
  const offered = (await upcomingOccurrences(request)).filter(
    (occurrence) => occurrence.title === title,
  );
  const [occurrence] = offered;
  if (occurrence === undefined) {
    throw new Error(`this reader is offered no date of ${title}`);
  }
  if (offered.length > 1) {
    throw new Error(
      `${title} offers ${String(offered.length)} dates, so there is no one date`,
    );
  }
  return occurrence;
}

/**
 * Takes a place at one date, and answers with the date as it then stands.
 *
 * The whole state of the date rather than the sign-up alone, which is what the
 * endpoint gives: the places gone and the caller's own row arrive together, so
 * an arrangement can assert on what it has just brought about without a second
 * read.
 */
export async function signUpFor(
  request: APIRequestContext,
  occurrenceId: string,
): Promise<AttendableOccurrence> {
  const response = await request.post(
    `${stack.baseUrl}/api/event-signups/${occurrenceId}`,
  );
  await expectOk(response, "POST /api/event-signups/:occurrenceId");
  return (await response.json()) as AttendableOccurrence;
}
