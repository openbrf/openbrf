import { EventEmitter } from "node:events";

import type { MarkedResponse } from "../authenticated-request";

/**
 * A response still being served, for a test that marks a request without a
 * server behind it. It reads as neither sent nor closed, and ends only when
 * the test emits `finish` or `close` on it.
 */
export class LiveResponse extends EventEmitter implements MarkedResponse {
  readonly writableFinished = false;
  readonly destroyed = false;
}
