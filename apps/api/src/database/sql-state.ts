/**
 * Prisma's codes for an error PostgreSQL reported that Prisma has no code of
 * its own for, on a raw query (P2010) and on any other (P2039). The SQLSTATE
 * the driver gave says what the error was.
 */
export const DATABASE_ERROR_CODES: ReadonlySet<string> = new Set([
  "P2010",
  "P2039",
]);

/** The `code` of a Prisma error, or null for anything else. */
export function prismaCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The SQLSTATE PostgreSQL gave for an error Prisma passed on from the driver.
 *
 * Where Prisma 7 with the pg adapter puts it: the adapter's DriverAdapterError
 * on the error's `meta`, with the driver's code as `originalCode` on its cause.
 * `testing/postgres-errors.ts` builds the error from those classes, so a
 * release that moves it fails a test rather than quietly changing what the
 * callers make of a failed write.
 */
export function sqlState(error: object): string | null {
  const meta = (error as { meta?: unknown }).meta;
  const state = (
    meta as
      | { driverAdapterError?: { cause?: { originalCode?: unknown } } }
      | undefined
  )?.driverAdapterError?.cause?.originalCode;
  return typeof state === "string" ? state : null;
}
