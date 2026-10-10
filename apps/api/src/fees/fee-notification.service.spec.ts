import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { FeeNotificationService } from "./fee-notification.service";
import { MAX_NOTICES_PER_RUN } from "./payment-reference";

/**
 * The two bounds on a run, against a transaction that holds whatever a case
 * needs. An integration test cannot reach the second one: it would need ten
 * thousand apartments in the register.
 */
function serviceWith(apartments: number): FeeNotificationService {
  const rates = Array.from({ length: apartments }, (_, index) => ({
    apartmentId: `apartment-${String(index)}`,
    appliesFrom: new Date("2020-01-01T00:00:00.000Z"),
    appliesUntil: null,
    monthlyAmount: { toFixed: () => "1000.00" },
  }));
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    association: {
      findUnique: vi.fn().mockResolvedValue({ financialYearStartMonth: 1 }),
    },
    feeNotification: { findFirst: vi.fn().mockResolvedValue(null) },
    feeNotice: { findFirst: vi.fn().mockResolvedValue(null) },
    fee: { findMany: vi.fn().mockResolvedValue(rates) },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  return new FeeNotificationService(
    prisma as unknown as PrismaService,
    {} as AuditLogService,
  );
}

function issue(
  service: FeeNotificationService,
  from: string,
  to: string,
): Promise<unknown> {
  return service.issue({ actorPersonId: "board", from, to, dueOn: from });
}

describe("the bounds on a run", () => {
  it("takes a period of eighteen months and refuses one of nineteen", async () => {
    // Past the period check, the eighteen-month run is refused for having no
    // apartment to bill, which is the next question asked.
    await expect(
      issue(serviceWith(0), "2027-01-01", "2028-06-30"),
    ).rejects.toMatchObject({ reason: "nothing-to-bill" });
    await expect(
      issue(serviceWith(0), "2027-01-01", "2028-07-31"),
    ).rejects.toMatchObject({ reason: "period-too-long" });
  });

  it("refuses a run with more notices than a payment reference can number", async () => {
    await expect(
      issue(serviceWith(MAX_NOTICES_PER_RUN + 1), "2027-01-01", "2027-01-31"),
    ).rejects.toMatchObject({ reason: "too-many-notices" });
  });
});
