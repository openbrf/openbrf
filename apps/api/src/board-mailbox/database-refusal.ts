import { isUniqueViolation } from "../database/unique-violation";
import {
  DATABASE_ERROR_CODES,
  prismaCode,
  sqlState,
} from "../database/sql-state";

/**
 * What a failed write says about the letter being written.
 *
 * The collector has two answers for a letter it could not store: set it aside
 * for good, or try it again on the next run. Setting aside is only right when
 * the database refused the letter's own values, because the same bytes are read
 * the same way on every run and would be refused the same way. Anything else -
 * the database out of reach or restarting, a failover, a deploy that is ahead
 * of its migration, an internal error, an error that is not an answer from the
 * database at all - says nothing about the letter, and a later run stores it.
 *
 * So the list here is of what the letter is at fault for, and everything not on
 * it is retried. The opposite list, of what is transient, is the one that goes
 * wrong: every failure nobody thought of falls through it and hides a letter.
 * The collector bounds how often a letter is retried, so a letter that keeps
 * failing for a reason nobody foresaw is still set aside in the end.
 */

/**
 * Prisma's codes for a value a column will not hold: too long for it (P2000),
 * not valid for its type (P2007), a null where none is allowed (P2011), and out
 * of range (P2020).
 *
 * Not inconsistent column data (P2023). Prisma raises it when what the database
 * holds or returns does not convert to what the generated client expects, which
 * is a client and a schema that disagree - a deploy ahead of its migration, or
 * one behind it - and not a value the letter carries.
 */
const DATA_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "P2000",
  "P2007",
  "P2011",
  "P2020",
]);

/**
 * SQLSTATE classes that are about the data: 22 a value the type will not take,
 * such as a NUL in a text column, and 23 a constraint the row breaks.
 */
const DATA_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["22", "23"]);

/**
 * Whether the database refused the values being written, which the same letter
 * would carry on every run.
 *
 * A unique violation is not one: the collector reads it as another run having
 * stored the same letter first.
 */
export function isDataRefusal(error: unknown): boolean {
  const code = prismaCode(error);
  if (code === null) {
    return false;
  }
  if (DATA_REFUSAL_CODES.has(code)) {
    return true;
  }
  if (DATABASE_ERROR_CODES.has(code)) {
    const state = sqlState(error as object);
    return (
      state !== null &&
      !isUniqueViolation(error) &&
      DATA_SQLSTATE_CLASSES.has(state.slice(0, 2))
    );
  }
  return false;
}
