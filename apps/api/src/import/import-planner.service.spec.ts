import { afterEach, describe, expect, it, vi } from "vitest";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { ImportPlannerService } from "./import-planner.service";

/**
 * Which residencies the planner counts as current, on the association's own
 * calendar rather than on the UTC instant (ADR 0014).
 */
describe("matching against residencies that have ended", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a move-out dated today in Stockholm as ended, at 23:30 UTC the day before", async () => {
    // 01:30 on 22 June in Stockholm, still the 21st in UTC.
    vi.useFakeTimers({ now: new Date("2026-06-21T23:30:00.000Z") });

    const prisma = {
      apartment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "apartment-1101",
            number: "1101",
            addressId: "address-14",
            address: { street: "Storgatan", number: "14" },
          },
        ]),
      },
      person: {
        findMany: vi.fn((query: { where?: unknown }) =>
          Promise.resolve(
            query.where === undefined
              ? [
                  {
                    id: "person-anna",
                    firstName: "Anna",
                    lastName: "Lind",
                    emailIndex: null,
                    personalIdentityNumberIndex: null,
                    residencies: [
                      {
                        apartmentId: "apartment-1101",
                        role: "MEMBER",
                        movedInOn: new Date("2015-03-01T00:00:00.000Z"),
                        movedOutOn: new Date("2026-06-22T00:00:00.000Z"),
                      },
                    ],
                  },
                ]
              : [],
          ),
        ),
      },
    };
    const planner = new ImportPlannerService(
      prisma as unknown as PrismaService,
      {} as FieldEncryptionService,
    );

    const plan = await planner.plan({
      rows: [["Anna", "Lind", "1101", "Medlem"]],
      columnCount: 4,
      mapping: ["firstName", "lastName", "apartmentNumber", "role"],
      defaultRole: null,
      defaultMovedInOn: "2026-06-22",
      indexEveryIdentityNumber: false,
      indexes: new Map(),
    });

    // Anna moved out of 1101 today, so a row naming her there is somebody
    // moving in rather than the person who has just left.
    expect(plan.rows[0]?.matchedPersonId).toBeNull();
    expect(plan.rows[0]?.outcome).toBe("create");
  });
});
