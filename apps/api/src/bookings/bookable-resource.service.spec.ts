import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import {
  type BookableResourceInput,
  BookableResourceService,
} from "./bookable-resource.service";

/**
 * What the catalogue refuses when a resource has already been booked.
 *
 * A booking carries the instants it was cut from the resource's grid at, not a
 * reference to a slot. So changing the grid does not move the bookings already
 * made: a laundry room switched from two-hour slots to whole days leaves the
 * resident who holds Tuesday 19:00-21:00 still holding it, while the resource
 * no longer offers any period of that shape. Nothing on the calendar can draw
 * such a row, the quota cannot count it, and the partial unique index that
 * refuses the double booking indexes a start time nothing generates any more.
 *
 * The other half matters as much. A board that could not correct a spelling
 * mistake without cancelling a week of bookings would have a rule costing more
 * than it buys, and so would one that could not lower a weekly quota - a quota
 * bounds the next claim and says nothing about what an existing booking is.
 *
 * The schedule rules themselves are `resource-schedule.spec.ts`, and what the
 * database does about it is `bookings.int-spec.ts`.
 */

const LAUNDRY = {
  id: "resource-1",
  name: "Tvattstuga 1",
  description: null,
  mode: "TIME_SLOTS" as const,
  slotMinutes: 120,
  opensAtMinute: 7 * 60,
  closesAtMinute: 21 * 60,
  maxConcurrentBookings: null,
  maxBookingsPerWeek: 3,
  deactivatedAt: null,
  _count: { bookings: 12 },
};

const AS_STATED: BookableResourceInput = {
  name: LAUNDRY.name,
  description: null,
  mode: "TIME_SLOTS",
  slotMinutes: 120,
  opensAtMinute: 7 * 60,
  closesAtMinute: 21 * 60,
  maxConcurrentBookings: null,
  maxBookingsPerWeek: 3,
};

function build(options: { standingBookings?: number } = {}) {
  const count = vi.fn(
    async (_where: { where: Record<string, unknown> }) =>
      options.standingBookings ?? 0,
  );
  const update = vi.fn(async (args: { data: BookableResourceInput }) => ({
    ...LAUNDRY,
    ...args.data,
  }));

  const tx = {
    bookableResource: {
      findUnique: vi.fn(async () => LAUNDRY),
      update,
    },
    booking: { count },
  };

  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };

  return {
    service: new BookableResourceService(
      prisma as unknown as PrismaService,
      { record: vi.fn(async () => undefined) } as unknown as AuditLogService,
    ),
    count,
    update,
  };
}

describe("changing a resource that has been booked", () => {
  it("refuses a change of mode while a booking is still to come", async () => {
    const { service, update } = build({ standingBookings: 1 });

    await expect(
      service.update(
        LAUNDRY.id,
        {
          ...AS_STATED,
          mode: "WHOLE_DAY",
          slotMinutes: null,
          opensAtMinute: null,
          closesAtMinute: null,
        },
        "board-1",
      ),
    ).rejects.toMatchObject({ reason: "resource-in-use" });

    // Refused whole, so the row the resident holds still matches the grid.
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a change of slot length while a booking is still to come", async () => {
    const { service } = build({ standingBookings: 1 });

    await expect(
      service.update(LAUNDRY.id, { ...AS_STATED, slotMinutes: 60 }, "board-1"),
    ).rejects.toMatchObject({ reason: "resource-in-use" });
  });

  it("refuses a change of opening hours while a booking is still to come", async () => {
    const { service } = build({ standingBookings: 1 });

    // Nine to nine, which is still a whole number of two-hour slots: the
    // schedule is coherent and it is the bookings that refuse it.
    await expect(
      service.update(
        LAUNDRY.id,
        { ...AS_STATED, opensAtMinute: 9 * 60 },
        "board-1",
      ),
    ).rejects.toMatchObject({ reason: "resource-in-use" });
  });

  it("counts only the live bookings that have not happened yet", async () => {
    /*
     * A past booking is a record of what was, and rewriting the slots does not
     * make last March untrue. A cancelled one claims nothing. Counted against
     * every booking the resource ever carried, the rule would freeze a laundry
     * room's configuration for good after its first week in service.
     */
    const { service, count } = build({ standingBookings: 0 });

    await service.update(
      LAUNDRY.id,
      { ...AS_STATED, slotMinutes: 60 },
      "board-1",
    );

    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]?.[0]).toEqual({
      where: {
        resourceId: LAUNDRY.id,
        status: "BOOKED",
        endsAt: { gt: expect.any(Date) },
      },
    });
  });

  it("allows a rename with bookings standing, and asks nothing about them", async () => {
    const { service, count, update } = build({ standingBookings: 5 });

    const view = await service.update(
      LAUNDRY.id,
      { ...AS_STATED, name: "Tvattstuga 1, ommalad" },
      "board-1",
    );

    expect(view.name).toBe("Tvattstuga 1, ommalad");
    expect(update).toHaveBeenCalledTimes(1);
    // Not even counted: a name is not part of the grid, so the question does
    // not arise and a board renaming a room waits on nothing.
    expect(count).not.toHaveBeenCalled();
  });

  it("allows a quota change with bookings standing", async () => {
    // A quota bounds the next claim. It says nothing about what an existing
    // booking is, so lowering one invalidates nothing already made.
    const { service, count, update } = build({ standingBookings: 5 });

    await service.update(
      LAUNDRY.id,
      { ...AS_STATED, maxBookingsPerWeek: 1 },
      "board-1",
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(count).not.toHaveBeenCalled();
  });
});
