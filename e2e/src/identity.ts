import { randomBytes } from "node:crypto";

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
