import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { sweepConnectedAppTokens } from "./connected-app-token-sweep";

/**
 * Which rows the nightly sweep asks the database for.
 *
 * The whole of this job is two `where` clauses, so what is worth asserting is
 * exactly those: a fake answering with a fixed count would pass whatever the
 * query said, and the failures here are silent in both directions. A clause
 * that is too narrow leaves spent credentials on file for ever under a record
 * of processing that says they are erased; one that is too wide deletes a token
 * an app is still acting through, which is a revocation performed by a clock.
 *
 * So the tables below are implemented rather than stubbed: they honour the
 * expiry bound, the replay window and the live-token guard, and a sweep that
 * stopped asking for one of them would start deleting the rows that condition
 * was protecting.
 */

const NOW = new Date("2027-06-01T03:53:00.000Z");

/** The refresh lifetime the sweep waits out, mirrored from the module. */
const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function minutesAfter(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60 * 1000);
}

interface AccessRow {
  id: string;
  expiresAt: Date;
  /** The refresh row it was issued from, where it was issued from one. */
  refreshId: string | null;
}

interface RefreshRow {
  id: string;
  expiresAt: Date;
  revoked: Date | null;
}

interface AccessWhere {
  expiresAt: { lte: Date };
}

interface RefreshWhere {
  expiresAt?: { lte: Date };
  accessTokens?: { none: Record<string, never> };
  OR?: ({ revoked: null } | { revoked: { lte: Date } })[];
}

/** A database holding these token rows, and nothing else. */
function build(options: { access?: AccessRow[]; refresh?: RefreshRow[] }) {
  const access = [...(options.access ?? [])];
  const refresh = [...(options.refresh ?? [])];
  /** Every table the sweep wrote to, in the order it wrote to them. */
  const writes: string[] = [];

  const prisma = {
    oauthAccessToken: {
      deleteMany: vi.fn(async (args: { where: AccessWhere }) => {
        writes.push("access");
        const expiredBy = args.where.expiresAt.lte;
        const kept = access.filter(
          (row) => row.expiresAt.getTime() > expiredBy.getTime(),
        );
        const count = access.length - kept.length;
        access.splice(0, access.length, ...kept);
        return { count };
      }),
    },
    oauthRefreshToken: {
      deleteMany: vi.fn(async (args: { where: RefreshWhere }) => {
        writes.push("refresh");
        const expiredBy = args.where.expiresAt?.lte;
        /*
         * The replay window, read off the clause rather than assumed. A sweep
         * that dropped the OR would be asking for every expired row whatever
         * its revocation date, which is the case the next assertion is about.
         */
        const revokedBy = args.where.OR?.find(
          (clause): clause is { revoked: { lte: Date } } =>
            clause.revoked !== null,
        )?.revoked.lte;
        const keepsRevoked = args.where.OR !== undefined;
        // The live-token guard, honoured only where it was asked for.
        const guarded = args.where.accessTokens !== undefined;
        const stillHeld = new Set(
          access
            .map((row) => row.refreshId)
            .filter((id): id is string => id !== null),
        );

        const kept = refresh.filter((row) => {
          if (
            expiredBy !== undefined &&
            row.expiresAt.getTime() > expiredBy.getTime()
          ) {
            return true;
          }
          if (guarded && stillHeld.has(row.id)) {
            return true;
          }
          if (!keepsRevoked || row.revoked === null) {
            return false;
          }
          return (
            revokedBy === undefined ||
            row.revoked.getTime() > revokedBy.getTime()
          );
        });
        const count = refresh.length - kept.length;
        refresh.splice(0, refresh.length, ...kept);
        return { count };
      }),
    },
    oauthConsent: { deleteMany: vi.fn() },
  };

  return {
    prisma: prisma as unknown as PrismaService,
    consents: prisma.oauthConsent.deleteMany,
    writes,
    /** What survived the sweep, by id. */
    remaining: () => ({
      access: access.map((row) => row.id),
      refresh: refresh.map((row) => row.id),
    }),
  };
}

