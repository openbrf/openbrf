import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { sweepExpiredSignInSessions } from "./sign-in-session-sweep";

/**
 * Which sessions the nightly sweep asks the database for.
 *
 * The job is one `where` clause, so what is worth asserting is exactly that
 * clause, on the pattern of the connected-app token sweep's spec: a fake
 * answering with a fixed count would pass whatever the query said. A clause
 * that is too narrow leaves the IP address of a browser nobody opens again on
 * file for as long as the person lives here, under a record of processing that
 * says it goes the night after; one that is too wide signs somebody out, or
 * erases a record of access a legal hold is keeping.
 *
 * So the tables below are implemented rather than stubbed: they honour the end
 * of a session and the person it belongs to, and a sweep that stopped asking
 * for either would start deleting the rows that condition was protecting.
 */

const NOW = new Date("2027-06-01T03:53:00.000Z");

function daysFrom(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

interface PersonRow {
  id: string;
  /** Under a standing legal hold or restriction. */
  withheld: boolean;
}

interface SessionRow {
  id: string;
  personId: string;
  expiresAt: Date;
}

interface SessionWhere {
  expiresAt?: { lte: Date };
  user?: { personId?: { notIn: string[] } };
}

/** A database holding these people and their sessions, and nothing else. */
function build(options: { persons: PersonRow[]; sessions: SessionRow[] }) {
  const sessions = [...options.sessions];

  const prisma = {
    person: {
      // The two conditions `withheldPersonIds` asks about, answered from the
      // flag rather than from rows of holds and requests.
      findMany: vi.fn(async () =>
        options.persons
          .filter((person) => person.withheld)
          .map((person) => ({ id: person.id })),
      ),
    },
    session: {
      deleteMany: vi.fn(async (args: { where: SessionWhere }) => {
        const endedBy = args.where.expiresAt?.lte;
        const spared = args.where.user?.personId?.notIn;
        const kept = sessions.filter(
          (row) =>
            (endedBy !== undefined &&
              row.expiresAt.getTime() > endedBy.getTime()) ||
            (spared !== undefined && spared.includes(row.personId)),
        );
        const count = sessions.length - kept.length;
        sessions.splice(0, sessions.length, ...kept);
        return { count };
      }),
    },
  };

  return {
    prisma: prisma as unknown as PrismaService,
    /** What survived the sweep, by id. */
    remaining: () => sessions.map((row) => row.id),
  };
}

describe("the nightly sweep of sign-in sessions", () => {
  it("deletes a session that has ended", async () => {
    /*
     * A session that has ended can no longer be presented, and what is left on
     * it is when and from where somebody signed in: a purpose that has ended.
     */
    const sweep = build({
      persons: [{ id: "person-1", withheld: false }],
      sessions: [
        { id: "ended", personId: "person-1", expiresAt: daysFrom(-1) },
        { id: "just-ended", personId: "person-1", expiresAt: NOW },
      ],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.remaining()).toEqual([]);
  });

  it("keeps a session that has not ended", async () => {
    // Deleting it would sign somebody out, which a clock must never do.
    const sweep = build({
      persons: [{ id: "person-1", withheld: false }],
      sessions: [
        { id: "signed-in", personId: "person-1", expiresAt: daysFrom(20) },
      ],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.remaining()).toEqual(["signed-in"]);
  });

  it("keeps an ended session of a person under a hold or a restriction", async () => {
    /*
     * A session is a record of access as well as a credential, and a legal
     * hold or a restriction stops every purge for the person it stands for -
     * which the access report tells them. The other person's ended session in
     * the same run is what shows the clause narrows and does not stop the
     * sweep.
     */
    const sweep = build({
      persons: [
        { id: "held", withheld: true },
        { id: "free", withheld: false },
      ],
      sessions: [
        { id: "held-ended", personId: "held", expiresAt: daysFrom(-3) },
        { id: "free-ended", personId: "free", expiresAt: daysFrom(-3) },
      ],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.remaining()).toEqual(["held-ended"]);
  });

  it("returns how many it deleted, and nothing about whose they were", async () => {
    const sweep = build({
      persons: [
        { id: "person-1", withheld: false },
        { id: "person-2", withheld: false },
      ],
      sessions: [
        { id: "a", personId: "person-1", expiresAt: daysFrom(-1) },
        { id: "b", personId: "person-2", expiresAt: daysFrom(-40) },
        { id: "c", personId: "person-2", expiresAt: daysFrom(1) },
      ],
    });

    await expect(sweepExpiredSignInSessions(sweep.prisma, NOW)).resolves.toBe(
      2,
    );
  });
});
