import type { INestApplication } from "@nestjs/common";
import { expect, vi } from "vitest";

import { AuditLogService } from "../audit/audit-log.service";

/** The audit actions the report is gathered under, by either route. */
const REPORT_ACTIONS: ReadonlySet<string> = new Set([
  "DATA_EXPORTED",
  "DATA_PORTABILITY_EXPORTED",
]);

/**
 * Holds every report at the door of its transaction until released, which is
 * what a slow report looks like from outside.
 *
 * A report takes its slot before the audited read is opened, so one held here
 * keeps its slot and holds no connection: a suite can fill every slot without
 * holding the pool it is testing. Anything else the audit reads goes straight
 * through.
 *
 * Restore it in a `finally`, after `release`: a spy left behind would hold the
 * next suite's reports on a promise nobody resolves.
 */
export function holdReports(app: INestApplication) {
  const audit = app.get(AuditLogService);
  const original = audit.withAuditedRead.bind(audit);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;

  const spy = vi.spyOn(audit, "withAuditedRead").mockImplementation((async (
    entry,
    read,
    options,
  ) => {
    // A report states its entry up front; an entry written from the answer
    // (the debiting list's row count) belongs to a read that is not one.
    if (typeof entry !== "function" && REPORT_ACTIONS.has(entry.action)) {
      held += 1;
      await released;
    }
    return original(entry, read, options);
  }) as AuditLogService["withAuditedRead"]);

  return {
    /** Waits until `count` reports are held, which is when their slots are taken. */
    held: async (count: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(held).toBe(count);
      });
    },
    release: (): void => {
      release();
    },
    restore: (): void => {
      release();
      spy.mockRestore();
    },
  };
}
