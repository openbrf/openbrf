import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { occurrencesWithSignups } from "./event-attendance";
import { type EventInput, EventService } from "./event.service";

/**
 * What the write path refuses, and what it does not.
 *
 * Two rules live here rather than in the integration suite, because both are
 * about a decision the service takes before it writes anything and neither needs
 * a database to be true.
 *
 * The first is the refusal to move a date people are standing on. The one
 * question the service cannot answer itself - which occurrences somebody has
 * signed up to - is asked through `event-attendance.ts` and is stubbed here, so
 * that what is exercised is the refusal rather than a query. The query itself is
 * `event-attendance.spec.ts`, including the rule that a withdrawal does not hold
 * a date, and the two together against a database are `event-signups.int-spec.ts`.
 *
 * The second is the personal-identity-number scan. A published series is scanned
 * on every edit, because an edit to something already published is itself a
 * publication; a draft is not, because nothing it holds is readable by anyone.
 *
 * The third is the board list's window: what it refuses, and the period it asks
 * the database for. What a windowed read actually returns is a question for a
 * database and is `events.int-spec.ts`.
 *
 * The fourth is the reinstatement, which is here for the half a database cannot
 * show: what it refuses, that the clearing is conditional, and that it touches
 * no sign-up at all. The fake client's sign-up table throws on every method, so
 * that last one is structural rather than an assertion about a row.
 *
 * What the plan does date by date is `occurrence-plan.spec.ts`, the rule itself
 * is `recurrence.spec.ts`, and what the database does about any of it is
 * `events.int-spec.ts`.
 */

vi.mock("./event-attendance", () => ({
  occurrencesWithSignups: vi.fn(async () => new Set<string>()),
}));

const held = vi.mocked(occurrencesWithSignups);

/**
 * What the transaction asked the database, in the order it asked.
 *
 * The lock and the read that rests on it are only correct in one order, and
 * neither call says so on its own - so the ordering is recorded rather than
 * inferred from two separate assertions that a call happened.
 */
const calls: string[] = [];

/**
 * Makes those ids the ones somebody has signed up to.
 *
 * The stub answers with the intersection rather than with the whole set,
 * because that is what the query replacing it will do: it is asked about a set
 * of occurrences and answers about those. A stub that ignored its argument
 * would let a test pass while the service asked about the wrong dates - or
 * about none.
 */
function signedUpTo(...occurrenceIds: readonly string[]): void {
  held.mockImplementation(async (_db, requested) => {
    calls.push("read-signups");
    return new Set(requested.filter((id) => occurrenceIds.includes(id)));
  });
}

/** A weekly Sunday series at ten in the morning, as the board states it. */
const AS_STATED: EventInput = {
  title: "Stadag",
  description: "Ta med krattor.",
  category: "Stadag",
  location: "Innergarden",
  signupOpen: true,
  capacity: 20,
  firstOn: { year: 2027, month: 4, day: 18 },
  startsAtMinute: 10 * 60,
  durationMinutes: 4 * 60,
  recurrence: { frequency: "WEEKLY", interval: 1, count: 3, until: null },
};

/**
 * The three dates that series falls on, as they stand in the table.
 *
 * Written out by hand: April 2027 is inside summer time, so ten in the morning
 * in Stockholm is 08:00 UTC.
 */
const STORED_OCCURRENCES = [
  {
    id: "occurrence-18",
    startsAt: new Date("2027-04-18T08:00:00.000Z"),
    endsAt: new Date("2027-04-18T12:00:00.000Z"),
    cancelledAt: null,
  },
  {
    id: "occurrence-25",
    startsAt: new Date("2027-04-25T08:00:00.000Z"),
    endsAt: new Date("2027-04-25T12:00:00.000Z"),
    cancelledAt: null,
  },
  {
    id: "occurrence-02",
    startsAt: new Date("2027-05-02T08:00:00.000Z"),
    endsAt: new Date("2027-05-02T12:00:00.000Z"),
    cancelledAt: null,
  },
];

