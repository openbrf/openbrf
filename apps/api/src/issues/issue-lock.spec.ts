import { describe, expect, it } from "vite-plus/test";

import { IMPORT_CHUNK_TRANSACTION_MS } from "../import/import-apply.service";
import { HOUSEHOLD_PROTECTION_TRANSACTION } from "./issue-lock";

describe("HOUSEHOLD_PROTECTION_TRANSACTION", () => {
  it("outlasts the longest an import chunk holds the household protection's lock", () => {
    // A transaction that waits for the lock behind an import chunk waits up
    // to the chunk's limit, and needs time for its own work after that.
    expect(HOUSEHOLD_PROTECTION_TRANSACTION.timeout).toBeGreaterThan(
      IMPORT_CHUNK_TRANSACTION_MS + 10_000,
    );
  });
});
