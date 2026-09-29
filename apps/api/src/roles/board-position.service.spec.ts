import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { BoardPositionService } from "./board-position.service";

/**
 * Who may write the board's seats, where the int-spec cannot reach: an
 * instance on which nobody holds a seat, or on which every seat lies ahead of
 * or behind today. The integration database is shared by suites that seat a
 * board of their own, so those states are only reachable here.
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
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { positions: new BoardPositionService(prisma, audit), seats, tx };
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

describe("an actor who holds no seat, on an instance with no board yet", () => {
  it("records the first board", async () => {
    const { positions, seats } = service([]);

    await positions.elect(election("admin", "chair"), NOW);

    expect(seats).toHaveLength(1);
  });

  it("records every seat of it while none belongs to somebody who can sign in", async () => {
    // Chair, treasurer and a member, none of whom has activated an account:
    // nobody could act as the board yet, so the meeting's minutes are still the
    // administrator's to enter.
    const { positions, seats } = service([]);

    await positions.elect(election("admin", "chair"), NOW);
    await positions.elect(election("admin", "treasurer"), NOW);
    await positions.elect(election("admin", "member"), NOW);

    expect(seats.map((seat) => seat.personId)).toEqual([
      "chair",
      "treasurer",
      "member",
    ]);
  });

  it("corrects a seat of it, while none belongs to somebody who can sign in", async () => {
    const { positions, seats } = service([
      seatOf("wrong", "2026-04-14", null, false),
    ]);

    await positions.endTerm(ending("admin", "wrong"), NOW);

    expect(seats[0]?.endedOn).toEqual(day("2026-06-01"));
  });

  it("never records their own seat, even then", async () => {
    const { positions, seats } = service([]);

    await expect(
      positions.elect(election("admin", "admin"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(0);
  });

  it("takes the register lock before the person's, as every writer does", async () => {
    const { positions, tx } = service([]);

    await positions.elect(election("admin", "chair"), NOW);

    const keys = tx.$executeRaw.mock.calls.map((call) =>
      (call as unknown as [TemplateStringsArray, ...unknown[]]).slice(1).join(),
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(keys[1]).toBe("board-position:chair");
  });
});

describe("an actor who holds no seat, once a board has been elected", () => {
  it("records nothing while a seat is held today", async () => {
    const { positions, seats } = service([seatOf("chair", "2026-04-14")]);

    await expect(
      positions.elect(election("admin", "deputy"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(1);
  });

  it("records nothing on a day when no seat is held but the next board is recorded", async () => {
    // The outgoing terms ended last week and the incoming board starts in 30
    // days: the register has no seat held today, and a board all the same.
    const { positions, seats } = service([
      seatOf("outgoing", "2024-04-14", "2026-05-25"),
      seatOf("incoming", "2026-07-01"),
    ]);

    await expect(
      positions.elect(election("admin", "accomplice", "2026-06-01"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    await expect(
      positions.endTerm(ending("admin", "incoming"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
    expect(seats).toHaveLength(2);
    expect(seats[1]?.endedOn).toBeNull();
  });

  it("records nothing while a seat that has not begun belongs to somebody who can sign in", async () => {
    const { positions } = service([seatOf("incoming", "2026-07-01")]);

    await expect(
      positions.elect(election("admin", "deputy"), NOW),
    ).rejects.toMatchObject({ reason: "board-seat-required" });
  });

  it("does not count a withdrawn election that is still dated ahead as a board", async () => {
    const { positions, seats } = service([
      seatOf("withdrawn", "2026-07-01", "2026-06-15"),
    ]);

    await positions.elect(election("admin", "chair"), NOW);

    expect(seats).toHaveLength(2);
  });

  it("does not count a withdrawn election as a board", async () => {
    const { positions, seats } = service([
      seatOf("withdrawn", "2026-07-01", "2026-06-01"),
    ]);

    await positions.elect(election("admin", "chair"), NOW);

    expect(seats).toHaveLength(2);
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
