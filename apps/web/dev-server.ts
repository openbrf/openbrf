/**
 * The development server's addresses, read from the environment.
 *
 * Kept apart from vite.config.ts so they can be tested without loading the
 * whole build configuration.
 */

/** PORT's default in the API (apps/api/src/config/env.ts). */
const DEFAULT_API_PORT = "3000";
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

/** Where the API listens in development: PORT in .env, 3000 by default. */
export function apiOrigin(env: NodeJS.ProcessEnv): string {
  return (
    setValue(env.OPENBRF_API_ORIGIN) ?? `http://localhost:${setValue(env.PORT) ?? DEFAULT_API_PORT}`
  );
}

/**
 * The development server's port: OPENBRF_WEB_PORT in .env, 5173 by default.
 *
 * Throws on anything that is not a port. Vite takes 0 to mean "any free port",
 * which would defeat strictPort and leave APP_URL naming a port nothing listens
 * on, so a mistyped value has to stop the server rather than move it.
 */
export function webPort(env: NodeJS.ProcessEnv): number {
  const raw = setValue(env.OPENBRF_WEB_PORT);
  if (raw === undefined) return DEFAULT_WEB_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OPENBRF_WEB_PORT must be a port number from 1 to 65535, got "${raw}".`);
  }
  return port;
}
