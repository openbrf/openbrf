import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { MeetingNoticeService } from "./meeting-notice.service";
import { MeetingError } from "./meeting.error";
import { MeetingService } from "./meeting.service";

/**
 * Which unique violation a check-in answers as a second assistant.
 *
 * Two keys can refuse an assistant's line: the partial index that allows one
 * standing assistant per principal, and the key of one line per person,
 * meeting and capacity. Only the first is a second assistant. Answering the
 * other the same way told a board to strike off an assistant that was the very
 * person they were adding. Which key was hit is what the driver reports, and a
 * database cannot be made to raise the second one on demand, so this is asked
 * here rather than in `meetings.int-spec.ts`.
 */

/** A unique violation on one index, shaped as the PostgreSQL adapter raises it. */
function uniqueViolation(index: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the (index: \`${index}\`)`,
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation", constraint: { index } },
        },
      },
    },
  );
}

/** Checks an assistant in, with the line's write failing with `failure`. */
function checkInAssistant(failure: Error): Promise<unknown> {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: "principal-line" }]),
    meeting: {
      findUnique: vi.fn(async () => ({
        id: "meeting-1",
        heldOn: new Date("2029-05-17T00:00:00.000Z"),
        concludedAt: null,
        notice: null,
      })),
    },
    meetingAttendance: {
      count: vi.fn(async () => 0),
      upsert: vi.fn(() => Promise.reject(failure)),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    ),
  } as unknown as PrismaService;
  const service = new MeetingService(
    prisma,
    { record: vi.fn() } as unknown as AuditLogService,
    {} as MeetingNoticeService,
  );
  return service.recordAttendance(
    "meeting-1",
    {
      personId: "assistant-1",
      capacity: "ASSISTANT",
      mode: "IN_PERSON",
      onBehalfOfPersonId: "member-1",
    },
    "board-1",
  );
}

describe("a unique violation on an assistant's line", () => {
  it("is a second assistant on the one-standing-assistant index", async () => {
    const refusal = checkInAssistant(
      uniqueViolation(
        "meeting_attendance_meetingId_onBehalfOfPersonId_live_key",
      ),
    );

    await expect(refusal).rejects.toBeInstanceOf(MeetingError);
    await expect(refusal).rejects.toMatchObject({
      reason: "assistant-already-present",
    });
  });

  it("is not a second assistant on any other key", async () => {
    const failure = uniqueViolation(
      "meeting_attendance_meetingId_personId_capacity_key",
    );

    await expect(checkInAssistant(failure)).rejects.toBe(failure);
  });
});
