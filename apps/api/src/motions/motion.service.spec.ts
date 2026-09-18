import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "../audit/actor-context";
import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { MotionError } from "./motion.error";
import {
  MOTIONS_PER_PAGE,
  motionQueueCursor,
  MotionService,
  parseMotionQueueCursor,
} from "./motion.service";

/** Whoever is acting, as the controller and the action registry derive them. */
const BOARD: ActorContext = { personId: "board-1", channel: "WEB" };

/**
 * The two things about linking a motion to a meeting that are decided before
 * any row is written, and that a database cannot be asked about.
 *
 * That the agenda lock is taken before the meeting is read. Both are ordinary
 * awaits on the transaction client, so nothing about the source says which came
 * first - and the order is the whole of the guarantee. A lock taken afterwards
 * leaves the window it exists to close: everything runs at READ COMMITTED, so a
 * notice committing between the read and the write is invisible to the read,
 * and the item is attached to a meeting whose agenda was already frozen with
 * nothing in the database refusing it.
 *
 * And which key is taken. The lock is worth something only while every writer
 * uses the same string, so the key is asserted literally here and in
 * `meeting-notice.service.spec.ts`: a key narrowed to the motion, or spelled a
 * second way in either module, would be two locks that never meet and every
 * other test in the suite would still pass.
 *
 * What actually happens to the rows when the two transactions interleave is
 * `meetings/meeting-notice.int-spec.ts`, which needs a real database to say it.
 */

const MEETING_DAY = new Date("2029-05-14T00:00:00.000Z");

interface Options {
  /** The meeting the motion is on before the request. */
  meetingId?: string | null;
  status?: "SUBMITTED" | "ACKNOWLEDGED" | "WITHDRAWN";
  /** How many rows the conditional update matches. */
  updated?: number;
  /**
   * What the row says once the conditional update has matched nothing, which is
   * what tells the lost races apart. `null` is a row that is no longer there.
   */
  statusAfterRace?: "SUBMITTED" | "ACKNOWLEDGED" | "WITHDRAWN" | null;
}

