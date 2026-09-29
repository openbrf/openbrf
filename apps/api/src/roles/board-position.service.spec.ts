import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { BoardPositionService } from "./board-position.service";

/**
 * Who may write the board's seats, where the int-spec cannot reach: an
 * instance on which nobody holds a seat. The integration database is shared by
 * suites that seat a board of their own, so that state is only reachable here.
 */

const NOW = new Date("2026-06-01T12:00:00Z");

function service(seats: { personId: string }[]) {
  const created: unknown[] = [];
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    person: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
      ),
    },
    boardPosition: {
      // Every seat in the fixture is held today; the filter that matters is
      // whose it is.
      count: vi.fn(({ where }: { where: { personId?: string } }) =>
        Promise.resolve(
          seats.filter(
            (seat) =>
              where.personId === undefined || seat.personId === where.personId,
          ).length,
        ),
      ),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "seat-1", endedOn: null, ...data });
      }),
    },
  };
  const prisma = {
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { positions: new BoardPositionService(prisma, audit), created };
}

const election = (actorPersonId: string, personId: string) => ({
  actorPersonId,
  personId,
  position: "CHAIR" as const,
  electedOn: "2026-04-14",
});

describe("an actor who holds no seat", () => {
  it("records the first board, on an instance where nobody holds a seat", async () => {
    const { positions, created } = service([]);

    await positions.elect(election("admin", "chair"), NOW);

    expect(created).toHaveLength(1);
  });

  it("never records their own seat, even then", async () => {
    const { positions, created } = service([]);

    await expect(
      positions.elect(election("admin", "admin"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(created).toHaveLength(0);
  });

  it("records nothing once a board is seated", async () => {
    const { positions, created } = service([{ personId: "chair" }]);

    await expect(
      positions.elect(election("admin", "deputy"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(created).toHaveLength(0);
  });
});

describe("an actor who holds a seat", () => {
  it("records a colleague's election", async () => {
    const { positions, created } = service([{ personId: "chair" }]);

    await positions.elect(election("chair", "deputy"), NOW);

    expect(created).toHaveLength(1);
  });
});
