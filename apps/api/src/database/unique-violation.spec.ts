import { describe, expect, it } from "vitest";

import { mapped, postgres } from "./testing/postgres-errors";
import { isUniqueViolation } from "./unique-violation";

describe("isUniqueViolation", () => {
  it.each([
    [
      "a unique constraint Prisma has a code for",
      mapped("P2002", {
        kind: "UniqueConstraintViolation",
        constraint: { fields: ["sourceUid"] },
      }),
    ],
    ["a unique violation on a raw query", postgres("23505", "P2010")],
    ["a unique violation Prisma has no code for", postgres("23505")],
  ])("recognises %s", (_failure, error) => {
    expect(isUniqueViolation(error)).toBe(true);
  });

  it.each([
    ["a check constraint", postgres("23514")],
    ["a check constraint on a raw query", postgres("23514", "P2010")],
    [
      "a foreign key",
      mapped("P2003", {
        kind: "ForeignKeyConstraintViolation",
        constraint: undefined,
      }),
    ],
    ["a write conflict", mapped("P2034", { kind: "TransactionWriteConflict" })],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    ["a value that is not an error", "failed"],
    ["nothing", undefined],
  ])("does not take %s for one", (_failure, error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});