function storedEvent(
  published: boolean,
  title = AS_STATED.title,
  cancelledOccurrenceId?: string,
) {
  return {
    id: "event-1",
    title,
    description: AS_STATED.description,
    category: AS_STATED.category,
    location: AS_STATED.location,
    visibility: "MEMBER" as const,
    published,
    publishedAt: published ? new Date("2027-03-01T09:00:00.000Z") : null,
    signupOpen: AS_STATED.signupOpen,
    capacity: AS_STATED.capacity,
    firstOn: new Date(Date.UTC(2027, 3, 18)),
    startsAtMinute: AS_STATED.startsAtMinute,
    durationMinutes: AS_STATED.durationMinutes,
    recurrenceFrequency: "WEEKLY" as const,
    recurrenceInterval: 1,
    recurrenceCount: 3,
    recurrenceUntil: null,
    _count: { occurrences: STORED_OCCURRENCES.length },
    occurrences: STORED_OCCURRENCES.map((occurrence) =>
      occurrence.id === cancelledOccurrenceId
        ? { ...occurrence, cancelledAt: new Date("2027-04-01T09:00:00.000Z") }
        : occurrence,
    ),
  };
}

/**
 * The service over a fake client, with the clock left alone.
 *
 * The stored dates are in 2027 and every assertion is about the future, so the
 * "already started" half of the plan is not in play here - `occurrence-plan.spec.ts`
 * takes its own clock and covers that.
 */
function build(
  options: {
    published?: boolean;
    cancelledOccurrenceId?: string;
    /** The row a reinstatement or a call-off reads. Defaults to CALLED_OFF. */
    occurrence?: {
      id: string;
      eventId: string;
      startsAt: Date;
      cancelledAt: Date | null;
    };
    /** True to make the conditional clearing match nothing, as a race would. */
    reinstatedElsewhere?: boolean;
  } = {},
) {
  const row = storedEvent(
    options.published ?? false,
    AS_STATED.title,
    options.cancelledOccurrenceId,
  );

  const tx = {
    // The advisory lock the sign-up claim takes on the same key. Records the
    // key rather than the statement, because which occurrences were locked is
    // half of what makes the read behind it decisive.
    $executeRaw: vi.fn(async (_sql: unknown, key?: unknown) => {
      calls.push(typeof key === "string" ? key : "lock");
      return 1;
    }),
    event: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async () => row),
      delete: vi.fn(async () => row),
      create: vi.fn(async () => ({ id: row.id })),
    },
    eventOccurrence: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => STORED_OCCURRENCES[0]),
      createMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => options.occurrence ?? CALLED_OFF),
      updateMany: vi.fn(async () => ({
        count: options.reinstatedElsewhere === true ? 0 : 1,
      })),
    },
    /*
     * Present only to fail loudly. Reinstating a date must not read or write a
     * sign-up: somebody who stood down while the date was off has stood down,
     * and the place they gave back is not theirs to be handed again. A service
     * that reached for this table would throw here rather than quietly passing
     * an assertion about a row nothing checked.
     */
    eventSignup: {
      findUnique: refuseSignupAccess,
      findMany: refuseSignupAccess,
      count: refuseSignupAccess,
      update: refuseSignupAccess,
      updateMany: refuseSignupAccess,
      createMany: refuseSignupAccess,
      deleteMany: refuseSignupAccess,
    },
  };

  // Both doubles declare the argument they are asked with, because two of the
  // assertions below are about what was asked rather than about what came back.
  const record = vi.fn(async (_entry: unknown) => undefined);
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
    event: { findMany: vi.fn(async (_args: unknown) => [row]) },
  };

  return {
    service: new EventService(
      prisma as unknown as PrismaService,
      { record } as unknown as AuditLogService,
    ),
    prisma,
    record,
    tx,
  };
}

