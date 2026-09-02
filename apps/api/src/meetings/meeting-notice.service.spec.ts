import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { MeetingNoticeMailerService } from "./meeting-notice-mailer.service";
import { MeetingNoticeService } from "./meeting-notice.service";
import { MeetingError } from "./meeting.error";

/**
 * The three things about issuing a notice that are decided before any row is
 * read back, and that a database cannot be asked about.
 *
 * That the agenda lock is taken before the meeting is read, and on which key.
 * Issuing the notice is what freezes the agenda, and the two writers that read
 * that freeze - the agenda rewrite and the link from a motion - decide on a read
 * of the very row this transaction is about to write. Everything runs at READ
 * COMMITTED, so a lock taken after the read would leave the window it exists to
 * close, and the order is the whole of the guarantee: both calls are ordinary
 * awaits and nothing about the source says which came first. The key is
 * asserted literally because it is shared with the motions module, and a second
 * spelling of it there or here would be two locks that never meet.
 *
 * That the unique key's refusal comes back as a sentence. `meetingId` is unique
 * on the notice table, which is what makes one notice per meeting true whatever
 * a writer forgets; a client error escaping from it would answer the board with
 * no reason at all where the check one statement earlier has a worded one.
 *
 * And which columns the recipients are read out of the member register with.
 * That table holds the recorded name and postal address of everybody who has
 * ever been a member and is read whole to answer who is a member on a day, so
 * the selection is asserted rather than left to whatever a later edit adds to
 * it.
 *
 * What happens when the notice and a link actually interleave is
 * `meeting-notice.int-spec.ts`, which needs a real database to say it.
 */

const MEETING_ID = "meeting-1";
/** A Thursday, so the notice's hour lands on an ordinary day. */
const HELD_ON = new Date("2029-05-17T00:00:00.000Z");
const ISSUED_AT = new Date("2029-04-02T07:15:00.000Z");

const INPUT = {
  startsAt: "18:30",
  place: "Foreningslokalen",
  digitalParticipation: null,
};

interface Options {
  /** A notice already on the meeting, as the check reads it. */
  alreadyIssued?: boolean;
  /** The unique key refusing the insert, as a concurrent request would. */
  uniqueKeyRefuses?: boolean;
  /** The insert failing for a reason that is a fault rather than a refusal. */
  otherFailure?: boolean;
}

