import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { ApartmentRegisterService } from "./apartment-register.service";
import type { RegisterReportMailerService } from "./register-report-mailer.service";

/**
 * The order a save takes its rows' locks in.
 *
 * Asserted against a stand-in for the transaction because a deadlock needs two
 * saves to overlap at the instant each holds one lock, which a test cannot
 * arrange on a shared database without sleeping. What can be asserted is the
 * cause: two saves that take the same rows in different orders can each wait
 * for the other, and ones that take them in one order cannot.
 */

const NONE = {
  roomCount: null,
  otherSpaces: null,
  livingArea: null,
  economicPlanRegisteredOn: null,
};

/** A service whose transaction reports each apartment it locks. */
function serviceLocking(
  locked: string[],
  written: string[] = [],
): ApartmentRegisterService {
  const tx = {
    $queryRaw: vi.fn((_strings: TemplateStringsArray, id: string) => {
      locked.push(id);
      return Promise.resolve([{}]);
    }),
    apartment: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          ...NONE,
          participationShare: null,
          initialShareCapital: null,
        }),
      ),
      update: vi.fn((args: { where: { id: string } }) => {
        written.push(args.where.id);
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  return new ApartmentRegisterService(
    prisma as unknown as PrismaService,
    {} as FieldEncryptionService,
    audit as unknown as AuditLogService,
    {} as RegisterReportMailerService,
  );
}

describe("ApartmentRegisterService.recordApartmentParticulars", () => {
  it("locks the apartments in the order of their ids, whatever order the client sent", async () => {
    const forward: string[] = [];
    const backward: string[] = [];
    const rows = ["apartment-b", "apartment-c", "apartment-a"].map((id) => ({
      apartmentId: id,
      ...NONE,
      roomCount: 3,
      expected: NONE,
    }));

    await serviceLocking(forward).recordApartmentParticulars({
      actorPersonId: "person-1",
      apartments: rows,
    });
    await serviceLocking(backward).recordApartmentParticulars({
      actorPersonId: "person-1",
      apartments: [...rows].reverse(),
    });

    expect(forward).toEqual(["apartment-a", "apartment-b", "apartment-c"]);
    expect(backward).toEqual(forward);
  });
});

describe("ApartmentRegisterService.recordApartmentShares", () => {
  it("writes the apartments in the order of their ids, whatever order the client sent", async () => {
    const forward: string[] = [];
    const backward: string[] = [];
    const rows = ["apartment-b", "apartment-c", "apartment-a"].map((id) => ({
      apartmentId: id,
      participationShare: "0.05",
      initialShareCapital: "1000.00",
    }));

    await serviceLocking([], forward).recordApartmentShares({
      actorPersonId: "person-1",
      apartments: rows,
    });
    await serviceLocking([], backward).recordApartmentShares({
      actorPersonId: "person-1",
      apartments: [...rows].reverse(),
    });

    expect(forward).toEqual(["apartment-a", "apartment-b", "apartment-c"]);
    expect(backward).toEqual(forward);
  });
});
