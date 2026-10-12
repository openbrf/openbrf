import { DATABASE_ERROR_CODES, prismaCode, sqlState } from "./sql-state";

/** PostgreSQL's SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether a write failed on a unique constraint: Prisma's P2002, or the
 * unique-violation SQLSTATE behind an error it has no code of its own for, as a
 * raw query reports it (P2010, P2039).
 *
 * The answer a caller gives to a race its read could not close: two requests
 * pass the read together and the database lets one of them write.
 */
export function isUniqueViolation(cause: unknown): boolean {
  const code = prismaCode(cause);
  return (
    code === "P2002" ||
    (code !== null &&
      DATABASE_ERROR_CODES.has(code) &&
      sqlState(cause as object) === UNIQUE_VIOLATION)
  );
}
