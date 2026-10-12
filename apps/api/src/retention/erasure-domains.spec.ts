import { describe, expect, it } from "vitest";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import { erasureSourceFacts } from "../testing/erasure-source-facts";
import {
  describeRemainder,
  ERASURE_DOMAINS,
  erasureDomainKey,
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

/**
 * Field encryption that stores an address as itself and indexes it under the
 * field it is asked for, so a withheld person's address and a thread's match
 * only when the purge has re-indexed the one under the other's field.
 */
const encryption = {
  decrypt: async (_field: string, cipher: string) => cipher,
  computeIndex: async (field: string, address: string) =>
    `${field}:${address.toLowerCase()}`,
} as unknown as FieldEncryptionService;

/** A thread's blind index for an address. */
function threadIndex(address: string): string {
  return `boardMailboxThread.correspondentEmail:${address.toLowerCase()}`;
}
const PERSON = "person-1";
const OTHER = "person-2";

/** A row, as each table holds one for the purposes of a count. */
interface Rows {
  /** Each with the address it carries, as the thread's own index would hold it. */
  boardMailboxThreads?: { person: string | null; address?: string | null }[];
  /** People under a hold or a restriction, with the address the register holds. */
  withheld?: { id: string; address: string | null }[];
  bookings?: { person: string }[];
  chatMessages?: { person: string; createdAt: Date }[];
  chatGroupMembers?: { person: string }[];
  chatReads?: { person: string }[];
  chatMessageReports?: { person: string }[];
  eventSignups?: { person: string }[];
  keyOrders?: { person: string; closedAt: Date | null }[];
  motions?: { person: string; closedAt: Date | null }[];
  newsComments?: { person: string; createdAt: Date }[];
  subletApplications?: {
    person: string;
    closedAt: Date | null;
    status?: "SUBMITTED" | "CONSENTED" | "REFUSED" | "WITHDRAWN";
    periodTo?: Date;
    lettingEndedOn?: Date | null;
  }[];
}

/** The letting-still-running filter a sublet count is handed. */
interface RunningLetting {
  status: string;
  periodTo: { gte: Date };
  OR: [{ lettingEndedOn: null }, { lettingEndedOn: { gte: Date } }];
}

function isRunning(
  row: { status?: string; periodTo?: Date; lettingEndedOn?: Date | null },
  letting: RunningLetting,
): boolean {
  const endedOn = row.lettingEndedOn ?? null;
  return (
    row.status === letting.status &&
    row.periodTo !== undefined &&
    row.periodTo.getTime() >= letting.periodTo.gte.getTime() &&
    (endedOn === null ||
      endedOn.getTime() >= letting.OR[1].lettingEndedOn.gte.getTime())
  );
}

/** A count over rows closed or open, as a `closedAt` filter asks for them. */
function countByClosing(
  rows: { person: string; closedAt: Date | null }[] | undefined,
  person: unknown,
  closedAt: unknown,
): number {
  return (rows ?? []).filter(
    (row) =>
      namesPerson(person, row.person) &&
      // `{ not: null }` asks for closed ones, `null` for open ones.
      (closedAt === null ? row.closedAt === null : row.closedAt !== null),
  ).length;
}

/** A count over rows that name a person in one column. */
function countNaming(
  rows: { person: string | null }[] | undefined,
  person: unknown,
): number {
  return (rows ?? []).filter(
    (row) => row.person !== null && namesPerson(person, row.person),
  ).length;
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
    person: {
      // Asked for the withheld people and then for their addresses; the
      // fake holds nobody else, so both answers are the same rows.
      findMany: async () =>
        (rows.withheld ?? []).map((person) => ({
          id: person.id,
          emailCipher: person.address,
        })),
    },
    boardMailboxThread: {
      count: async ({
        where,
      }: {
        where: {
          correspondentPersonId: unknown;
          correspondentEmailIndex?: { in: string[] };
          OR?: [{ correspondentEmailIndex: { notIn: string[] } }, unknown];
        };
      }) =>
        (rows.boardMailboxThreads ?? []).filter((row) => {
          if (
            row.person === null ||
            !namesPerson(where.correspondentPersonId, row.person)
          ) {
            return false;
          }
          const index =
            row.address === undefined || row.address === null
              ? null
              : threadIndex(row.address);
          if (where.correspondentEmailIndex !== undefined) {
            // The kept half: an address a withheld person holds.
            return (
              index !== null && where.correspondentEmailIndex.in.includes(index)
            );
          }
          const withheld = where.OR?.[0].correspondentEmailIndex.notIn ?? [];
          return index === null || !withheld.includes(index);
        }).length,
    },
    chatGroupMember: {
      count: async ({ where }: { where: { personId: unknown } }) =>
        countNaming(rows.chatGroupMembers, where.personId),
    },
    chatRead: {
      count: async ({ where }: { where: { personId: unknown } }) =>
        countNaming(rows.chatReads, where.personId),
    },
    chatMessageReport: {
      count: async ({ where }: { where: { reporterPersonId: unknown } }) =>
        countNaming(rows.chatMessageReports, where.reporterPersonId),
    },
    keyOrder: {
      count: async ({
        where,
      }: {
        where: { orderedByPersonId: unknown; closedAt: unknown };
      }) =>
        countByClosing(rows.keyOrders, where.orderedByPersonId, where.closedAt),
    },
    subletApplication: {
      count: async ({
        where,
      }: {
        where: {
          appliedByPersonId: unknown;
          closedAt?: unknown;
          NOT?: RunningLetting;
          OR?: [unknown, RunningLetting];
        };
      }) =>
        (rows.subletApplications ?? []).filter((row) => {
          if (!namesPerson(where.appliedByPersonId, row.person)) {
            return false;
          }
          if (where.OR !== undefined) {
            // The kept half: open, or a consented letting still running.
            return row.closedAt === null || isRunning(row, where.OR[1]);
          }
          return (
            row.closedAt !== null &&
            (where.NOT === undefined || !isRunning(row, where.NOT))
          );
        }).length,
    },
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

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([]);
  });

  it("names each domain that still holds rows, and how many", async () => {
    const client = build({
      bookings: [{ person: PERSON }, { person: PERSON }],
      newsComments: [{ person: PERSON, createdAt: new Date("2027-05-01") }],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([
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

    const remainder = await erasureRemainder(client, PERSON, NOW, encryption);

    expect(remainder).toEqual([
      {
        domain: "motions",
        owed: 1,
        kept: 1,
        keptBecause:
          "an open motion, or one on the agenda of a meeting not yet held, is a matter the association is still dealing with",
      },
    ]);
  });

  it("does not count a message written after the moment being judged", async () => {
    /*
     * The chat purge ran at 03:47 and this is 03:53. A message written in
     * between is not one the earlier run failed to erase, so it is not counted
     * as owed and the request closes tonight. That message is then kept on its
     * own year rather than erased on the request: the gap ADR 0016 accepts,
     * because a person whose erasure is in force holds no residency and no
     * seat, and is in no room to write in.
     */
    const client = build({
      chatMessages: [
        { person: PERSON, createdAt: new Date("2027-06-01T03:59:00.000Z") },
      ],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([]);
  });

  it("counts an open key order and an open subletting application as kept", async () => {
    // Both are still with the board, which has to answer them. The closed ones
    // are owed, and the request stays open while either kind stands.
    const client = build({
      keyOrders: [
        { person: PERSON, closedAt: null },
        { person: PERSON, closedAt: new Date("2027-05-01") },
      ],
      subletApplications: [{ person: PERSON, closedAt: null }],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([
      {
        domain: "key orders",
        owed: 1,
        kept: 1,
        keptBecause: "an open key order is still with the board",
      },
      {
        domain: "subletting applications",
        owed: 0,
        kept: 1,
        keptBecause:
          "a subletting application is still with the board or its letting still runs",
      },
    ]);
  });

  it("counts a consented letting that is still running as kept, and one that has ended as owed", async () => {
    // The consent is the board's proof that the letting was lawful, and while
    // the letting runs it stays; the period's last day is inside it.
    const client = build({
      subletApplications: [
        {
          person: PERSON,
          closedAt: new Date("2027-04-01"),
          status: "CONSENTED",
          periodTo: new Date("2027-06-01"),
        },
        {
          person: PERSON,
          closedAt: new Date("2027-04-01"),
          status: "CONSENTED",
          periodTo: new Date("2027-05-31"),
        },
        {
          person: PERSON,
          closedAt: new Date("2027-04-01"),
          status: "REFUSED",
          periodTo: new Date("2027-12-31"),
        },
      ],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([
      {
        domain: "subletting applications",
        // The ended consent and the refusal, whose period is no concern.
        owed: 2,
        kept: 1,
        keptBecause:
          "a subletting application is still with the board or its letting still runs",
      },
    ]);
  });

  it("counts a consented letting the board recorded as ended as owed, whatever its period", async () => {
    // A letting that stopped early is not running, so its consent no longer
    // holds the request open to the end of a period nobody uses. The recorded
    // day is inside the letting, as the period's last day is.
    const client = build({
      subletApplications: [
        {
          person: PERSON,
          closedAt: new Date("2027-04-01"),
          status: "CONSENTED",
          periodTo: new Date("2031-12-31"),
          lettingEndedOn: new Date("2027-05-31"),
        },
        {
          person: PERSON,
          closedAt: new Date("2027-04-01"),
          status: "CONSENTED",
          periodTo: new Date("2031-12-31"),
          lettingEndedOn: new Date("2027-06-01"),
        },
      ],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([
      {
        domain: "subletting applications",
        owed: 1,
        kept: 1,
        keptBecause:
          "a subletting application is still with the board or its letting still runs",
      },
    ]);
  });

  it("counts what the chat holds besides the messages", async () => {
    // A place in a group, a read marker and a report with its note are all the
    // person's, and a request closed with any of them standing would be
    // recorded as carried out when it was not.
    const client = build({
      chatGroupMembers: [{ person: PERSON }, { person: OTHER }],
      chatReads: [{ person: PERSON }],
      chatMessageReports: [{ person: PERSON }],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([{ domain: "chat", owed: 3, kept: 0 }]);
  });

  it("counts the mailbox threads linked to the person, and no other", async () => {
    // A thread nobody could be established as the correspondent of is linked
    // to nobody, and a request cannot reach it by an address.
    const client = build({
      boardMailboxThreads: [{ person: PERSON }, { person: null }],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([{ domain: "board mailbox threads", owed: 1, kept: 0 }]);
  });

  it("counts a linked thread whose address a withheld person holds as kept", async () => {
    /*
     * The address changed hands, or a household shares it: the thread is
     * linked to the person asking, and the register now holds its address for
     * somebody under a hold. The mailbox purge keeps every thread with that
     * address, so counting it as owed would leave the request open for as long
     * as the hold stands, saying a job has not got through.
     */
    const client = build({
      boardMailboxThreads: [
        { person: PERSON, address: "Styrelsen@Exempel.se" },
        { person: PERSON, address: "eget@exempel.se" },
        { person: PERSON, address: null },
      ],
      withheld: [
        { id: OTHER, address: "styrelsen@exempel.se" },
        // Stripped already: nothing left to match a thread against.
        { id: "person-3", address: null },
      ],
    });

    await expect(
      erasureRemainder(client, PERSON, NOW, encryption),
    ).resolves.toEqual([
      {
        domain: "board mailbox threads",
        owed: 2,
        kept: 1,
        keptBecause:
          "a thread's address is held by somebody under a legal hold or a restriction",
      },
    ]);
  });

  it("gives every domain its own key and its own name", () => {
    // The board's screen looks a domain's words up by its key, and a
    // remainder finds its key by its name, so neither may be shared.
    const keys = ERASURE_DOMAINS.map((domain) => domain.key);
    const names = ERASURE_DOMAINS.map((domain) => domain.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("finds the key of the domain a remainder is about", () => {
    expect(
      erasureDomainKey({ domain: "subletting applications", owed: 0, kept: 1 }),
    ).toBe("subletApplications");
    expect(() =>
      erasureDomainKey({ domain: "not a domain", owed: 1, kept: 0 }),
    ).toThrow("Not a registered erasure domain");
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
