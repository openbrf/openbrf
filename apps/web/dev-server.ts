/**
 * The development server's addresses, read from the environment.
 *
 * Kept apart from vite.config.ts so they can be tested without loading the
 * whole build configuration.
 */

/** PORT's default in the API (apps/api/src/config/env.ts). */
const DEFAULT_API_PORT = 3000;
const DEFAULT_WEB_PORT = 5173;

/**
 * A blank value means "not set", as it does for the API: Compose and a bare
 * `PORT=` line in .env both pass an unset variable as an empty string, and
 * `??` would take that for a value.
 */
function setValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A port read as a number, the way the API reads PORT, so "3e3" is 3000 here
 * as it is there rather than a host the proxy cannot parse.
 *
 * Throws on anything that is not a port. Vite takes 0 to mean "any free port",
 * which would defeat strictPort and leave APP_URL naming a port nothing listens
 * on, so a mistyped value has to stop the server rather than move it.
 */
function portNumber(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name} must be a port number from 1 to 65535, got "${raw}".`,
    );
  }
  return port;
}

/** Where the API listens in development: PORT in .env, 3000 by default. */
export function apiOrigin(env: NodeJS.ProcessEnv): string {
  const origin = setValue(env.OPENBRF_API_ORIGIN);
  if (origin !== undefined) return origin;
  const raw = setValue(env.PORT);
  const port = raw === undefined ? DEFAULT_API_PORT : portNumber("PORT", raw);
  return `http://localhost:${port}`;
}

/** The development server's port: OPENBRF_WEB_PORT in .env, 5173 by default. */
export function webPort(env: NodeJS.ProcessEnv): number {
  const raw = setValue(env.OPENBRF_WEB_PORT);
  return raw === undefined
    ? DEFAULT_WEB_PORT
    : portNumber("OPENBRF_WEB_PORT", raw);
}
