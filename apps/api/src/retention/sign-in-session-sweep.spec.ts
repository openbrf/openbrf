import { describe, expect, it } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { sweepExpiredSignInSessions } from "./sign-in-session-sweep";

/**
 * Which sessions the nightly sweep asks the database for, and in what order.
 *
 * The job is a scan, a lock and two `where` clauses, so what is worth asserting
 * is exactly those, on the pattern of the connected-app token sweep's spec: a
 * fake answering with a fixed count would pass whatever the query said. A
 * clause that is too narrow leaves the IP address of a browser nobody opens
 * again on file for as long as the person lives here, under a record of
 * processing that says it goes the night after; one that is too wide signs
 * somebody out, or erases a record of access a legal hold is keeping.
 *
 * So the tables below are implemented rather than stubbed. The people carry a
 * hold and a restriction as separate facts, and the fake evaluates each clause
 * of the withheld predicate against the fact it names - a predicate that
 * stopped asking about one of them would start deleting the sessions that fact
 * was protecting. A clause the fake does not recognise throws rather than
 * matching nothing. The database-backed half, and the ordering against a hold
 * committed by a concurrent writer, is in `purge.int-spec.ts`.
 */

const NOW = new Date("2027-06-01T03:53:00.000Z");

function daysFrom(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

interface PersonRow {
  id: string;
  /** A legal hold stands for them. */
  held?: boolean;
  /** They were granted a restriction under art. 18. */
  restricted?: boolean;
}

interface SessionRow {
  id: string;
  personId: string;
  expiresAt: Date;
}

type Clause = Record<string, unknown>;

/** Whether one clause of a person `where` holds for a fixture person. */
function matches(person: PersonRow, clause: Clause): boolean {
  return Object.entries(clause).every(([field, condition]) => {
    if (field === "id") {
      return person.id === condition;
    }
    if (field === "OR") {
      return (condition as Clause[]).some((each) => matches(person, each));
    }
    if (field === "legalHolds") {
      const some = (condition as { some?: { releasedAt?: null } }).some;
      if (some?.releasedAt !== null) {
        throw new Error(
          `The fake cannot read legalHolds: ${String(condition)}`,
        );
      }
      return person.held === true;
    }
    if (field === "processingRestrictedAt") {
      if ((condition as { not?: unknown }).not !== null) {
        throw new Error("The fake cannot read that processingRestrictedAt.");
      }
      return person.restricted === true;
    }
    throw new Error(`The fake has no column ${field} on a person.`);
  });
}

/** A database holding these people and their sessions, and nothing else. */
function build(options: { persons: PersonRow[]; sessions: SessionRow[] }) {
  const sessions = [...options.sessions];
  /** What the sweep did, in order: a lock, a check or a delete, per person. */
  const steps: string[] = [];

  const person = {
    findMany: async (args: { where: Clause }) => {
      const found = options.persons.filter((row) => matches(row, args.where));
      const id = args.where["id"];
      if (typeof id === "string") {
        steps.push(`check ${id}`);
      }
      return found.map((row) => ({ id: row.id }));
    },
  };

  const session = {
    deleteMany: async (args: {
      where: { expiresAt?: { lte: Date }; user?: { personId?: string } };
    }) => {
      const endedBy = args.where.expiresAt?.lte;
      const owner = args.where.user?.personId;
      steps.push(`delete ${owner ?? "everybody"}`);
      const kept = sessions.filter(
        (row) =>
          (endedBy !== undefined &&
            row.expiresAt.getTime() > endedBy.getTime()) ||
          (owner !== undefined && row.personId !== owner),
      );
      const count = sessions.length - kept.length;
      sessions.splice(0, sessions.length, ...kept);
      return { count };
    },
  };

  const tx = {
    person,
    session,
    // The legal hold key, read off the tagged template's value.
    $executeRaw: async (_strings: TemplateStringsArray, key: string) => {
      steps.push(`lock ${key}`);
      return 0;
    },
  };

  const prisma = {
    user: {
      // The scan: whose accounts hold a session ended by the bound it names.
      findMany: async (args: {
        where: { sessions: { some: { expiresAt: { lte: Date } } } };
      }) => {
        const endedBy = args.where.sessions.some.expiresAt.lte;
        const owners = [
          ...new Set(
            sessions
              .filter((row) => row.expiresAt.getTime() <= endedBy.getTime())
              .map((row) => row.personId),
          ),
        ];
        return owners.map((personId) => ({ personId }));
      },
    },
    person,
    session,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) =>
      work(tx),
  };

  return {
    prisma: prisma as unknown as PrismaService,
    steps,
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
      persons: [{ id: "person-1" }],
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
      persons: [{ id: "person-1" }],
      sessions: [
        { id: "ended", personId: "person-1", expiresAt: daysFrom(-1) },
        { id: "signed-in", personId: "person-1", expiresAt: daysFrom(20) },
      ],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.remaining()).toEqual(["signed-in"]);
  });

  it("keeps an ended session of a person under a hold, and of one under a restriction", async () => {
    /*
     * A session is a record of access as well as a credential, and a legal
     * hold or a restriction stops every purge for the person it stands for -
     * which the access report tells them. The two are separate people here, so
     * a predicate that stopped asking about either fails on that person; the
     * third, unprotected person's ended session in the same run shows the
     * check narrows the sweep rather than stopping it.
     */
    const sweep = build({
      persons: [
        { id: "held", held: true },
        { id: "restricted", restricted: true },
        { id: "free" },
      ],
      sessions: [
        { id: "held-ended", personId: "held", expiresAt: daysFrom(-3) },
        {
          id: "restricted-ended",
          personId: "restricted",
          expiresAt: daysFrom(-3),
        },
        { id: "free-ended", personId: "free", expiresAt: daysFrom(-3) },
      ],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.remaining()).toEqual(["held-ended", "restricted-ended"]);
  });

  it("takes the person's legal hold key before it reads whether they are withheld", async () => {
    /*
     * The order is the guarantee. The hold placement and the restriction grant
     * take the same key before they write, so a read taken under it cannot be
     * overtaken by either before this transaction commits - and a read taken
     * before it can. One person at a time, and the delete names that person
     * alone.
     */
    const sweep = build({
      persons: [{ id: "free" }],
      sessions: [{ id: "ended", personId: "free", expiresAt: daysFrom(-1) }],
    });

    await sweepExpiredSignInSessions(sweep.prisma, NOW);

    expect(sweep.steps).toEqual([
      "lock legal-hold:free",
      "check free",
      "delete free",
    ]);
  });

  it("returns how many it deleted, and nothing about whose they were", async () => {
    const sweep = build({
      persons: [{ id: "person-1" }, { id: "person-2" }],
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