/** A database holding one motion, with every call recorded in order. */
function build(options: Options = {}) {
  const meetingId = options.meetingId ?? null;
  const status = options.status ?? "ACKNOWLEDGED";

  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];
  /** Every advisory-lock key taken, in the order it was taken. */
  const keys: string[] = [];

  const motionRow = (linkedTo: string | null) => ({
    id: "motion-1",
    title: "Nya cykelstall",
    body: "Styrelsen bor utreda saken.",
    status,
    submittedAt: new Date("2029-01-04T09:00:00.000Z"),
    submittedByPersonId: "person-1",
    closedAt: null,
    closedByPersonId: null,
    meetingId: linkedTo,
    meeting:
      linkedTo === null
        ? null
        : {
            id: linkedTo,
            kind: "ORDINARY" as const,
            heldOn: MEETING_DAY,
            notice: null,
          },
  });

  const updateMany = vi.fn(
    async (_args: {
      where: {
        id: string;
        meetingId: string | null;
        status?: { not: string };
      };
    }) => {
      calls.push("update");
      return { count: options.updated ?? 1 };
    },
  );

  /*
   * The row is read twice on the losing path: once to decide, and once
   * afterwards to say which condition the caller lost. The second answer is
   * what a writer that beat this transaction left behind, so the fake has to
   * be able to differ from the first.
   */
  let reads = 0;
  const findUnique = vi.fn(async () => {
    reads += 1;
    if (reads === 1) {
      calls.push("readMotion");
      return {
        id: "motion-1",
        status,
        submittedByPersonId: "person-1",
        meetingId,
      };
    }
    calls.push("readMotionAgain");
    // `in` rather than `??`, because null is a case here and not an absence.
    const after =
      "statusAfterRace" in options ? options.statusAfterRace : status;
    return after === null || after === undefined ? null : { status: after };
  });

  const tx = {
    $executeRaw: vi.fn(async (_strings: unknown, ...values: unknown[]) => {
      calls.push("lock");
      keys.push(String(values[0]));
      return 1;
    }),
    motion: {
      findUnique,
      updateMany,
      findUniqueOrThrow: vi.fn(async () => motionRow("meeting-b")),
    },
    meeting: {
      findUnique: vi.fn(async () => {
        calls.push("readMeeting");
        return { concludedAt: null, notice: null };
      }),
    },
  };

  const prisma = {
    person: {
      findMany: vi.fn(async () => [
        {
          id: "person-1",
          firstName: "Astrid",
          lastName: "Motionar",
          protectedPersonalData: false,
        },
      ]),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };

  return {
    service: new MotionService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    calls,
    keys,
    tx,
    updateMany,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("putting a motion to a meeting", () => {
  it("takes the agenda lock before it reads the meeting", async () => {
    const { service, calls } = build();

    await service.setMeeting("motion-1", "meeting-b", BOARD);

    expect(calls).toEqual(["readMotion", "lock", "readMeeting", "update"]);
  });

  it("takes the lock on the meeting the notice would be issued for", async () => {
    // The literal key, because it is shared with the meetings module and a
    // second spelling of it would be two locks that never meet.
    const { service, keys } = build();

    await service.setMeeting("motion-1", "meeting-b", BOARD);

    expect(keys).toEqual(["meeting-agenda:meeting-b"]);
  });

  it("takes both keys in one order when the item moves between meetings", async () => {
    /*
     * A move decides about two agendas, so it holds two keys. Two moves in
     * opposite directions between one pair of meetings would take them in
     * opposite orders, which is a cycle the database resolves by killing one of
     * the transactions - so the order is sorted rather than the order the
     * request happened to name them in.
     */
    const { service, keys } = build({ meetingId: "meeting-z" });

    await service.setMeeting("motion-1", "meeting-a", BOARD);

    expect(keys).toEqual([
      "meeting-agenda:meeting-a",
      "meeting-agenda:meeting-z",
    ]);
  });

  it("takes no key when the item is on no meeting and is put to none", async () => {
    // There is no agenda for that request to decide about, so there is nothing
    // for it to queue behind either.
    const { service, keys, calls } = build();

    await service.setMeeting("motion-1", null, BOARD);

    expect(keys).toEqual([]);
    expect(calls).toEqual(["readMotion", "update"]);
  });

  it("takes one key when the item is written to the meeting it is already on", async () => {
    // Deduplicated: taking the same advisory key twice in one transaction is
    // harmless but says the writer does not know what it is locking.
    const { service, keys } = build({ meetingId: "meeting-b" });

    await service.setMeeting("motion-1", "meeting-b", BOARD);

    expect(keys).toEqual(["meeting-agenda:meeting-b"]);
  });

  it("refuses a lost link race as a changed meeting, not as a closed motion", async () => {
    /*
     * The reason is the public discriminator: the screen picks its sentence
     * from it. The motion is exactly as open as it was - another board member
     * moved it while this caller was looking at the queue - so answering
     * `already-closed` would send somebody looking for a state it is not in.
     */
    const { service } = build({ meetingId: "meeting-z", updated: 0 });

    await expect(
      service.setMeeting("motion-1", "meeting-a", BOARD),
    ).rejects.toMatchObject({ reason: "meeting-changed-meanwhile" });
    await expect(
      service.setMeeting("motion-1", "meeting-a", BOARD),
    ).rejects.toBeInstanceOf(MotionError);
  });

  it("writes only while the motion is not withdrawn", async () => {
    /*
     * The withdrawal is the member's own act, in a transaction of its own that
     * takes no agenda key, so at READ COMMITTED it can commit after the check
     * on the read row and before this write. The state therefore has to be in
     * the update's own predicate: without it the board would be recording that
     * it will take up a request the member had already taken back.
     */
    const { service, updateMany } = build({ status: "SUBMITTED" });

    await service.setMeeting("motion-1", "meeting-b", BOARD);

    expect(updateMany.mock.calls[0]?.[0].where.status).toEqual({
      not: "WITHDRAWN",
    });
  });

  it("names the withdrawal when that is what the write lost to", async () => {
    // Three conditions on one update and one count back from it, so the row is
    // read again to say which was lost. A withdrawal reported as a moved item
    // would tell the board to look for the motion on another meeting.
    const { service, calls } = build({
      status: "SUBMITTED",
      updated: 0,
      statusAfterRace: "WITHDRAWN",
    });

    await expect(
      service.setMeeting("motion-1", "meeting-b", BOARD),
    ).rejects.toMatchObject({ reason: "motion-withdrawn" });
    expect(calls).toEqual([
      "readMotion",
      "lock",
      "readMeeting",
      "update",
      "readMotionAgain",
    ]);
  });

  it("names a moved item when the motion is still open", async () => {
    const { service } = build({
      meetingId: "meeting-z",
      updated: 0,
      statusAfterRace: "ACKNOWLEDGED",
    });

    await expect(
      service.setMeeting("motion-1", "meeting-a", BOARD),
    ).rejects.toMatchObject({ reason: "meeting-changed-meanwhile" });
  });

  it("names a motion that is no longer there at all", async () => {
    // The purge reaches closed motions, so the row this transaction read can be
    // gone by the time the write runs. "Put to a different meeting" would be a
    // statement about a row that no longer exists.
    const { service } = build({ updated: 0, statusAfterRace: null });

    await expect(
      service.setMeeting("motion-1", "meeting-b", BOARD),
    ).rejects.toMatchObject({ reason: "motion-not-found" });
  });
});

/**
 * The cursor into the queue, round-tripped and refused.
 *
 * Three halves, because the ordering the queue is read in takes three columns
 * to be total: a cursor on an ordering that is not total is a bug waiting for
 * two motions to share an instant, and the column keeps milliseconds with the
 * transaction's own clock as its default, so rows written together carry the
 * same instant exactly.
 */
describe("where a page of the queue ends", () => {
  it("round-trips the three values it names", () => {
    const submittedAt = new Date("2027-01-20T09:00:00.000Z");

    expect(
      parseMotionQueueCursor(
        motionQueueCursor({ status: "SUBMITTED", submittedAt, id: "motion-1" }),
      ),
    ).toEqual({ status: "SUBMITTED", submittedAt, id: "motion-1" });
  });

  it("refuses a value this application did not hand out", () => {
    // Null rather than a lenient reading: a cursor the service cannot make
    // sense of names a page nobody can name, and answering the first page
    // instead would show a board the items it had just worked through.
    for (const value of [
      "",
      "page 2",
      "SUBMITTED|2027-01-20T09:00:00.000Z",
      "SUBMITTED|2027-01-20T09:00:00.000Z|motion-1|extra",
      "REJECTED|2027-01-20T09:00:00.000Z|motion-1",
      "SUBMITTED|not-an-instant|motion-1",
      // Accepted by `new Date` and not the spelling the column round-trips to,
      // so it would compare against a moment nobody was shown.
      "SUBMITTED|2027-01-20T09:00:00Z|motion-1",
      "SUBMITTED|2027-01-20T09:00:00.000Z|",
    ]) {
      expect(parseMotionQueueCursor(value), value).toBeNull();
    }
  });
});

describe("reading the queue a page at a time", () => {
  function queueWith(rows: readonly object[]) {
    const findMany = vi.fn(
      async (_args: {
        where?: unknown;
        orderBy?: unknown;
        take?: number;
        select?: unknown;
      }) => rows,
    );
    const prisma = {
      motion: { findMany },
      association: {
        findUnique: vi.fn(async () => null),
      },
      person: { findMany: vi.fn(async () => []) },
    };
    const service = new MotionService(
      prisma as unknown as PrismaService,
      { record: vi.fn() } as unknown as AuditLogService,
    );
    return { service, findMany };
  }

  function row(id: string, status = "SUBMITTED") {
    return {
      id,
      title: id,
      body: "",
      status,
      submittedAt: new Date("2027-01-20T09:00:00.000Z"),
      submittedByPersonId: "person-maja",
      closedAt: null,
      closedByPersonId: null,
      meetingId: null,
      meeting: null,
    };
  }

  it("reads one row past the page, and answers the cursor of the last kept", async () => {
    /*
     * One extra row is how "there is a page after this one" is answered. A
     * separate count would be a second statement about a second moment and
     * could say there was more when the extra motion had been purged between
     * the two - a page offered and then answered empty. The cursor is the last
     * row kept rather than the extra one read, so the next page starts exactly
     * where this one stopped.
     */
    const { service, findMany } = queueWith([row("a"), row("b"), row("c")]);

    const page = await service.queue({ limit: 2 });

    expect(findMany.mock.calls[0]?.[0]?.take).toBe(3);
    expect(page.motions.map((motion) => motion.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe(
      motionQueueCursor({
        status: "SUBMITTED",
        submittedAt: new Date("2027-01-20T09:00:00.000Z"),
        id: "b",
      }),
    );
  });

  it("says the queue ends when no row came back past the page", async () => {
    const { service } = queueWith([row("a")]);

    expect((await service.queue({ limit: 2 })).nextCursor).toBeNull();
  });

  it("never answers with more than the page the service sets", async () => {
    // A caller asking for more than the cap gets the cap rather than a refusal:
    // the bound is the service's and is not a caller's to raise.
    const { service, findMany } = queueWith([]);

    await service.queue({ limit: 5000 });

    expect(findMany.mock.calls[0]?.[0]?.take).toBe(MOTIONS_PER_PAGE + 1);
  });

  it("orders on all three columns the cursor names", async () => {
    const { service, findMany } = queueWith([]);

    await service.queue();

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { status: "asc" },
      { submittedAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("asks for the statuses after the cursor's, and not for an order on the enum", async () => {
    /*
     * Prisma compares an enum column for equality and membership and not for
     * order, so the status half of the cursor is resolved before the query: the
     * statuses the ordering puts after it are named, and the cursor's own
     * status carries the instant-and-identifier comparison.
     */
    const { service, findMany } = queueWith([]);
    const submittedAt = new Date("2027-01-20T09:00:00.000Z");

    await service.queue({
      after: { status: "SUBMITTED", submittedAt, id: "motion-1" },
    });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [
        {
          status: "SUBMITTED",
          OR: [
            { submittedAt: { gt: submittedAt } },
            { submittedAt, id: { gt: "motion-1" } },
          ],
        },
        { status: { in: ["ACKNOWLEDGED", "WITHDRAWN"] } },
      ],
    });
  });

  it("names no later status at the end of the ordering", async () => {
    // An empty `in` matches nothing, which is exactly right: past the last
    // status there is nothing after the cursor but that status's own rows.
    const { service, findMany } = queueWith([]);

    await service.queue({
      after: {
        status: "WITHDRAWN",
        submittedAt: new Date("2027-01-20T09:00:00.000Z"),
        id: "motion-1",
      },
    });

    const where = findMany.mock.calls[0]?.[0]?.where as {
      OR: { status?: { in?: string[] } }[];
    };
    expect(where.OR[1]?.status?.in).toEqual([]);
  });
});
