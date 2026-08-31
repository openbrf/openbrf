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
 * What the plan does date by date is `occurrence-plan.spec.ts`, the rule itself
 * is `recurrence.spec.ts`, and what the database does about any of it is
 * `events.int-spec.ts`.
 */

vi.mock("./event-attendance", () => ({
  occurrencesWithSignups: vi.fn(async () => new Set<string>()),
}));

const held = vi.mocked(occurrencesWithSignups);

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
  held.mockImplementation(
    async (_db, requested) =>
      new Set(requested.filter((id) => occurrenceIds.includes(id))),
  );
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
  options: { published?: boolean; cancelledOccurrenceId?: string } = {},
) {
  const row = storedEvent(
    options.published ?? false,
    AS_STATED.title,
    options.cancelledOccurrenceId,
  );

  const tx = {
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
    },
  };

  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };

  return {
    service: new EventService(
      prisma as unknown as PrismaService,
      { record: vi.fn(async () => undefined) } as unknown as AuditLogService,
    ),
    tx,
  };
}

beforeEach(() => {
  held.mockReset();
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
