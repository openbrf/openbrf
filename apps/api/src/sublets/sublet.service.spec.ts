import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { SubletError } from "./sublet.error";
import { SubletService } from "./sublet.service";

/**
 * The nightly purge can delete a consented application between the read that
 * finds it and the write that records the end of its letting. The database then
 * has no row to change, and the answer has to be the one for an application
 * that does not exist, not a failed write.
 */
describe("recording the end of a letting that the purge deleted meanwhile", () => {
  it("answers application-not-found, as for an application that never was", async () => {
    const consented = {
      id: "app-1",
      status: "CONSENTED",
      appliedByPersonId: "person-1",
      periodFrom: new Date("2027-01-01T00:00:00.000Z"),
      periodTo: new Date("2027-12-31T00:00:00.000Z"),
    };
    // The row is there for the read and gone for the write, as a purge between
    // the two leaves it. `update` by the key throws on a missing row, which is
    // what made this a 500.
    const tx = {
      subletApplication: {
        findUnique: vi.fn().mockResolvedValue(consented),
        update: vi.fn().mockRejectedValue(
          Object.assign(new Error("No record was found for an update."), {
            code: "P2025",
          }),
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const audit = { record: vi.fn() };
    const service = new SubletService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    );

    const refused = await service
      .recordLettingEnd("app-1", "actor-1", { lettingEndedOn: "2027-06-30" })
      .catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(SubletError);
    expect((refused as SubletError).reason).toBe("application-not-found");
    expect(audit.record).not.toHaveBeenCalled();
  });
});
