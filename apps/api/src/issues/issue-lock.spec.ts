import { describe, expect, it } from "vite-plus/test";

import {
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
