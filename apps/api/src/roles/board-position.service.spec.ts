import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { BoardPositionService } from "./board-position.service";

/**
 * Who may write the board's seats, and when a board recovery may record one:
 * every combination of seats ahead of, behind and around today, which the
 * int-specs reach only one database at a time.
 *
 * The register is an in-memory table and the queries the service asks of it are
 * answered by {@link matches}, so what is tested is which seats the rule counts
 * and not what the mock was told to return.
 */

const NOW = new Date("2026-06-01T12:00:00Z");

interface Seat {
  id: string;
  personId: string;
  position: string;
  electedOn: Date;
  endedOn: Date | null;
  /** Whether the person can sign in. */
  account: boolean;
}

interface Where {
  id?: string;
  personId?: string;
  position?: string;
  electedOn?: { lte: Date };
  endedOn?: Date | null;
  OR?: { endedOn: null | { gt: Date } }[];
  person?: { userAccount: { isNot: null } };
}

/** The subset of Prisma's filter syntax the guard and the service use. */
function matches(seat: Seat, where: Where): boolean {
  return (
    (where.id === undefined || seat.id === where.id) &&
    (where.personId === undefined || seat.personId === where.personId) &&
    (where.position === undefined || seat.position === where.position) &&
    (where.electedOn === undefined ||
      seat.electedOn.getTime() <= where.electedOn.lte.getTime()) &&
    (where.endedOn === undefined ||
      (where.endedOn === null
        ? seat.endedOn === null
        : seat.endedOn?.getTime() === where.endedOn.getTime())) &&
    (where.OR === undefined ||
      where.OR.some((clause) =>
        clause.endedOn === null
          ? seat.endedOn === null
          : seat.endedOn !== null &&
            seat.endedOn.getTime() > clause.endedOn.gt.getTime(),
      )) &&
    (where.person === undefined || seat.account)
  );
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const seatOf = (
  personId: string,
  electedOn: string,
  endedOn: string | null = null,
  account = true,
): Seat => ({
  id: `seat-${personId}`,
  personId,
  position: "BOARD_MEMBER",
  electedOn: day(electedOn),
  endedOn: endedOn === null ? null : day(endedOn),
  account,
});

function service(seats: Seat[]) {
  const accounts = new Set(
    seats.filter((seat) => seat.account).map((seat) => seat.personId),
  );
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    person: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
      ),
    },
    boardPosition: {
      count: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(seats.filter((seat) => matches(seat, where)).length),
      ),
      findMany: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(seats.filter((seat) => matches(seat, where))),
      ),
      findUnique: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(seats.find((seat) => matches(seat, where)) ?? null),
      ),
      create: vi.fn(({ data }: { data: Omit<Seat, "id" | "account"> }) => {
        const created: Seat = {
          ...data,
          id: `seat-${data.personId}`,
          endedOn: null,
          account: accounts.has(data.personId),
        };
        seats.push(created);
        return Promise.resolve(created);
      }),
      updateMany: vi.fn(
        ({ where, data }: { where: Where; data: { endedOn: Date } }) => {
          const found = seats.filter((seat) => matches(seat, where));
          found.forEach((seat) => {
            seat.endedOn = data.endedOn;
          });
          return Promise.resolve({ count: found.length });
        },
      ),
    },
  };
  const prisma = {
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    boardPosition: tx.boardPosition,
  } as unknown as PrismaService;
  const record = vi.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as AuditLogService;
  return {
    positions: new BoardPositionService(prisma, audit),
    seats,
    tx,
    record,
  };
}

const election = (
  actorPersonId: string,
  personId: string,
  electedOn = "2026-04-14",
) => ({
  actorPersonId,
  personId,
  position: "BOARD_MEMBER" as const,
  electedOn,
});

const ending = (
  actorPersonId: string,
  personId: string,
  endedOn = "2026-06-01",
) => ({
  actorPersonId,
  boardPositionId: `seat-${personId}`,
  endedOn,
});

const recovery = (
  actorPersonId: string,
  personIds: readonly string[],
  reason = "Every term ended at the annual meeting before it was minuted.",
) => ({
  actorPersonId,
  reason,
  seats: personIds.map((personId) => ({
    personId,
    position: "BOARD_MEMBER" as const,
    electedOn: "2026-04-14",
  })),
});

