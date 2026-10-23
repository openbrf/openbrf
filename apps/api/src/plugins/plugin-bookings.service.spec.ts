import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import type {
  CheckedItem,
  RegisterCheckService,
} from "../register-check/register-check.service";
import {
  mergeTouching,
  PluginBookingsService,
} from "./plugin-bookings.service";

/**
 * What bookings:readAvailability releases: when a resource is taken, and never
 * by whom (ADR 0032).
 *
 * The query is the boundary, so the assertions are on what it selects as well
 * as on what comes out: a booker that is never read cannot be handed over
 * however the mapping is later changed.
 */

const WINDOW = { from: "2026-11-02T00:00:00Z", to: "2026-11-03T00:00:00Z" };

function at(time: string): Date {
  return new Date(`2026-11-02T${time}:00Z`);
}

/** A plugin with no device route. */
const OPEN = { forDevices: false };
/** A plugin that declares a device route. */
const DEVICE = { forDevices: true };

function serviceReading(bookings: unknown[], resources: unknown[] = []) {
  const findBookings = vi.fn(async () => bookings);
  const findResources = vi.fn(async () => resources);
  const prisma = {
    booking: { findMany: findBookings },
    bookableResource: { findMany: findResources },
  } as unknown as PrismaService;
  // A register check that withholds whatever mentions Svensson.
  const passes = vi.fn(async (items: readonly CheckedItem[]) =>
    items.map((item) => !item.some((text) => text?.includes("Svensson"))),
  );
  const load = vi.fn(async () => ({ passes, matches: vi.fn() }));
  const registerCheck = { load } as unknown as RegisterCheckService;
  return {
    service: new PluginBookingsService(prisma, registerCheck),
    findBookings,
    findResources,
    load,
  };
}

describe("busy", () => {
  it("selects the resource and the period of a booking, and nothing about who made it", async () => {
    const { service, findBookings } = serviceReading([]);

    await service.busy(WINDOW, OPEN);

    const [query] = findBookings.mock.calls[0] as unknown as [
      { select: Record<string, unknown>; where: Record<string, unknown> },
    ];
    expect(Object.keys(query.select).sort()).toEqual([
      "endsAt",
      "resourceId",
      "startsAt",
    ]);
    // Live bookings of offered resources, overlapping the window.
    expect(query.where).toEqual({
      status: "BOOKED",
      startsAt: { lt: new Date(WINDOW.to) },
      endsAt: { gt: new Date(WINDOW.from) },
      resource: { deactivatedAt: null },
    });
  });

  it("merges bookings that touch, so a run of slots reads as one interval", async () => {
    const { service } = serviceReading([
      { resourceId: "laundry", startsAt: at("07:00"), endsAt: at("09:00") },
      { resourceId: "laundry", startsAt: at("09:00"), endsAt: at("11:00") },
      { resourceId: "laundry", startsAt: at("13:00"), endsAt: at("15:00") },
      { resourceId: "sauna", startsAt: at("09:00"), endsAt: at("10:00") },
    ]);

    const busy = await service.busy(WINDOW, OPEN);

    expect(busy).toEqual([
      {
        resourceId: "laundry",
        start: "2026-11-02T07:00:00.000Z",
        end: "2026-11-02T11:00:00.000Z",
      },
      {
        resourceId: "laundry",
        start: "2026-11-02T13:00:00.000Z",
        end: "2026-11-02T15:00:00.000Z",
      },
      {
        resourceId: "sauna",
        start: "2026-11-02T09:00:00.000Z",
        end: "2026-11-02T10:00:00.000Z",
      },
    ]);
    for (const interval of busy) {
      expect(Object.keys(interval).sort()).toEqual([
        "end",
        "resourceId",
        "start",
      ]);
    }
  });

  it("cuts an interval to the window", async () => {
    const { service } = serviceReading([
      {
        resourceId: "guest",
        startsAt: new Date("2026-10-30T12:00:00Z"),
        endsAt: new Date("2026-11-05T10:00:00Z"),
      },
    ]);

    await expect(service.busy(WINDOW, OPEN)).resolves.toEqual([
      {
        resourceId: "guest",
        start: "2026-11-02T00:00:00.000Z",
        end: "2026-11-03T00:00:00.000Z",
      },
    ]);
  });

  it("asks only about the resources named, and answers none for an empty list", async () => {
    const { service, findBookings } = serviceReading([]);

    await service.busy({ ...WINDOW, resourceIds: ["a", "b", "a"] }, OPEN);
    await expect(
      service.busy({ ...WINDOW, resourceIds: [] }, OPEN),
    ).resolves.toEqual([]);

    expect(findBookings).toHaveBeenCalledTimes(1);
    const [query] = findBookings.mock.calls[0] as unknown as [
      { where: { resource: unknown } },
    ];
    expect(query.where.resource).toEqual({
      deactivatedAt: null,
      id: { in: ["a", "b"] },
    });
  });

  it.each([
    ["a window longer than a month", { to: "2026-12-03T00:00:01Z" }],
    ["resource ids that are not strings", { resourceIds: [1] }],
    ["resource ids that are not a list", { resourceIds: "laundry" }],
  ])("refuses %s", async (_what, change) => {
    const { service, findBookings } = serviceReading([]);

    await expect(
      service.busy({ ...WINDOW, ...change } as never, OPEN),
    ).rejects.toBeInstanceOf(RangeError);
    expect(findBookings).not.toHaveBeenCalled();
  });
});

