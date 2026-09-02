import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { MotionError } from "./motion.error";
import { MotionService } from "./motion.service";

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
    async (_args: { where: { id: string; meetingId: string | null } }) => {
      calls.push("update");
      return { count: options.updated ?? 1 };
    },
  );

  const tx = {
    $executeRaw: vi.fn(async (_strings: unknown, ...values: unknown[]) => {
      calls.push("lock");
      keys.push(String(values[0]));
      return 1;
    }),
    motion: {
      findUnique: vi.fn(async () => {
        calls.push("readMotion");
        return {
          id: "motion-1",
          status,
          submittedByPersonId: "person-1",
          meetingId,
        };
      }),
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

    await service.setMeeting("motion-1", "meeting-b", "board-1");

    expect(calls).toEqual(["readMotion", "lock", "readMeeting", "update"]);
  });

  it("takes the lock on the meeting the notice would be issued for", async () => {
    // The literal key, because it is shared with the meetings module and a
    // second spelling of it would be two locks that never meet.
    const { service, keys } = build();

    await service.setMeeting("motion-1", "meeting-b", "board-1");

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

    await service.setMeeting("motion-1", "meeting-a", "board-1");

    expect(keys).toEqual([
      "meeting-agenda:meeting-a",
      "meeting-agenda:meeting-z",
    ]);
  });

  it("takes no key when the item is on no meeting and is put to none", async () => {
    // There is no agenda for that request to decide about, so there is nothing
    // for it to queue behind either.
    const { service, keys, calls } = build();

    await service.setMeeting("motion-1", null, "board-1");

    expect(keys).toEqual([]);
    expect(calls).toEqual(["readMotion", "update"]);
  });

  it("takes one key when the item is written to the meeting it is already on", async () => {
    // Deduplicated: taking the same advisory key twice in one transaction is
    // harmless but says the writer does not know what it is locking.
    const { service, keys } = build({ meetingId: "meeting-b" });

    await service.setMeeting("motion-1", "meeting-b", "board-1");

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
      service.setMeeting("motion-1", "meeting-a", "board-1"),
    ).rejects.toMatchObject({ reason: "meeting-changed-meanwhile" });
    await expect(
      service.setMeeting("motion-1", "meeting-a", "board-1"),
    ).rejects.toBeInstanceOf(MotionError);
  });
});
