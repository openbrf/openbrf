/**
 * Which of the two processes this is.
 *
 * The same modules serve the HTTP application and the `openbrf` command-line
 * tool, so that installing a plugin from a terminal and installing it from the
 * admin screen are the same operation rather than two implementations that
 * drift. Two things must not happen in the command-line process, and both
 * follow from this one flag rather than from a scattering of checks:
 *
 *   It must not become a second job worker. Two processes competing for the
 *   install queue would let the short-lived one win a job the long-lived one
 *   needs to finish by restarting itself.
 *
 *   It must not load plugin code. A plugin's bundle runs at full process
 *   privilege, and `openbrf plugin list` is not a reason to execute it.
 *
 * Not part of the validated environment: it is set by the command-line entry
 * point itself, and an operator setting it by hand would only be able to break
 * the server.
 */
export type ProcessRole = "server" | "cli";

export const PROCESS_ROLE_VARIABLE = "OPENBRF_PROCESS_ROLE";

export function processRole(): ProcessRole {
  return process.env[PROCESS_ROLE_VARIABLE] === "cli" ? "cli" : "server";
}