function build(options: Options = {}) {
  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];
  /** Every advisory-lock key taken, in the order it was taken. */
  const keys: string[] = [];

  const registerFindMany = vi.fn(async (_args: { select: object }) => {
    calls.push("readRegister");
    return [
      {
        id: "entry-1",
        personId: "person-1",
        eventType: "ENTRY" as const,
        eventOn: new Date("2027-03-01T00:00:00.000Z"),
        correctsEntryId: null,
        createdAt: new Date("2027-03-01T10:00:00.000Z"),
      },
    ];
  });

  const create = vi.fn(async () => {
    calls.push("createNotice");
    if (options.uniqueKeyRefuses === true) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`meetingId`)",
        {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["meetingId"] },
        },
      );
    }
    if (options.otherFailure === true) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Transaction failed due to a write conflict",
        { code: "P2034", clientVersion: "test" },
      );
    }
    return {
      id: "notice-1",
      startsAt: new Date("2029-05-17T16:30:00.000Z"),
      place: INPUT.place,
      digitalParticipation: null,
      issuedAt: ISSUED_AT,
      issuedByPersonId: "board-1",
    };
  });

  const createManyDeliveries = vi.fn(async () => ({ count: 1 }));

  const tx = {
    $executeRaw: vi.fn(async (_strings: unknown, ...values: unknown[]) => {
      calls.push("lock");
      keys.push(String(values[0]));
      return 1;
    }),
    meeting: {
      findUnique: vi.fn(async () => {
        calls.push("readMeeting");
        return {
          id: MEETING_ID,
          heldOn: HELD_ON,
          concludedAt: null,
          notice: options.alreadyIssued === true ? { id: "notice-0" } : null,
          _count: { agendaItems: 1 },
        };
      }),
    },
    meetingNotice: { create },
    memberRegisterEntry: { findMany: registerFindMany },
    meetingNoticeDelivery: { createMany: createManyDeliveries },
  };

  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };
  const mailer = {
    ensureQueues: vi.fn(async () => undefined),
    enqueueInTransaction: vi.fn(async () => undefined),
  };

  return {
    service: new MeetingNoticeService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      mailer as unknown as MeetingNoticeMailerService,
    ),
    calls,
    keys,
    registerFindMany,
    createManyDeliveries,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issuing a notice", () => {
  it("takes the agenda lock before it reads the meeting", async () => {
    const { service, calls } = build();

    await service.issue(MEETING_ID, INPUT, "board-1");

    expect(calls).toEqual([
      "lock",
      "readMeeting",
      "createNotice",
      "readRegister",
    ]);
  });

  it("takes the lock the motion link takes", async () => {
    const { service, keys } = build();

    await service.issue(MEETING_ID, INPUT, "board-1");

    expect(keys).toEqual([`meeting-agenda:${MEETING_ID}`]);
  });

  it("holds the lock while the meeting is refused too", async () => {
    // The refusal is the ordinary outcome of a second click, and it happens
    // under the key rather than beside it - which is what makes the check and
    // the insert one decision.
    const { service, keys } = build({ alreadyIssued: true });

    await expect(
      service.issue(MEETING_ID, INPUT, "board-1"),
    ).rejects.toMatchObject({ reason: "notice-already-issued" });
    expect(keys).toEqual([`meeting-agenda:${MEETING_ID}`]);
  });

  it("answers the unique key with the reason the check already defines", async () => {
    /*
     * The index is the last line of defence: it is what holds if a writer is
     * ever added that does not take the lock, and its refusal has to be a
     * sentence rather than a client error the board's screen cannot read. EFL 6
     * kap. 25 § gives the remedy for a notice that went wrong, and it is a
     * further meeting with a notice of its own.
     */
    const { service } = build({ uniqueKeyRefuses: true });

    const refused = service.issue(MEETING_ID, INPUT, "board-1");
    await expect(refused).rejects.toBeInstanceOf(MeetingError);
    await expect(refused).rejects.toMatchObject({
      reason: "notice-already-issued",
    });
  });

  it("lets an unrelated database failure through", async () => {
    // Only the one code is answered in words. Anything else is a fault rather
    // than a refusal, and turning it into one would report a summons that
    // failed as a summons that was declined.
    const { service } = build({ otherFailure: true });

    const failed = service.issue(MEETING_ID, INPUT, "board-1");
    await expect(failed).rejects.not.toBeInstanceOf(MeetingError);
    await expect(failed).rejects.toMatchObject({ code: "P2034" });
  });

  it("reads six columns out of the member register and no recorded value", async () => {
    /*
     * The register is the association's most sensitive table and every row of
     * it is read to answer who was a member on the day the notice is issued.
     * The answer needs the event, its dates and the identifiers the correction
     * chain is followed through - never a recorded name or address, which are
     * exactly what a wider selection would carry into the process.
     */
    const { service, registerFindMany } = build();

    await service.issue(MEETING_ID, INPUT, "board-1");

    const select = registerFindMany.mock.calls[0]?.[0].select;
    expect(Object.keys(select ?? {}).sort()).toEqual([
      "correctsEntryId",
      "createdAt",
      "eventOn",
      "eventType",
      "id",
      "personId",
    ]);
  });

  it("writes one ledger row per member the register shows", async () => {
    const { service, createManyDeliveries } = build();

    await service.issue(MEETING_ID, INPUT, "board-1");

    expect(createManyDeliveries).toHaveBeenCalledWith({
      data: [{ noticeId: "notice-1", personId: "person-1", channel: "EMAIL" }],
    });
  });
});
