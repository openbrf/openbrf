import { describe, expect, it } from "vitest";

import {
  erasureSourceFacts,
  type SourceFacts,
} from "../testing/erasure-source-facts";

/**
 * The order of the night against a granted erasure request, as a test.
 *
 * A granted erasure request (GDPR art. 17) brings every purge that reads it
 * forward for one person, and the service-data purge is the job that marks the
 * request executed and closes it. A purge that looks for the request after that
 * finds nothing open: it does not select the person, and their rows wait out
 * their own retention window while the request says it was carried out. So
 * every scheduled job that reads granted erasure requests runs strictly before
 * the job that closes them.
 *
 * Nothing here lists those jobs. `testing/erasure-source-facts.ts` finds each
 * one by walking the source, and this file places it in the night by the
 * schedule it registers itself. A purge written later is held to the order by
 * the same walk, whether or not it is named anywhere.
 *
 * Order is necessary and not sufficient, which is why it is not the only rule
 * over that walk: a job that ran first and did not get through a person leaves
 * the order intact and the rows standing. `erasure-domains.spec.ts` is the
 * other half, and holds the closing job to verifying rather than assuming.
 */

/**
 * Files that read granted erasure requests on a request path rather than at a
 * time of night, and why each one may.
 *
 * Checked in both directions. A file named here that no longer reads the
 * requests, or that has started registering a schedule, is an error: an entry
 * nothing uses is one the next edit to that file inherits without anybody
 * deciding to give it.
 */
const UNSCHEDULED_READERS = new Map([
  [
    "retention/withheld-persons.ts",
    "Defines the selector. It runs inside whichever job calls it, and that " +
      "job's own file is what this test places in the night.",
  ],
  [
    "data-protection/data-subject-request.service.ts",
    "Closes a granted request when the person moves in again, inside the " +
      "move-in's own transaction. A request closed there stops being an " +
      "instruction to every purge at once, so none is left behind by it.",
  ],
]);

/**
 * The minute of the day a cron runs at, when it runs once a day at a fixed one.
 *
 * Every schedule goes through `JobQueueService.schedule`, which names no time
 * zone, so every cron here is read on the same clock and two of them compare
 * directly. A schedule of any other shape cannot be placed before or after a
 * minute, and is refused rather than guessed at.
 */
function minuteOfDay(cron: string): number | undefined {
  const match = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron);
  if (match === null) {
    return undefined;
  }
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  return minute > 59 || hour > 23 ? undefined : hour * 60 + minute;
}

function clock(minuteOfTheDay: number): string {
  const hours = String(Math.floor(minuteOfTheDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfTheDay % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const facts = erasureSourceFacts();

/** Scheduled jobs that mark a request executed, which closes it. */
const closers = facts.filter(
  (file) => file.marksRequestExecuted && file.schedules.length > 0,
);

/** Scheduled jobs that read granted requests, the closing ones included. */
const readers = facts.filter(
  (file) => file.readsGrantedErasure && file.schedules.length > 0,
);

describe("the night's order against a granted erasure request", () => {
  it("is asserted over a source tree with a closing job and a reader in it", () => {
    // Without this, a moved directory or a renamed selector would turn every
    // assertion below into one that passes because it found nothing to order.
    expect(facts.length).toBeGreaterThan(100);
    expect(closers.map((file) => file.path)).not.toEqual([]);
    expect(
      readers
        .filter((file) => !file.marksRequestExecuted)
        .map((file) => file.path),
    ).not.toEqual([]);
  });

  it("marks a request executed only from a scheduled job", () => {
    // Anywhere else, the request would be closed at whatever moment somebody
    // acted, before every purge that reads it had run.
    const offenders = facts
      .filter(
        (file) => file.marksRequestExecuted && file.schedules.length === 0,
      )
      .map(
        (file) =>
          `${file.path} marks an erasure request executed and registers no ` +
          "schedule, so it can close the request before the purges that read it",
      );

    expect(offenders).toEqual([]);
  });

  it("runs every job that reads a granted request strictly before the job that closes it", () => {
    const offenders: string[] = [];
    const placed = (
      file: SourceFacts,
    ): { minute: number | undefined; cron: string | undefined }[] =>
      file.schedules.map(({ cron }) => ({
        cron,
        minute: cron === undefined ? undefined : minuteOfDay(cron),
      }));

    /*
     * The earliest closing job is the one every reader has to beat. A second
     * job that also closes requests reads them too, so it is held to the same
     * minute as every other reader and fails if it runs after the first.
     */
    let closing: { minute: number; path: string } | undefined;
    for (const closer of closers) {
      for (const { cron, minute } of placed(closer)) {
        if (minute === undefined) {
          offenders.push(
            `${closer.path} closes erasure requests on a schedule this test ` +
              `cannot place in the night: ${String(cron)}`,
          );
        } else if (closing === undefined || minute < closing.minute) {
          closing = { minute, path: closer.path };
        }
      }
    }

    for (const reader of readers) {
      if (closing === undefined || reader.path === closing.path) {
        continue;
      }
      for (const { cron, minute } of placed(reader)) {
        if (minute === undefined) {
          offenders.push(
            `${reader.path} reads granted erasure requests on a schedule this ` +
              `test cannot place in the night: ${String(cron)}. It places a ` +
              "cron that runs once a day at a fixed minute, passed as a literal " +
              "or as a constant declared in the same file",
          );
        } else if (minute >= closing.minute) {
          offenders.push(
            `${reader.path} reads granted erasure requests at ${clock(minute)}, ` +
              `which is not before ${clock(closing.minute)}, when ` +
              `${closing.path} marks them executed and closes them`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("places every reader of granted requests in the night, or names why it is not there", () => {
    const offenders = facts
      .filter(
        (file) =>
          file.readsGrantedErasure &&
          file.schedules.length === 0 &&
          !UNSCHEDULED_READERS.has(file.path),
      )
      .map(
        (file) =>
          `${file.path} reads granted erasure requests and registers no ` +
          "schedule, so nothing here can place it before the job that closes " +
          "them: schedule the job in this file, or name the file among the " +
          "unscheduled readers with the reason it reads them outside the night",
      );

    expect(offenders).toEqual([]);
  });

  it("names no unscheduled reader that has stopped being one", () => {
    const stale: string[] = [];
    for (const path of UNSCHEDULED_READERS.keys()) {
      const file = facts.find((candidate) => candidate.path === path);
      if (file === undefined) {
        stale.push(`${path} no longer exists`);
      } else if (!file.readsGrantedErasure) {
        stale.push(`${path} no longer reads granted erasure requests`);
      } else if (file.schedules.length > 0) {
        stale.push(
          `${path} registers a schedule, so it is placed like a purge`,
        );
      }
    }

    expect(stale).toEqual([]);
  });
});
