import { runInNewContext } from "node:vm";

import { expect, test } from "@playwright/test";

import { ENVIRONMENT_READER_SOURCE } from "../src/environment-reader";

/**
 * The retry in the container process probe of 90-runtime-role-privileges.spec.ts.
 *
 * That probe once failed on a healthcheck process it caught while the runtime
 * was still setting it up, when the application user is refused its
 * environment for a moment. The reader is the very source text the probe
 * embeds, evaluated here against a scripted /proc, so each case is deterministic
 * instead of waiting for the race.
 */

type Io = {
  read: (pid: string) => [string, string][];
  exists: (pid: string) => boolean;
  sleep: (milliseconds: number) => void;
};
type Read = { held?: [string, string][]; gone: boolean };

const makeEnvironmentReader = runInNewContext(
  `${ENVIRONMENT_READER_SOURCE}\nmakeEnvironmentReader;`,
) as (io: Io) => (pid: string) => Read;

function refusal(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A /proc whose reads take the given steps in turn; the last step repeats. */
function scripted(steps: (Error | [string, string][])[], exists = true) {
  const calls = { reads: 0, sleptFor: 0 };
  const read = makeEnvironmentReader({
    read: () => {
      const step = steps[Math.min(calls.reads++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
    exists: () => exists,
    sleep: (milliseconds) => {
      calls.sleptFor += milliseconds;
    },
  });
  return { read, calls };
}

const ENVIRONMENT: [string, string][] = [["PATH", "/usr/bin"]];

test("a read refused at first and then allowed returns the environment", () => {
  for (const code of ["EACCES", "EPERM"]) {
    const { read, calls } = scripted([
      refusal(code),
      refusal(code),
      ENVIRONMENT,
    ]);
    expect(read("424"), code).toEqual({ held: ENVIRONMENT, gone: false });
    expect(calls.reads, `${code} was read until it was allowed`).toBe(3);
    expect(calls.sleptFor, `${code} was waited out`).toBeGreaterThan(0);
  }
});

test("a read that is allowed at once is not waited for", () => {
  const { read, calls } = scripted([ENVIRONMENT]);
  expect(read("1")).toEqual({ held: ENVIRONMENT, gone: false });
  expect(calls).toEqual({ reads: 1, sleptFor: 0 });
});

test("a refusal that persists is reported as unreadable, after about a second", () => {
  const { read, calls } = scripted([refusal("EACCES")]);
  const outcome = read("424");
  expect(outcome.gone, "a process that is still there is not skipped").toBe(
    false,
  );
  expect(outcome.held, "and it is reported as unreadable").toBeUndefined();
  expect(calls.reads).toBeGreaterThan(1);
  expect(calls.sleptFor).toBeGreaterThanOrEqual(900);
  expect(calls.sleptFor).toBeLessThanOrEqual(2_000);
});

test("a process that exits during the retries is skipped", () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    const { read } = scripted([refusal("EACCES"), refusal(code)]);
    expect(read("424"), `${code} after a refusal`).toEqual({ gone: true });
  }
  // Refused to the end, but no longer listed: the exit is seen on the last look.
  const { read } = scripted([refusal("EACCES")], false);
  expect(read("424")).toEqual({ held: undefined, gone: true });
});

test("a failure that is not a refusal is not retried", () => {
  const { read, calls } = scripted([refusal("EIO")]);
  expect(read("424")).toEqual({ held: undefined, gone: false });
  expect(calls).toEqual({ reads: 1, sleptFor: 0 });
});
