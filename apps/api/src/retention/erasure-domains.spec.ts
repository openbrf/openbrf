import { describe, expect, it } from "vitest";

import { erasureSourceFacts } from "../testing/erasure-source-facts";
import {
  describeRemainder,
  ERASURE_DOMAINS,
  erasureRemainder,
  remainingRunBound,
  type ErasureDbClient,
} from "./erasure-domains";

/**
 * That the closing job's verification covers every domain, as a test.
 *
 * The service-data purge marks a granted erasure request executed and closes
 * it, and closing it ends the erasure: every job that reads the request selects
 * only open ones, so rows left standing fall back to their ordinary retention
 * window instead of the date the board granted. That is why the job counts what
 * each domain still holds before it writes `executedAt` rather than trusting
 * that the jobs ahead of it got through.
 *
 * A verification over a list somebody keeps would fail the way the original
 * defect did: by being remembered once and then not. So the list is checked
 * against the same walk of the source that keeps the jobs in order - every file
 * that reads granted erasure requests on a schedule and does not close them is
 * a job that erases somebody's rows on a request, and every one of those is a
 * domain the closing job has to count. A purge added later is held to it
 * without anybody thinking about this file.
 *
 * Checked in both directions, for the reason the order spec gives about its own
 * list: an entry naming a job that is gone, or one that has stopped reading
 * requests, is an entry nothing uses, and the next edit inherits it without
 * anybody deciding to give it.
 */

const facts = erasureSourceFacts();

/** Scheduled jobs that read granted requests without closing them. */
const readers = facts.filter(
  (file) =>
    file.readsGrantedErasure &&
    file.schedules.length > 0 &&
    !file.marksRequestExecuted,
);

const registered = new Map(
  ERASURE_DOMAINS.map((domain) => [domain.job, domain]),
);

describe("the domains a granted erasure request has to be verified against", () => {
  it("is asserted over a source tree with jobs in it", () => {
    // Without this, a moved directory or a renamed selector would turn every
    // assertion below into one that passes because it found nothing to check.
    expect(facts.length).toBeGreaterThan(100);
    expect(readers.map((file) => file.path)).not.toEqual([]);
  });

  it("registers every scheduled job that erases a person's rows on a granted request", () => {
    const offenders = readers
      .filter((file) => !registered.has(file.path))
      .map(
        (file) =>
          `${file.path} reads granted erasure requests on a schedule and is ` +
          "not registered in ERASURE_DOMAINS, so the service-data purge would " +
          "close the request without checking whether this job got through " +
          "the person: add an entry naming the rows a granted request erases " +
          "there",
      );

    expect(offenders).toEqual([]);
  });

  it("names no domain whose job has stopped being one", () => {
    const stale: string[] = [];
    for (const domain of ERASURE_DOMAINS) {
      const file = facts.find((candidate) => candidate.path === domain.job);
      if (file === undefined) {
        stale.push(`${domain.job} no longer exists`);
      } else if (!file.readsGrantedErasure) {
        stale.push(`${domain.job} no longer reads granted erasure requests`);
      } else if (file.schedules.length === 0) {
        stale.push(`${domain.job} registers no schedule, so it is not a job`);
      } else if (file.marksRequestExecuted) {
        stale.push(
          `${domain.job} closes erasure requests, so it verifies its own work ` +
            "inside the transaction that does it rather than being counted " +
            "from outside",
        );
      }
    }

    expect(stale).toEqual([]);
  });

  it("gives every domain a name and a job of its own", () => {
    // Two entries sharing either would make a log line ambiguous about which
    // job is behind, and an entry added by copying one would go unnoticed.
    expect(new Set(ERASURE_DOMAINS.map((domain) => domain.name)).size).toBe(
      ERASURE_DOMAINS.length,
    );
    expect(registered.size).toBe(ERASURE_DOMAINS.length);
  });
});

const NOW = new Date("2027-06-01T03:53:00.000Z");
const PERSON = "person-1";
const OTHER = "person-2";

/** A row, as each table holds one for the purposes of a count. */
interface Rows {
  bookings?: { person: string }[];
  chatMessages?: { person: string; createdAt: Date }[];
  eventSignups?: { person: string }[];
  motions?: { person: string; closedAt: Date | null }[];
  newsComments?: { person: string; createdAt: Date }[];
}

/** Whether a where-input's person filter names this person. */
function namesPerson(filter: unknown, person: string): boolean {
  if (typeof filter === "string") {
    return filter === person;
  }
  const list = (filter as { in?: string[] } | undefined)?.in;
  return list !== undefined && list.includes(person);
}

function atMost(filter: unknown, at: Date): boolean {
  const lte = (filter as { lte?: Date } | undefined)?.lte;
  return lte !== undefined && at.getTime() <= lte.getTime();
}

/**
 * A database holding these rows.
 *
 * Every count honours the where-input it is handed rather than answering a
 * fixed number, because what is under test is which rows each domain asks
 * after: a fake that counted everything for a person would pass a motion
 * domain that had forgotten open motions are not erased, which is the one
 * distinction this file exists to pin.
 */
