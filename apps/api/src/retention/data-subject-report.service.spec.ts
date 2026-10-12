import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { DataSubjectReport } from "./data-subject-report";
import { DataSubjectReportService } from "./data-subject-report.service";
import { ExportsBusyError, MAX_CONCURRENT_EXPORTS } from "./export-slots";

/**
 * The board's access report and a member's export of their own data, gathered
 * in one set of slots.
 *
 * The two are the same transaction, so a cap that each route kept for itself
 * would let the pair hold twice the connections it was set at. The audit is a
 * stand-in whose transaction stays open until the test finishes it, which is
 * what a slow report looks like from here.
 */

function serviceWithOpenTransactions() {
  const open: (() => void)[] = [];
  const withAuditedRead = vi.fn(
    () =>
      new Promise<DataSubjectReport>((resolve) => {
        open.push(() => {
          resolve({} as DataSubjectReport);
        });
      }),
  );
  const prisma = {
    association: { findUnique: vi.fn(() => Promise.resolve(null)) },
  };
  const service = new DataSubjectReportService(
    prisma as unknown as PrismaService,
    {} as FieldEncryptionService,
    { withAuditedRead } as unknown as AuditLogService,
  );
  return {
    service,
    withAuditedRead,
    prisma,
    /** Waits until `count` transactions are open, which is when their slots are held. */
    opened: async (count: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(open).toHaveLength(count);
      });
    },
    finishAll: (): void => {
      for (const finish of open.splice(0)) {
        finish();
      }
    },
  };
}

const board = { personId: "subject", actorPersonId: "board-member" };

describe("the slots the report is gathered in", () => {
  it("refuses the board's report as busy while members' exports hold every slot, and opens no audited read for it", async () => {
    const { service, withAuditedRead, prisma, opened, finishAll } =
      serviceWithOpenTransactions();
    const running = Array.from({ length: MAX_CONCURRENT_EXPORTS }, (_, n) =>
      service.portable(`member-${String(n)}`),
    );
    await opened(MAX_CONCURRENT_EXPORTS);

    await expect(service.generate(board)).rejects.toBeInstanceOf(
      ExportsBusyError,
    );

    // Refused before the retention setting was read, and before the read that
    // writes the audit entry was opened.
    expect(withAuditedRead).toHaveBeenCalledTimes(MAX_CONCURRENT_EXPORTS);
    expect(prisma.association.findUnique).toHaveBeenCalledTimes(
      MAX_CONCURRENT_EXPORTS,
    );
    finishAll();
    await Promise.all(running);
  });

  it("refuses a member's export as busy while the board's reports hold every slot", async () => {
    const { service, withAuditedRead, opened, finishAll } =
      serviceWithOpenTransactions();
    const running = Array.from({ length: MAX_CONCURRENT_EXPORTS }, () =>
      service.generate(board),
    );
    await opened(MAX_CONCURRENT_EXPORTS);

    await expect(service.portable("member")).rejects.toBeInstanceOf(
      ExportsBusyError,
    );

    expect(withAuditedRead).toHaveBeenCalledTimes(MAX_CONCURRENT_EXPORTS);
    finishAll();
    await Promise.all(running);
  });

  it("counts both routes against one cap rather than one each", async () => {
    const { service, opened, finishAll } = serviceWithOpenTransactions();
    // Under the cap through either route alone, so a cap per route would admit
    // another of each.
    const running = [
      service.generate(board),
      ...Array.from({ length: MAX_CONCURRENT_EXPORTS - 1 }, (_, n) =>
        service.portable(`member-${String(n)}`),
      ),
    ];
    await opened(MAX_CONCURRENT_EXPORTS);

    await expect(service.generate(board)).rejects.toBeInstanceOf(
      ExportsBusyError,
    );
    await expect(service.portable("latecomer")).rejects.toBeInstanceOf(
      ExportsBusyError,
    );

    finishAll();
    await Promise.all(running);
    // And both are admitted again once the slots are free.
    const after = [service.generate(board), service.portable("latecomer")];
    await opened(2);
    finishAll();
    await expect(Promise.all(after)).resolves.toHaveLength(2);
  });
});