/** The one date of the fixture, called off and still ahead of the clock. */
const CALLED_OFF = {
  id: "occurrence-25",
  eventId: "event-1",
  startsAt: new Date("2027-04-25T08:00:00.000Z"),
  cancelledAt: new Date("2027-04-01T09:00:00.000Z"),
};

function refuseSignupAccess(): never {
  throw new Error("The act under test must not touch a sign-up.");
}

beforeEach(() => {
  held.mockReset();
  calls.length = 0;
  signedUpTo();
});

describe("editing a series people have signed up to", () => {
  it("refuses a change that would move a date somebody holds", async () => {
    signedUpTo("occurrence-25");
    const { service, tx } = build();

    await expect(
      service.update(
        "event-1",
        { ...AS_STATED, startsAtMinute: 9 * 60 },
        "board-1",
      ),
    ).rejects.toMatchObject({ reason: "occurrence-in-use" });

    // Refused whole: not one of the three dates moved, and the series still
    // says what it said.
    expect(tx.eventOccurrence.update).not.toHaveBeenCalled();
    expect(tx.eventOccurrence.deleteMany).not.toHaveBeenCalled();
    expect(tx.eventOccurrence.createMany).not.toHaveBeenCalled();
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("refuses a change that would drop a date somebody holds", async () => {
    signedUpTo("occurrence-02");
    const { service, tx } = build();

    await expect(
      service.update(
        "event-1",
        {
          ...AS_STATED,
          recurrence: {
            frequency: "WEEKLY",
            interval: 1,
            count: 2,
            until: null,
          },
        },
        "board-1",
      ),
    ).rejects.toMatchObject({ reason: "occurrence-in-use" });
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("refuses a change that would move a called-off date somebody holds", async () => {
    /*
     * A called-off date is still one somebody is standing on. Nothing withdraws
     * a sign-up when the board calls a date off - the row stays with the date on
     * it precisely because people may have signed up to it - so somebody who has
     * not stood down is still expecting to be there, and an edit that moved that
     * date would move their sign-up onto a day they never chose.
     *
     * The board's way out is dated and deliberate: leave the date alone, or
     * withdraw those sign-ups on those people's behalf.
     */
    signedUpTo("occurrence-25");
    const { service, tx } = build({ cancelledOccurrenceId: "occurrence-25" });

    await expect(
      service.update(
        "event-1",
        { ...AS_STATED, startsAtMinute: 9 * 60 },
        "board-1",
      ),
    ).rejects.toMatchObject({ reason: "occurrence-in-use" });
    expect(tx.eventOccurrence.update).not.toHaveBeenCalled();
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("asks about a called-off date rather than leaving it out", async () => {
    // The set the question is asked of, stated directly: an implementation that
    // filtered called-off dates out before asking would pass the refusal test
    // above only because the stub was told about the same id.
    const { service } = build({ cancelledOccurrenceId: "occurrence-25" });

    await service.update(
      "event-1",
      { ...AS_STATED, startsAtMinute: 9 * 60 },
      "board-1",
    );

    expect(held.mock.calls[0]?.[1]).toEqual([
      "occurrence-18",
      "occurrence-25",
      "occurrence-02",
    ]);
  });

  it("locks every displaced date, in one order, before it asks who holds them", async () => {
    /*
     * The ordering the whole refusal rests on, and the one thing being inside
     * the transaction does not give. This read runs at READ COMMITTED and so
     * sees the snapshot it began with: a claim that committed while the board
     * was saving would be invisible to it, and the edit would carry that sign-up
     * onto a day nobody chose. The claim's lock is what the two writers share,
     * and it is only worth anything taken before the count.
     *
     * Sorted, so two edits over overlapping dates queue rather than each holding
     * what the other waits for. The read is still asked in the plan's own order,
     * which the test above pins.
     */
    const { service } = build();

    await service.update(
      "event-1",
      { ...AS_STATED, startsAtMinute: 9 * 60 },
      "board-1",
    );

    expect(calls).toEqual([
      "event-occurrence-signups:occurrence-02",
      "event-occurrence-signups:occurrence-18",
      "event-occurrence-signups:occurrence-25",
      "read-signups",
    ]);
  });

  it("names the dates on the association's own calendar and nothing else", async () => {
    signedUpTo("occurrence-25", "occurrence-02");
    const { service } = build();

    const failure = await service
      .update("event-1", { ...AS_STATED, startsAtMinute: 9 * 60 }, "board-1")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "occurrence-in-use" });
    expect(
      (failure as { details: () => Record<string, unknown[]> }).details(),
    ).toEqual({
      dates: ["2027-04-25", "2027-05-02"],
      locations: [],
    });
  });

  it("asks only about the dates the change would displace", async () => {
    const { service } = build();

    // The 18th keeps its instants; the recurrence only adds a fourth date.
    await service.update(
      "event-1",
      {
        ...AS_STATED,
        recurrence: { frequency: "WEEKLY", interval: 1, count: 4, until: null },
      },
      "board-1",
    );

    expect(held).toHaveBeenCalledTimes(1);
    expect(held.mock.calls[0]?.[1]).toEqual([]);
  });

  it("allows a rename however many people have signed up", async () => {
    // Everybody holds everything. A title is not a date, so nothing is
    // displaced and the question is asked about nothing.
    signedUpTo(...STORED_OCCURRENCES.map((occurrence) => occurrence.id));
    const { service, tx } = build();

    await service.update(
      "event-1",
      { ...AS_STATED, title: "Stadag, vaar" },
      "board-1",
    );

    expect(tx.event.update).toHaveBeenCalledTimes(1);
    expect(held.mock.calls[0]?.[1]).toEqual([]);
  });

  it("allows a change that moves a date nobody holds", async () => {
    signedUpTo("occurrence-18");
    const { service, tx } = build();

    // The 18th keeps its time; the two after it are dropped and one arrives.
    await service.update(
      "event-1",
      {
        ...AS_STATED,
        recurrence: {
          frequency: "MONTHLY",
          interval: 1,
          count: 2,
          until: null,
        },
      },
      "board-1",
    );

    expect(tx.eventOccurrence.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.eventOccurrence.createMany).toHaveBeenCalledTimes(1);
    expect(tx.event.update).toHaveBeenCalledTimes(1);
  });
});

describe("removing a series", () => {
  it("is refused while anybody has signed up to any of its dates", async () => {
    signedUpTo("occurrence-18");
    const { service, tx } = build();

    await expect(service.remove("event-1", "board-1")).rejects.toMatchObject({
      reason: "occurrence-in-use",
    });
    expect(tx.event.delete).not.toHaveBeenCalled();
  });

  it("asks about every date, and not only the ones still to come", async () => {
    const { service, tx } = build();

    await service.remove("event-1", "board-1");

    expect(held.mock.calls[0]?.[1]).toEqual([
      "occurrence-18",
      "occurrence-25",
      "occurrence-02",
    ]);
    expect(tx.event.delete).toHaveBeenCalledTimes(1);
  });

  it("locks every date before it asks, because the delete cascades to the sign-ups", async () => {
    /*
     * The removal has more to lose from an unlocked read than the edit does. The
     * occurrence reference cascades, so a claim that committed after a read
     * saying nobody held the date is not merely moved - it is deleted, by the
     * removal that should have been refused, and nothing tells the person who
     * made it.
     */
    const { service } = build();

    await service.remove("event-1", "board-1");

    expect(calls).toEqual([
      "event-occurrence-signups:occurrence-02",
      "event-occurrence-signups:occurrence-18",
      "event-occurrence-signups:occurrence-25",
      "read-signups",
    ]);
  });
});

describe("the personal identity number scan", () => {
  const WITH_A_NUMBER = {
    ...AS_STATED,
    description: "Kontakta Anna, 811228-9874, om du undrar.",
  };

  it("refuses an edit to a published series", async () => {
    const { service, tx } = build({ published: true });

    const failure = await service
      .update("event-1", WITH_A_NUMBER, "board-1")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "personal-identity-number" });
    expect(tx.event.update).not.toHaveBeenCalled();
  });

  it("names the field and the offset, and never the value", async () => {
    const { service } = build({ published: true });

    const failure = await service
      .update("event-1", WITH_A_NUMBER, "board-1")
      .catch((error: unknown) => error);

    const details = (
      failure as { details: () => Record<string, unknown[]> }
    ).details();
    expect(details).toEqual({
      locations: [
        {
          field: "description",
          offset: WITH_A_NUMBER.description.indexOf("811228-9874"),
        },
      ],
      dates: [],
    });
    expect(JSON.stringify(details)).not.toContain("811228");
  });

  it("reads the title, the category and the location as well", async () => {
    const { service } = build({ published: true });

    const failure = await service
      .update(
        "event-1",
        {
          ...AS_STATED,
          title: "Mote om 811228-9874",
          category: null,
          location: "Hos 811228-9874",
        },
        "board-1",
      )
      .catch((error: unknown) => error);

    expect(
      (failure as { details: () => Record<string, unknown[]> }).details()
        .locations,
    ).toEqual([
      { field: "title", offset: "Mote om ".length },
      { field: "location", offset: "Hos ".length },
    ]);
  });

  it("does not run on a draft, which nobody can read", async () => {
    const { service, tx } = build({ published: false });

    await service.update("event-1", WITH_A_NUMBER, "board-1");

    expect(tx.event.update).toHaveBeenCalledTimes(1);
  });
});

describe("the board list's window", () => {
  /** Two months from the 1st of April, inclusive at both ends. */
  const WINDOW = {
    from: { year: 2027, month: 4, day: 1 },
    to: { year: 2027, month: 6, day: 1 },
  };

  it("asks for the dates running inside the period, at local midnight", async () => {
    const { service, prisma } = build();

    await service.list(WINDOW);

    const asked = prisma.event.findMany.mock.calls[0]?.[0] as unknown as {
      where: {
        occurrences: {
          some: { startsAt: { lt: Date }; endsAt: { gt: Date } };
        };
      };
    };
    /*
     * Local midnight on the first day, to local midnight after the last. April
     * and June 2027 are inside summer time, so both are 22:00 UTC the evening
     * before - which is the whole reason the window goes through the calendar
     * rather than through Date.UTC.
     */
    expect(asked.where.occurrences.some.endsAt.gt.toISOString()).toBe(
      "2027-03-31T22:00:00.000Z",
    );
    expect(asked.where.occurrences.some.startsAt.lt.toISOString()).toBe(
      "2027-06-01T22:00:00.000Z",
    );
  });

  it("refuses a period that runs backwards", async () => {
    const { service, prisma } = build();

    await expect(
      service.list({ from: WINDOW.to, to: WINDOW.from }),
    ).rejects.toMatchObject({ reason: "range-invalid" });
    expect(prisma.event.findMany).not.toHaveBeenCalled();
  });

  it("refuses a period longer than one read answers for", async () => {
    const { service, prisma } = build();

    // 62 days is the bound, so the 62nd day past the first is one too many.
    await expect(
      service.list({
        from: { year: 2027, month: 4, day: 1 },
        to: { year: 2027, month: 6, day: 2 },
      }),
    ).rejects.toMatchObject({ reason: "range-invalid" });
    expect(prisma.event.findMany).not.toHaveBeenCalled();
  });

  it("allows the widest period there is", async () => {
    const { service, prisma } = build();

    await service.list({
      from: { year: 2027, month: 4, day: 1 },
      to: { year: 2027, month: 6, day: 1 },
    });

    expect(prisma.event.findMany).toHaveBeenCalledTimes(1);
  });

  it("says how many dates the series has, whatever the period holds", async () => {
    // The count is the database's over the whole relation. A screen editing the
    // series needs the series' own number, not the number of rows it was sent.
    const { service } = build();

    const [series] = await service.list(WINDOW);

    expect(series?.occurrenceCount).toBe(3);
  });
});

describe("putting a called-off date back", () => {
  /** Before every date the fixture holds, so nothing has begun. */
  const BEFORE = new Date("2027-01-01T09:00:00.000Z");

  it("clears the date the call-off wrote, and only while it is set", async () => {
    const { service, tx } = build();

    await service.reinstateOccurrence("occurrence-25", "board-1", BEFORE);

    expect(tx.eventOccurrence.updateMany).toHaveBeenCalledWith({
      // Conditional on the date still being off, so two board members acting in
      // the same instant produce one clearing and one refusal rather than two
      // entries saying the date was reinstated.
      where: { id: "occurrence-25", cancelledAt: { not: null } },
      data: { cancelledAt: null },
    });
  });

  it("records an act of its own rather than a second call-off", async () => {
    const { service, record } = build();

    await service.reinstateOccurrence("occurrence-25", "board-1", BEFORE);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      action: "EVENT_OCCURRENCE_REINSTATED",
      actorPersonId: "board-1",
      targetKind: "eventOccurrence",
      targetId: "occurrence-25",
      // The series and the date, and never what the series is called: the log
      // outlives the row.
      context: { eventId: "event-1", on: "2027-04-25" },
    });
  });

  it("touches no sign-up, so a place given back stays given back", async () => {
    /*
     * Structural: the fake client's sign-up table throws on every method, so a
     * service that re-enrolled the people who stood down - or even counted
     * them - would fail here rather than pass an assertion about a row nothing
     * looked at. Somebody who withdrew because the date was off has withdrawn.
     */
    const { service } = build();

    await expect(
      service.reinstateOccurrence("occurrence-25", "board-1", BEFORE),
    ).resolves.toBeTruthy();
  });

  it("refuses a date that was never called off", async () => {
    const { service, tx } = build({
      occurrence: { ...CALLED_OFF, cancelledAt: null },
    });

    await expect(
      service.reinstateOccurrence("occurrence-25", "board-1", BEFORE),
    ).rejects.toMatchObject({ reason: "occurrence-not-cancelled" });
    expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a date the clock has passed", async () => {
    // It did not go ahead, and the calendar cannot say afterwards that it did.
    const { service, tx } = build();

    await expect(
      service.reinstateOccurrence(
        "occurrence-25",
        "board-1",
        new Date("2027-04-25T08:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ reason: "occurrence-already-begun" });
    expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a date that does not exist, series and all", async () => {
    // Which covers a series removed since one of its dates was called off: the
    // occurrences cascade with it, so there is no row left to put back and this
    // path is the one that answers.
    const { service, tx } = build();
    tx.eventOccurrence.findUnique.mockResolvedValue(
      null as unknown as typeof CALLED_OFF,
    );

    await expect(
      service.reinstateOccurrence("occurrence-25", "board-1", BEFORE),
    ).rejects.toMatchObject({ reason: "occurrence-not-found" });
    expect(tx.eventOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it("refuses the losing side of two reinstatements in one instant", async () => {
    const { service, record } = build({ reinstatedElsewhere: true });

    await expect(
      service.reinstateOccurrence("occurrence-25", "board-1", BEFORE),
    ).rejects.toMatchObject({ reason: "occurrence-not-cancelled" });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("the capacity", () => {
  it("is refused at zero, which no screen could explain", async () => {
    const { service } = build();

    await expect(
      service.create({ ...AS_STATED, capacity: 0 }, "board-1"),
    ).rejects.toMatchObject({ reason: "capacity-not-positive" });
  });

  it("is allowed to be absent, which is no limit", async () => {
    const { service, tx } = build();

    await service.create({ ...AS_STATED, capacity: null }, "board-1");

    expect(tx.event.create).toHaveBeenCalledTimes(1);
  });
});