function build(rows: Rows): ErasureDbClient {
  return {
    booking: {
      count: async ({ where }: { where: { bookedByPersonId: unknown } }) =>
        (rows.bookings ?? []).filter((row) =>
          namesPerson(where.bookedByPersonId, row.person),
        ).length,
    },
    chatMessage: {
      count: async ({
        where,
      }: {
        where: { authorPersonId: unknown; createdAt: unknown };
      }) =>
        (rows.chatMessages ?? []).filter(
          (row) =>
            namesPerson(where.authorPersonId, row.person) &&
            atMost(where.createdAt, row.createdAt),
        ).length,
    },
    eventSignup: {
      count: async ({ where }: { where: { personId: unknown } }) =>
        (rows.eventSignups ?? []).filter((row) =>
          namesPerson(where.personId, row.person),
        ).length,
    },
    motion: {
      count: async ({
        where,
      }: {
        where: {
          submittedByPersonId: unknown;
          closedAt?: { lte?: Date };
          OR?: unknown[];
        };
      }) =>
        (rows.motions ?? []).filter((row) => {
          if (!namesPerson(where.submittedByPersonId, row.person)) {
            return false;
          }
          if (where.OR !== undefined) {
            // The kept half: open, or closed after the moment being judged.
            return (
              row.closedAt === null || row.closedAt.getTime() > NOW.getTime()
            );
          }
          return row.closedAt !== null && atMost(where.closedAt, row.closedAt);
        }).length,
    },
    newsComment: {
      count: async ({
        where,
      }: {
        where: { authorPersonId: unknown; createdAt: unknown };
      }) =>
        (rows.newsComments ?? []).filter(
          (row) =>
            namesPerson(where.authorPersonId, row.person) &&
            atMost(where.createdAt, row.createdAt),
        ).length,
    },
  } as unknown as ErasureDbClient;
}

describe("what a granted erasure request still owes one person", () => {
  it("answers nothing where every domain is empty of them", async () => {
    const client = build({
      chatMessages: [{ person: OTHER, createdAt: new Date("2027-01-01") }],
      motions: [{ person: OTHER, closedAt: new Date("2027-01-01") }],
    });

    await expect(erasureRemainder(client, PERSON, NOW)).resolves.toEqual([]);
  });

  it("names each domain that still holds rows, and how many", async () => {
    const client = build({
      bookings: [{ person: PERSON }, { person: PERSON }],
      newsComments: [{ person: PERSON, createdAt: new Date("2027-05-01") }],
    });

    await expect(erasureRemainder(client, PERSON, NOW)).resolves.toEqual([
      { domain: "bookings", owed: 2, kept: 0 },
      { domain: "news comments", owed: 1, kept: 0 },
    ]);
  });

  it("counts an open motion as kept rather than as owed", async () => {
    /*
     * The one row in the product a granted erasure does not reach. Counting it
     * as owed would make the request wait on a job that has nothing left to do,
     * and the board would be sent to look at a log for a fault that is not
     * there.
     */
    const client = build({
      motions: [
        { person: PERSON, closedAt: null },
        { person: PERSON, closedAt: new Date("2027-05-01") },
      ],
    });

    const remainder = await erasureRemainder(client, PERSON, NOW);

    expect(remainder).toEqual([
      {
        domain: "motions",
        owed: 1,
        kept: 1,
        keptBecause:
          "an open motion is a matter the association is still dealing with",
      },
    ]);
  });

  it("leaves a message written after the moment being judged for the next run", async () => {
    // The chat purge ran at 03:47 and this is 03:53. A message written in
    // between is not one the earlier run failed to erase, and the request stays
    // open until a run has taken it.
    const client = build({
      chatMessages: [
        { person: PERSON, createdAt: new Date("2027-06-01T03:59:00.000Z") },
      ],
    });

    await expect(erasureRemainder(client, PERSON, NOW)).resolves.toEqual([]);
  });

  it("says in one line what a domain is holding and why", () => {
    expect(describeRemainder({ domain: "bookings", owed: 3, kept: 0 })).toBe(
      "bookings: 3 not erased yet",
    );
    expect(
      describeRemainder({
        domain: "motions",
        owed: 0,
        kept: 2,
        keptBecause: "an open motion is a matter the association is still here",
      }),
    ).toBe(
      "motions: 2 kept because an open motion is a matter the association is " +
        "still here",
    );
  });
});

describe("the bound a run takes off its own retention window", () => {
  it("is what is left of the bound once the requested people are taken", () => {
    expect(remainingRunBound(0, 500)).toBe(500);
    expect(remainingRunBound(3, 500)).toBe(497);
  });

  it("is never less than nothing", () => {
    // More open granted requests than the bound is a flood rather than a
    // window, and the window waits: a negative take would be an error, and a
    // take of the difference would be the requested people spending a bound
    // they are not counted against.
    expect(remainingRunBound(501, 500)).toBe(0);
  });
});
