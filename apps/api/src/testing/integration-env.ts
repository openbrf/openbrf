import { testPersonalIdentityNumber } from "@openbrf/shared/testing";

import { loadNearestEnvFile } from "../config/load-env-file";
import { type Env, loadEnv } from "../config/env";

/**
 * Loads the environment for integration tests, which need a real database.
 *
 * Fails with an actionable message rather than a stack trace when the
 * environment is not configured, because "copy .env.example" is the fix and a
 * Zod issue list does not say so. Note that this only validates configuration:
 * a database that is down still surfaces later, as a connection error.
 *
 * DATABASE_URL is required here even though the schema leaves it optional. A
 * production server runs without it - the entrypoint drops the owner's
 * credentials before it starts - but these suites create and delete the rows
 * they assert on, which is the owner's work and not the application role's.
 *
 * NODE_ENV is set on process.env rather than only in the copy handed to
 * loadEnv, because things outside this Env read it directly - JobQueueService
 * decides whether to start the queue from it. Leaving that to each suite means
 * one that forgets boots its modules in the wrong mode.
 */
export function loadEnvForIntegrationTests(): Env & { DATABASE_URL: string } {
  loadNearestEnvFile();
  process.env.NODE_ENV = "test";
  // Every injected request arrives from loopback, and the suites stand in for
  // members behind a proxy there, each with an address of its own in the
  // forwarded header. Without the proxy named, the header is not read and one
  // suite's requests would all spend a single budget on the public routes.
  process.env.TRUSTED_PROXIES ??= "127.0.0.1";

  let env: Env;
  try {
    env = loadEnv(process.env);
  } catch (cause) {
    throw new Error(
      "Integration tests need a configured environment. Copy .env.example to " +
        ".env and start the database with `docker compose up -d db`.",
      { cause },
    );
  }

  if (env.DATABASE_URL === undefined) {
    throw new Error(
      "Integration tests connect as the schema owner, so DATABASE_URL has to " +
        "be set. Copy .env.example to .env.",
    );
  }
  return { ...env, DATABASE_URL: env.DATABASE_URL };
}

/**
 * Puts one environment variable back the way a suite found it.
 *
 * `process.env` coerces assigned values to strings, so restoring a variable
 * that was absent by assigning the saved `undefined` stores the literal string
 * "undefined". `delete` is the only way to remove one. The runner reuses its
 * worker process, so a later suite would read OPENBRF_DATA_DIR="undefined",
 * resolve that against the working directory, and scan and write ./undefined.
 */
export function restoreEnvironmentVariable(
  name: string,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

/** A per-call suffix, so nothing collides with a fixed id from elsewhere. */
export function runSuffix(): string {
  return process.hrtime.bigint().toString(36);
}

/**
 * A per-run phone number, for the same reason ids get a suffix.
 *
 * A phone number carries a blind index, and the index normalises every spelling
 * of a number to one value: "070-123 45 67" and "+46701234567" reach the same
 * row, which is the property the seed suite exists to assert. So a number
 * written as a literal in a fixture is not merely duplicated data - it answers
 * a lookup that was about somebody else's person. A worker runs several suites
 * against its database in turn, and append-only register rows keep the people
 * they name, so a literal written by one suite goes on answering the next
 * one's lookup. That is not hypothetical: two retention suites and the demo
 * data all held +46701234567, and the seed suite's phone lookup found whichever
 * row came back first.
 *
 * The prefix is 076 rather than the 070, 072 and 073 the demo data uses, so a
 * collision needs a deliberate choice rather than seven unlucky digits.
 */
export function runPhone(seed: string): string {
  let digits = 0n;
  for (const character of seed) {
    digits =
      (digits * 131n + BigInt(character.codePointAt(0) ?? 0)) % 10_000_000n;
  }
  return `+4676${digits.toString().padStart(7, "0")}`;
}

/**
 * A per-run personal identity number, for the reason {@link runPhone} gives.
 *
 * The same hazard one step behind the phone: the number carries a blind index
 * too, an expensive one precisely because a birth date leaves it almost no
 * entropy, and the suites that write it leave the person holding it behind.
 * Nothing searches by that index yet, which is the argument for fixing it now
 * - the suite that eventually does would match every personal identity number
 * its worker wrote before it.
 *
 * What the number looks like - the years it is drawn from and why, the form it
 * is written in - is decided by `testPersonalIdentityNumber` in
 * `@openbrf/shared/testing`, which the end-to-end specs draw from too. This
 * only turns the seed into a draw. The hash is kept as it was, so a seed
 * answers the number it always has.
 */
export function runIdentityNumber(seed: string): string {
  let hash = 0n;
  for (const character of seed) {
    hash = (hash * 131n + BigInt(character.codePointAt(0) ?? 0)) % 100_000_000n;
  }
  return testPersonalIdentityNumber(Number(hash));
}
