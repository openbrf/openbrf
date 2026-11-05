import { describe, expect, it } from "vite-plus/test";

import { IMPORT_CHUNK_TRANSACTION_MS } from "../import/import-apply.service";
import {
  HOUSEHOLD_PROTECTION_TRANSACTION,
  MAIL_HANDOFF_MS,
  MAIL_TRANSACTION_MS,
  mailHandoffDeadline,
} from "./issue-lock";

/**
 * The deadline a mail's handoff runs under, beside the limit of the
 * transaction that holds its locks.
 *
 * The send must be ended before the database can end the transaction: a lock
 * let go while the send went on would let the board ring-fence the type before
 * the mail server had the message. The margin covers a process that is late to
 * a timer, which a busy event loop is.
 */
describe("a mail's handoff", () => {
  it("is ended well before its transaction's limit", () => {
    expect(MAIL_HANDOFF_MS).toBeGreaterThan(0);
    expect(MAIL_TRANSACTION_MS - MAIL_HANDOFF_MS).toBeGreaterThanOrEqual(
      10_000,
    );
  });

  it("starts each deadline afresh, not yet aborted", () => {
    const first = mailHandoffDeadline();
    const second = mailHandoffDeadline();

    expect(first).not.toBe(second);
    expect(first.aborted).toBe(false);
    expect(second.aborted).toBe(false);
  });
});

describe("HOUSEHOLD_PROTECTION_TRANSACTION", () => {
  it("outlasts the longest an import chunk holds the household protection's lock", () => {
    // A transaction that waits for the lock behind an import chunk waits up
    // to the chunk's limit, and needs time for its own work after that.
    expect(HOUSEHOLD_PROTECTION_TRANSACTION.timeout).toBeGreaterThan(
      IMPORT_CHUNK_TRANSACTION_MS + 10_000,
    );
  });
});
