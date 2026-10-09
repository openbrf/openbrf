import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Reports being gathered at the same time, whoever asks and by which route.
 *
 * The board's access report and a member's export of their own data gather the
 * same report in the same long transaction, and each holds one pooled
 * connection while it runs - the retention setting is read before the
 * transaction opens, not beside it - so this is the most connections the two
 * together can hold, however long their transaction is allowed to take. Three
 * leaves seven of the pool's default ten for everything else the instance does.
 */
export const MAX_CONCURRENT_EXPORTS = 3;

/**
 * The wait a request is told when every slot is taken.
 *
 * There is no time a slot is known to come free, as there is for a token. A
 * report usually takes well under a second, and a request refused for want of a
 * slot costs nothing but the check, so a second is long enough to be worth the
 * retry and short enough not to keep somebody waiting for nothing.
 */
export const BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * Every slot taken, so the report was not gathered.
 *
 * The same reason the member's export gives when the instance's own budget is
 * spent, `export-busy`, because it means the same thing to whoever reads it:
 * the instance is busy, and waiting is all there is to do. The screen says so
 * in its own words, so the message here is for the log and for a developer
 * reading the response.
 */
export class ExportsBusyError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason = "export-busy";

  constructor() {
    super("Every report slot is taken; retry after the retry-after delay.");
  }

  override headers(): Record<string, string> {
    return { "retry-after": String(BUSY_RETRY_AFTER_SECONDS) };
  }
}

/**
 * The slots the report is gathered in, in this process.
 *
 * Counted in memory like the rate limits beside it: one process per instance,
 * so what it counts is everything the instance gathers.
 */
export class ExportSlots {
  private running = 0;

  /**
   * Runs `gather` in a slot, or throws {@link ExportsBusyError} before it is
   * called.
   *
   * The slot is taken before the first await, so nothing else can be admitted
   * between the check and the count, and it is held until `gather` settles
   * either way: a report that fails - a transaction past its timeout, a
   * database gone away - gives its slot back rather than keeping it for good.
   */
  async run<T>(gather: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT_EXPORTS) {
      throw new ExportsBusyError();
    }
    this.running += 1;
    try {
      return await gather();
    } finally {
      this.running -= 1;
    }
  }
}