describe("an actor who holds no seat", () => {
  it("records no election, even on a register with no board", async () => {
    // The window this used to be: a register with no board that could act
    // let an administrator elect anybody. A vacant register is recorded through
    // a recovery now, which is its own act with its own audit entry.
    const { positions, seats } = service([]);

    await expect(
      positions.elect(election("admin", "chair"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(0);
  });

  it("corrects no seat, even one whose holder cannot sign in", async () => {
    const { positions, seats } = service([
      seatOf("wrong", "2026-04-14", null, false),
    ]);

    await expect(
      positions.endTerm(ending("admin", "wrong"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats[0]?.endedOn).toBeNull();
  });

  it("never records their own seat", async () => {
    const { positions, seats } = service([]);

    await expect(
      positions.elect(election("admin", "admin"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(0);
  });
});

describe("a board recovery on a vacant register", () => {
  it("records the whole board in one act", async () => {
    const { positions, seats } = service([]);

    const recorded = await positions.recoverBoard(
      recovery("admin", ["chair", "treasurer", "member"]),
      NOW,
    );

    expect(recorded.map((seat) => seat.personId)).toEqual([
      "chair",
      "treasurer",
      "member",
    ]);
    expect(seats).toHaveLength(3);
  });

  it("records it once every term has ended, whoever held them", async () => {
    const { positions, seats } = service([
      seatOf("outgoing", "2024-04-14", "2026-05-25"),
    ]);

    await positions.recoverBoard(recovery("admin", ["chair"]), NOW);

    expect(seats).toHaveLength(2);
  });

  it("writes its own audit action for each seat, with the reason", async () => {
    const { positions, record } = service([]);

    await positions.recoverBoard(
      recovery("admin", ["chair", "member"], "  The whole board resigned.  "),
      NOW,
    );

    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BOARD_RECOVERY_RECORDED",
        actorPersonId: "admin",
        targetPersonId: "chair",
        targetKind: "boardPosition",
        context: {
          position: "BOARD_MEMBER",
          electedOn: "2026-04-14",
          seats: 2,
          reason: "The whole board resigned.",
        },
      }),
      expect.anything(),
    );
    expect(record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "BOARD_POSITION_ELECTED" }),
      expect.anything(),
    );
  });

  it("is refused without a reason, and writes nothing", async () => {
    const { positions, seats, record } = service([]);

    await expect(
      positions.recoverBoard(recovery("admin", ["chair"], "   "), NOW),
    ).rejects.toMatchObject({ reason: "reason-required" });
    expect(seats).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("never seats the person recording it", async () => {
    const { positions, seats } = service([]);

    await expect(
      positions.recoverBoard(recovery("admin", ["chair", "admin"]), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(0);
  });

  it("refuses a seat listed twice", async () => {
    const { positions } = service([]);

    await expect(
      positions.recoverBoard(recovery("admin", ["chair", "chair"]), NOW),
    ).rejects.toMatchObject({ reason: "position-already-held" });
  });

  it("refuses an election dated past the horizon before it reads anything", async () => {
    const { positions, tx } = service([]);

    await expect(
      positions.recoverBoard(
        {
          ...recovery("admin", []),
          seats: [
            {
              personId: "chair",
              position: "CHAIR",
              electedOn: "2062-04-14",
            },
          ],
        },
        NOW,
      ),
    ).rejects.toMatchObject({ reason: "elected-too-far-ahead" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("does not count a withdrawn election that is still dated ahead as a board", async () => {
    const { positions, seats } = service([
      seatOf("withdrawn", "2026-07-01", "2026-06-15"),
    ]);

    await positions.recoverBoard(recovery("admin", ["chair"]), NOW);

    expect(seats).toHaveLength(2);
  });

  it("takes the register lock first, then each person's in order", async () => {
    const { positions, tx } = service([]);

    await positions.recoverBoard(recovery("admin", ["member", "chair"]), NOW);

    const keys = tx.$executeRaw.mock.calls.map((call) =>
      (call as unknown as [TemplateStringsArray, ...unknown[]]).slice(1).join(),
    );
    expect(keys).toEqual(["", "board-position:chair", "board-position:member"]);
  });

  it("says the register is vacant", async () => {
    const { positions } = service([
      seatOf("outgoing", "2024-04-14", "2026-05-25"),
    ]);

    await expect(positions.isVacant(NOW)).resolves.toBe(true);
  });
});

describe("a board recovery on a register that has a board", () => {
  it("is refused while a seat is held today", async () => {
    const { positions, seats, record } = service([
      seatOf("chair", "2026-04-14"),
    ]);

    await expect(
      positions.recoverBoard(recovery("admin", ["deputy"]), NOW),
    ).rejects.toMatchObject({ reason: "board-not-vacant" });
    expect(seats).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("is refused on a day when no seat is held but the next board is recorded", async () => {
    // The outgoing terms ended last week and the incoming board starts in 30
    // days: the register has no seat held today, and a board all the same.
    const { positions, seats } = service([
      seatOf("outgoing", "2024-04-14", "2026-05-25"),
      seatOf("incoming", "2026-07-01"),
    ]);

    await expect(
      positions.recoverBoard(recovery("admin", ["accomplice"]), NOW),
    ).rejects.toMatchObject({ reason: "board-not-vacant" });
    await expect(positions.isVacant(NOW)).resolves.toBe(false);
    expect(seats).toHaveLength(2);
  });

  it("is refused while the board's members cannot sign in yet", async () => {
    // A board whose members have not activated their accounts is a board: the
    // administrator invites them rather than recording another.
    const { positions } = service([seatOf("chair", "2026-04-14", null, false)]);

    await expect(
      positions.recoverBoard(recovery("admin", ["deputy"]), NOW),
    ).rejects.toMatchObject({ reason: "board-not-vacant" });
  });

  it("is refused for the second act, once the first has recorded a board", async () => {
    const { positions, seats } = service([]);

    await positions.recoverBoard(recovery("admin", ["chair"]), NOW);
    await expect(
      positions.recoverBoard(recovery("admin", ["member"]), NOW),
    ).rejects.toMatchObject({ reason: "board-not-vacant" });
    expect(seats).toHaveLength(1);
  });
});

describe("an actor who holds a seat", () => {
  it("records a colleague's election", async () => {
    const { positions, seats } = service([seatOf("chair", "2026-04-14")]);

    await positions.elect(election("chair", "deputy"), NOW);

    expect(seats).toHaveLength(2);
  });

  it("ends a colleague's seat", async () => {
    const { positions, seats } = service([
      seatOf("chair", "2026-04-14"),
      seatOf("deputy", "2026-04-14"),
    ]);

    await positions.endTerm(ending("chair", "deputy"), NOW);

    expect(seats[1]?.endedOn).toEqual(day("2026-06-01"));
  });
});
