import { createHash, randomBytes } from "node:crypto";

import { isValidPersonalIdentityNumber } from "@openbrf/shared";

/**
 * The one convention for a person a spec makes for itself.
 *
 * Nothing in the suite can delete a person again. The member register is
 * append-only by design, and there is no endpoint that removes an account, so
 * a spec that writes a fixed identity leaves it behind. A second run against
 * the same database then fails somewhere else entirely: approving a sign-up
 * request answers "that address already has an account", accepting an
 * invitation collides on the unique account email, and a screen that opens
 * "Elisabet Rydberg" finds two of her.
 *
 * The suite normally starts from empty volumes, so a fixed identity survives
 * CI. `OPENBRF_E2E_REUSE_STACK=true` is the documented way to run against a
 * stack that is already up, and that is the run these names exist for.
 *
 * The shared people in provision.ts deliberately do not use this. They are
 * looked up by name before they are created and several specs address them by
 * name, so they have to be the same people on every run.
 */

/**
 * One value per worker process, and the suite runs in a single worker, so every
 * spec in a run shares it. A spec that made its own would still be correct;
 * sharing one only keeps a register left over from a failed run readable.
 *
 * `--repeat-each` does not share it. Playwright gives every repeat a worker of
 * its own, so each repeat loads this module again and draws a new value.
 */
const RUN_ID = randomBytes(3).toString("hex");

/**
 * An address on the domain RFC 2606 reserves, unique to this run.
 *
 * The local part carries the suffix rather than a plus tag: an address book is
 * not a mail server, and nothing here should depend on how one treats them.
 */
export function uniqueEmail(local: string): string {
  return `${local}-${RUN_ID}@eksemplet.test`;
}

/**
 * A surname unique to this run, so a register search finds one person and a
 * screen opens the one the spec just wrote.
 */
export function uniqueSurname(name: string): string {
  return `${name}-${RUN_ID}`;
}

/**
 * A personal identity number unique to this run, and valid under the Luhn
 * check the register enforces.
 *
 * A fixed number is the same hazard as a fixed name, and one the screen cannot
 * see: an import matches a row by the number's blind index before anything
 * else, so a file carrying a number an earlier run wrote previews that row as
 * an update of the person the earlier run created rather than as a new one.
 *
 * The seed tells two people of one run apart; the run is mixed in here. The
 * birth date falls in 1940 to 1979 on days 1 to 28, which is a real date in
 * every month and leaves the fixed numbers other specs write (1985, 1990) out
 * of reach. The birth number runs from 001 to 999. The check digit is found by
 * asking the validator the register itself uses rather than by computing Luhn
 * a second time, so the number is exactly as valid as the import requires.
 *
 * Written with the century, so the import never has to infer one.
 */
export function uniquePersonalIdentityNumber(seed: string): string {
  const hash = createHash("sha256").update(`${seed}-${RUN_ID}`).digest();
  const draw = hash.readUInt32BE(0);

  const year = 1940 + (draw % 40);
  const month = 1 + (Math.floor(draw / 40) % 12);
  const day = 1 + (Math.floor(draw / 480) % 28);
  const birthNumber = 1 + (Math.floor(draw / 13_440) % 999);

  const birthDate =
    `${String(year)}` +
    `${String(month).padStart(2, "0")}` +
    `${String(day).padStart(2, "0")}`;
  const serial = String(birthNumber).padStart(3, "0");

  for (let checkDigit = 0; checkDigit < 10; checkDigit += 1) {
    const candidate = `${birthDate}-${serial}${String(checkDigit)}`;
    if (isValidPersonalIdentityNumber(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No check digit completes ${birthDate}-${serial}.`);
}