describe("resources", () => {
  it("lists the offered resources, without the board's notes and limits", async () => {
    const { service, findResources } = serviceReading(
      [],
      [
        {
          id: "laundry",
          name: "Tvättstugan",
          mode: "TIME_SLOTS",
          slotMinutes: 120,
          opensAtMinute: 420,
          closesAtMinute: 1260,
        },
      ],
    );

    await expect(service.resources(OPEN)).resolves.toEqual([
      {
        id: "laundry",
        name: "Tvättstugan",
        mode: "timeSlots",
        slotMinutes: 120,
        opensAtMinute: 420,
        closesAtMinute: 1260,
      },
    ]);
    const [query] = findResources.mock.calls[0] as unknown as [
      { where: unknown; select: Record<string, unknown> },
    ];
    expect(query.where).toEqual({ deactivatedAt: null });
    expect(Object.keys(query.select).sort()).toEqual([
      "closesAtMinute",
      "id",
      "mode",
      "name",
      "opensAtMinute",
      "slotMinutes",
    ]);
  });
});

/**
 * A plugin with a device route has no booking history to show, and a resource
 * whose name fails the register check is absent from both reads (ADR 0032).
 */
describe("for a plugin with a device route", () => {
  const LAUNDRY = {
    id: "laundry",
    name: "Tvättstugan",
    mode: "TIME_SLOTS",
    slotMinutes: 120,
    opensAtMinute: 420,
    closesAtMinute: 1260,
  };
  const NAMED = { ...LAUNDRY, id: "store", name: "Svenssons förråd" };

  it("starts the window at the moment of the call, so nothing that has ended is read", async () => {
    const { service, findBookings } = serviceReading(
      [{ resourceId: "laundry", startsAt: at("09:00"), endsAt: at("13:00") }],
      [LAUNDRY],
    );

    const busy = await service.busy(WINDOW, DEVICE, at("11:30"));

    const [query] = findBookings.mock.calls[0] as unknown as [
      { where: { endsAt: unknown; startsAt: unknown } },
    ];
    expect(query.where.endsAt).toEqual({ gt: at("11:30") });
    // A booking under way is taken from now, not from when it began.
    expect(busy).toEqual([
      {
        resourceId: "laundry",
        start: "2026-11-02T11:30:00.000Z",
        end: "2026-11-02T13:00:00.000Z",
      },
    ]);
  });

  it("answers nothing for a window that has passed, without reading a booking", async () => {
    const { service, findBookings } = serviceReading([], [LAUNDRY]);

    await expect(
      service.busy(WINDOW, DEVICE, new Date("2026-11-04T00:00:00Z")),
    ).resolves.toEqual([]);
    expect(findBookings).not.toHaveBeenCalled();
  });

  it("keeps the window as asked for a plugin without one", async () => {
    const { service, findBookings, load } = serviceReading([], [NAMED]);

    await service.busy(WINDOW, OPEN, at("11:30"));

    const [query] = findBookings.mock.calls[0] as unknown as [
      { where: { endsAt: unknown } },
    ];
    expect(query.where.endsAt).toEqual({ gt: new Date(WINDOW.from) });
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves out a resource whose name fails the check", async () => {
    const { service, findBookings } = serviceReading([], [LAUNDRY, NAMED]);

    await expect(service.resources(DEVICE)).resolves.toMatchObject([
      { id: "laundry" },
    ]);
    await service.busy(WINDOW, DEVICE, at("00:00"));
    const [query] = findBookings.mock.calls[0] as unknown as [
      { where: { resource: unknown } },
    ];
    expect(query.where.resource).toEqual({
      deactivatedAt: null,
      id: { in: ["laundry"] },
    });
  });

  it("answers nothing for a resource it left out, as for one not offered", async () => {
    const { service, findBookings } = serviceReading([], [LAUNDRY, NAMED]);

    await expect(
      service.busy({ ...WINDOW, resourceIds: ["store"] }, DEVICE, at("00:00")),
    ).resolves.toEqual([]);
    expect(findBookings).not.toHaveBeenCalled();
  });
});

describe("mergeTouching", () => {
  it("merges an interval contained in the one before it", () => {
    expect(
      mergeTouching([
        { resourceId: "r", start: 0, end: 10 },
        { resourceId: "r", start: 2, end: 5 },
        { resourceId: "r", start: 10, end: 12 },
      ]),
    ).toEqual([{ resourceId: "r", start: 0, end: 12 }]);
  });

  it("keeps two resources apart even where their intervals touch", () => {
    expect(
      mergeTouching([
        { resourceId: "a", start: 0, end: 10 },
        { resourceId: "b", start: 10, end: 20 },
      ]),
    ).toHaveLength(2);
  });
});
