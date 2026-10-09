import { describe, expect, it } from "vitest";

import { mapped, postgres } from "../database/testing/postgres-errors";
import { isDataRefusal } from "./database-refusal";

describe("isDataRefusal", () => {
  it.each([
    ["a NUL in a text column", postgres("22021")],
    ["a NUL in a text column, on a raw query", postgres("22021", "P2010")],
    ["a check constraint", postgres("23514")],
    [
      "a value too long for its column",
      mapped("P2000", { kind: "LengthMismatch", column: "body" }),
    ],
    [
      "a value not valid for its type",
      mapped("P2007", { kind: "InvalidInputValue", message: "invalid" }),
    ],
    [
      "a missing value",
      mapped("P2011", {
        kind: "NullConstraintViolation",
        constraint: undefined,
      }),
    ],
    [
      "a value out of range",
      mapped("P2020", { kind: "ValueOutOfRange", cause: "out of range" }),
    ],
  ])("sets aside %s", (_refusal, error) => {
    expect(isDataRefusal(error)).toBe(true);
  });

  it.each([
    ["a server shutting down", postgres("57P01")],
    ["a statement timeout", postgres("57014", "P2010")],
    ["a read-only server after a failover", postgres("25006")],
    ["an I/O error", postgres("58030")],
    ["an internal error", postgres("XX000")],
    ["a grant withdrawn", postgres("42501")],
    [
      "a table the migration has not made yet",
      mapped("P2021", { kind: "TableDoesNotExist", table: "board_mailbox" }),
    ],
    [
      "a column the migration has not made yet",
      mapped("P2022", { kind: "ColumnNotFound", column: "body" }),
    ],
    [
      "column data the client cannot read, a schema the client disagrees with",
      mapped("P2023", {
        kind: "InconsistentColumnData",
        cause: "conversion failed",
      }),
    ],
    [
      "a foreign key",
      mapped("P2003", {
        kind: "ForeignKeyConstraintViolation",
        constraint: undefined,
      }),
    ],
    [
      "too many connections",
      mapped("P2037", { kind: "TooManyConnections", cause: "too many" }),
    ],
    [
      "an unreachable database",
      mapped("P1001", { kind: "DatabaseNotReachable" }),
    ],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    ["a value that is not an error", "failed"],
  ])("retries %s", (_failure, error) => {
    expect(isDataRefusal(error)).toBe(false);
  });

  it("does not take a unique violation for a refusal of the letter", () => {
    expect(isDataRefusal(postgres("23505", "P2010"))).toBe(false);
  });
});
