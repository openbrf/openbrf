import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { occurrencesWithSignups } from "./event-attendance";

/**
 * What the series write path is told when it asks who is standing on a date.
 *
 * One question, two decisions in the answer, and both are rules rather than
 * details of a query.
 *
 * A withdrawal does not hold a date. Sign-ups are never deleted, so a refusal
 * that counted withdrawn ones would mean a series nobody is attending could
 * never be reshaped or removed again - a dated close turned into a permanent lock
 * on the calendar.
 *
 * A called-off date is still held, which shows up here as an absence: nothing in
 * the query asks about `cancelledAt`, so a standing sign-up refuses the edit
 * wherever the board has got to with the date. That the write path hands the
 * called-off ones over in the first place is `event.service.spec.ts`.
 *
 * The fake below filters, rather than answering with a fixed list. A fake that
 * ignored its arguments would pass whatever the query said, which is the way this
 * particular test goes wrong: the whole content of the function is which rows it
 * asks for.
 */

interface Row {
  occurrenceId: string;
  withdrawnAt: Date | null;
}

function build(rows: Row[]) {
  const findMany = vi.fn(
    async (args: {
      where: { occurrenceId: { in: string[] }; withdrawnAt: null };
      distinct: readonly string[];
    }) => {
      const wanted = new Set(args.where.occurrenceId.in);
      const matched = rows.filter(
        (row) =>
          wanted.has(row.occurrenceId) &&
          // Honoured rather than assumed: this is the rule under test.
          (args.where.withdrawnAt === null ? row.withdrawnAt === null : true),
      );
      const seen = new Set<string>();
      return matched
        .filter((row) => {
          if (seen.has(row.occurrenceId)) {
            return false;
          }
          seen.add(row.occurrenceId);
          return true;
        })
        .map((row) => ({ occurrenceId: row.occurrenceId }));
    },
  );

  return {
    db: { eventSignup: { findMany } } as unknown as PrismaService,
    findMany,
  };
}

const STANDING = { occurrenceId: "occurrence-25", withdrawnAt: null };
const WITHDRAWN = {
  occurrenceId: "occurrence-02",
  withdrawnAt: new Date("2027-04-01T09:00:00.000Z"),
};

describe("occurrencesWithSignups", () => {
  it("answers the ids somebody has a standing sign-up to", async () => {
    const { db } = build([STANDING]);

    await expect(
      occurrencesWithSignups(db, [
        "occurrence-18",
        "occurrence-25",
        "occurrence-02",
      ]),
    ).resolves.toEqual(new Set(["occurrence-25"]));
  });

  it("does not count a date somebody has stood down from", async () => {
    /*
     * The decision this file exists to state. The row is still there - a
     * withdrawal is a date on it and never a delete - and it must not hold the
     * calendar: a person who has said they are not coming cannot be the reason
     * the board may never move a cleaning day again.
     */
    const { db } = build([WITHDRAWN]);

    await expect(
      occurrencesWithSignups(db, ["occurrence-02"]),
    ).resolves.toEqual(new Set());
  });

  it("counts a date that has one of each", async () => {
    // Somebody stood down and somebody else did not, on the same date. The date
    // is held, because one person is still expecting to be there.
    const { db } = build([
      { occurrenceId: "occurrence-02", withdrawnAt: new Date() },
      { occurrenceId: "occurrence-02", withdrawnAt: null },
    ]);

    await expect(
      occurrencesWithSignups(db, ["occurrence-02"]),
    ).resolves.toEqual(new Set(["occurrence-02"]));
  });

  it("asks about the dates it was given and no others", async () => {
    const { db, findMany } = build([STANDING]);

    await occurrencesWithSignups(db, ["occurrence-18"]);

    expect(findMany.mock.calls[0]?.[0].where.occurrenceId.in).toEqual([
      "occurrence-18",
    ]);
  });

  it("says nothing about whether a date was called off", async () => {
    /*
     * Stated as the shape of the query rather than as an outcome, because the
     * outcome is an absence: there is no filter on the occurrence at all, so a
     * standing sign-up holds a date the board has called off exactly as it holds
     * any other. An implementation that quietly excluded called-off dates would
     * still satisfy every assertion above.
     */
    const { db, findMany } = build([STANDING]);

    await occurrencesWithSignups(db, ["occurrence-25"]);

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      occurrenceId: { in: ["occurrence-25"] },
      withdrawnAt: null,
    });
  });

  it("asks one row per date rather than one per person", async () => {
    // A date nine people have signed up to is one refusal and not nine, so the
    // query is distinct on the occurrence.
    const { db, findMany } = build([STANDING]);

    await occurrencesWithSignups(db, ["occurrence-25"]);

    expect(findMany.mock.calls[0]?.[0].distinct).toEqual(["occurrenceId"]);
  });

  it("asks nothing at all when no date is displaced", async () => {
    // The ordinary save: a corrected spelling displaces no date, and a query
    // whose answer is known before it is sent is a round trip in every one of
    // those.
    const { db, findMany } = build([STANDING]);

    await expect(occurrencesWithSignups(db, [])).resolves.toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("runs on the client it is handed, not on one of its own", async () => {
    /*
     * The property that makes the refusal decisive. The series write path calls
     * this inside the transaction that is about to do the writing, so a sign-up
     * taken while the board is saving the form either lands before this read and
     * refuses the edit or loses the race against the write. A function that
     * reached for an injected client would run outside that transaction and the
     * refusal would be a check with a gap after it.
     */
    const { db, findMany } = build([STANDING]);
    const other = build([]);

    await occurrencesWithSignups(db, ["occurrence-25"]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(other.findMany).not.toHaveBeenCalled();
  });
});