describe("access tokens", () => {
  it("deletes every row past its expiry and keeps the live ones", async () => {
    /*
     * An access token lasts fifteen minutes and every call resolves it against
     * this table, so a row past that moment is the credential of a call that
     * can no longer be made - and it still names the account, the client and
     * the scopes it was issued with.
     */
    const sweep = build({
      access: [
        { id: "expired", expiresAt: daysBefore(1), refreshId: null },
        { id: "just-expired", expiresAt: NOW, refreshId: null },
        { id: "live", expiresAt: minutesAfter(9), refreshId: null },
      ],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ accessTokens: 2 });
    expect(sweep.remaining().access).toEqual(["live"]);
  });
});

describe("refresh tokens", () => {
  it("deletes one that ran out without ever being revoked", async () => {
    // Nothing was taken back and nothing exchanged it again: the row simply
    // ran out, and there is no replay left to recognise.
    const sweep = build({
      refresh: [{ id: "ran-out", expiresAt: daysBefore(1), revoked: null }],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ refreshTokens: 1 });
    expect(sweep.remaining().refresh).toEqual([]);
  });

  it("keeps a revoked one while it could still be presented", async () => {
    /*
     * Presenting a revoked refresh token is what a replay looks like, and the
     * provider answers it by invalidating the whole family. A row deleted
     * before its lifetime is out turns that into an ordinary miss: the attempt
     * still fails, and the signal that somebody took a token is gone with the
     * row it was written on.
     */
    const sweep = build({
      refresh: [
        {
          id: "revoked-yesterday",
          expiresAt: daysBefore(1),
          revoked: daysBefore(1),
        },
      ],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ refreshTokens: 0 });
    expect(sweep.remaining().refresh).toEqual(["revoked-yesterday"]);
  });

  it("deletes a revoked one once the lifetime has run out", async () => {
    const sweep = build({
      refresh: [
        {
          id: "revoked-long-ago",
          expiresAt: daysBefore(20),
          revoked: new Date(NOW.getTime() - REFRESH_TOKEN_LIFETIME_MS - 1000),
        },
      ],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ refreshTokens: 1 });
    expect(sweep.remaining().refresh).toEqual([]);
  });

  it("keeps one an app is still acting through", async () => {
    /*
     * Deleting a refresh row cascades to the access tokens issued from it, so
     * taking one with a live token hanging off it would cut the connection off
     * mid-minute. That is a revocation, which is a deliberate act with an audit
     * entry behind it and never something a clock performs.
     */
    const sweep = build({
      access: [
        { id: "live", expiresAt: minutesAfter(9), refreshId: "refresh-1" },
      ],
      refresh: [{ id: "refresh-1", expiresAt: daysBefore(1), revoked: null }],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ refreshTokens: 0 });
    expect(sweep.remaining().refresh).toEqual(["refresh-1"]);
  });

  it("keeps one that has not run out", async () => {
    const sweep = build({
      refresh: [{ id: "live", expiresAt: minutesAfter(60), revoked: null }],
    });

    await expect(
      sweepConnectedAppTokens(sweep.prisma, NOW),
    ).resolves.toMatchObject({ refreshTokens: 0 });
    expect(sweep.remaining().refresh).toEqual(["live"]);
  });
});

describe("what the sweep leaves alone", () => {
  it("takes the access rows first, which is what the live-token guard reads", async () => {
    // The guard asks for a refresh row with no access row left beside it, and
    // that only means "nothing live" once the expired ones have gone.
    const sweep = build({
      access: [{ id: "expired", expiresAt: daysBefore(1), refreshId: "r" }],
      refresh: [{ id: "r", expiresAt: daysBefore(1), revoked: null }],
    });

    await expect(sweepConnectedAppTokens(sweep.prisma, NOW)).resolves.toEqual({
      accessTokens: 1,
      refreshTokens: 1,
    });
    expect(sweep.writes).toEqual(["access", "refresh"]);
  });

  it("deletes no consent", async () => {
    /*
     * The grant itself, and it is not held on a clock: it lasts until the
     * person disconnects the app or until their purge erases the account and
     * takes it through the cascade. A sweep that removed one would disconnect
     * somebody's app because a token had expired.
     */
    const sweep = build({
      access: [{ id: "expired", expiresAt: daysBefore(1), refreshId: null }],
      refresh: [{ id: "ran-out", expiresAt: daysBefore(1), revoked: null }],
    });

    await sweepConnectedAppTokens(sweep.prisma, NOW);

    expect(sweep.consents).not.toHaveBeenCalled();
  });
});
