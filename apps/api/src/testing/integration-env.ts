import { loadNearestEnvFile } from "../config/load-env-file";
import { type Env, loadEnv } from "../config/env";
import { isValidPersonalIdentityNumber } from "../crypto/personal-data";

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

/** A per-run suffix, so two overlapping runs cannot collide on a fixed id. */
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
 * a lookup that was about somebody else's person, and a suite that leaves a row
 * behind on purpose keeps answering it on every later run. That is not
 * hypothetical: two retention suites and the demo data all held +46701234567,
 * and the seed suite's phone lookup found whichever row came back first.
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
 * entropy, and the suites that write it leave their carrier behind. Nothing
 * searches by that index yet, which is the argument for fixing it now - the
 * suite that eventually does would inherit rows from every run before it.
 *
 * Twelve digits rather than the six-plus-four form the fixtures used to write.
 * The short form has no century, so the parser infers one from today's date,
 * and a fixture that resolves to 1958 now would resolve to 2058 once the
 * reference year passes it. The twelve-digit form is also what normalization
 * produces, so the value stored and the value indexed are the same string.
 *
 * The years 1940 to 1979 are chosen, not arbitrary: every identity number
 * written anywhere in this repository today falls outside them - the demo data
 * holds 1981 and 2012, the register suite held 1981, 2001 and 2012, the site
 * suite holds 1985 - so a collision needs a deliberate choice rather than luck.
 * Everyone in that range is an adult, and days 1 to 28 are a real date in every
 * month of every year, leap or not.
 *
 * The check digit is found by asking the shared validator rather than by
 * computing Luhn a second time: exactly one of the ten digits satisfies it, and
 * a second implementation is a second thing that can disagree with the parser
 * the blind index depends on.
 */
export function runIdentityNumber(seed: string): string {
  let hash = 0n;
  for (const character of seed) {
    hash = (hash * 131n + BigInt(character.codePointAt(0) ?? 0)) % 100_000_000n;
  }

  const year = 1940 + Number(hash % 40n);
  const month = 1 + Number((hash / 40n) % 12n);
  const day = 1 + Number((hash / 480n) % 28n);
  // 001 to 999: a birth number of 000 is never issued, and a fixture is read
  // by people who should not have to wonder whether that is deliberate.
  const birthNumber = 1 + Number((hash / 13_440n) % 999n);

  const base =
    `${String(year)}` +
    `${String(month).padStart(2, "0")}` +
    `${String(day).padStart(2, "0")}` +
    `${String(birthNumber).padStart(3, "0")}`;

  for (let checkDigit = 0; checkDigit < 10; checkDigit += 1) {
    const candidate = `${base}${String(checkDigit)}`;
    if (isValidPersonalIdentityNumber(candidate)) {
      return candidate;
    }
  }
  /* c8 ignore next 4 -- unreachable: one of ten digits always satisfies Luhn */
  throw new Error(
    `No check digit completes ${base} into a valid personal identity number.`,
  );
}
