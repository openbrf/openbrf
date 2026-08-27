/** Placeholder version constant until the first release is cut via changesets. */
export const VERSION = "0.0.0";

/**
 * Minimal typed Result helper for explicit error handling without exceptions.
 * Domain services return Result instead of throwing for expected failures.
 */
export type Result<T, E = Error> =
  { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
