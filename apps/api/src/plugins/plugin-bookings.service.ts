import { Injectable } from "@nestjs/common";
import type {
  PluginBookableResource,
  PluginBusyInterval,
} from "@openbrf/plugin-sdk";

import { PrismaService } from "../database/prisma.service";
import type { BookingResourceMode } from "../generated/prisma/enums";
import { bookableResourceTexts } from "../register-check/checked-texts";
import { RegisterCheckService } from "../register-check/register-check.service";
import { type ContentReader, readWindow } from "./plugin-content";

/** The longest window one busy read may span: a month. */
const MAX_BUSY_DAYS = 31;

/** The most resources one busy read may name. More than any house offers. */
const MAX_RESOURCE_IDS = 100;

const MODES: Readonly<
  Record<BookingResourceMode, PluginBookableResource["mode"]>
> = {
  TIME_SLOTS: "timeSlots",
  WHOLE_DAY: "wholeDay",
  DATE_RANGE: "dateRange",
};

/**
 * Free and busy for the house's bookable resources, as a plugin holding
 * bookings:readAvailability reads it (ADR 0032).
 *
 * ## No booker, by the shape of the query
 *
 * A booking is personal data about the household that made it: who, for which
 * apartment, and over time when they do their laundry. What a plugin is given
 * is that a resource is taken, and the query is what holds that rather than a
 * mapping that could later be widened. A booking is selected by its resource,
 * its start and its end; the booker, the apartment and the booking's own
 * identifier are not in the select, so there is nowhere for them to travel.
 *
 * Bookings that overlap or touch are then merged into one interval. A laundry
 * room taken from 07:00 to 13:00 says that, and not that one household took
 * three slots in a row and another the fourth: a sequence of slots is the
 * habit of an apartment, and an interval is only the room's.
 *
 * Only the live bookings count, as on a resident's own calendar: a cancelled
 * booking has given its slot back.
 *
 * ## For a device
 *
 * A plugin with a device route is given no history: its window starts no
 * earlier than the moment of the call, so a booking that has ended is in no
 * answer and one under way is taken from now. A resource whose name fails the
 * register check is absent from both reads, as a withdrawn one is.
 */
@Injectable()
export class PluginBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registerCheck: RegisterCheckService,
  ) {}

  /**
   * The resources the house offers, by name.
   *
   * A withdrawn resource is absent, as on the resident's own booking screen.
   * Neither the description nor the booking limits are read: they are the
   * board's notes and rules for the person booking, and a plugin books nothing.
   */
  async resources(reader: ContentReader): Promise<PluginBookableResource[]> {
    const rows = await this.offered(reader);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mode: MODES[row.mode],
      slotMinutes: row.slotMinutes,
      opensAtMinute: row.opensAtMinute,
      closesAtMinute: row.closesAtMinute,
    }));
  }

  /**
   * When each offered resource is taken in [from, to), by resource and then by
   * time.
   *
   * Each interval is cut to the window, so a booking that began before it says
   * the resource is taken from the window's start rather than when that
   * booking was made to start.
   */
  async busy(
    range: {
      from: string;
      to: string;
      resourceIds?: readonly string[];
    },
    reader: ContentReader,
    now: Date = new Date(),
  ): Promise<PluginBusyInterval[]> {
    const window = readWindow(range, MAX_BUSY_DAYS);
    const resourceIds = readResourceIds(range.resourceIds);
    const from =
      reader.forDevices && window.from.getTime() < now.getTime()
        ? now
        : window.from;
    const to = window.to;
    if (
      (resourceIds !== undefined && resourceIds.length === 0) ||
      to.getTime() <= from.getTime()
    ) {
      return [];
    }

    const passing = reader.forDevices
      ? (await this.offered(reader)).map((resource) => resource.id)
      : undefined;
    const ids =
      passing === undefined
        ? resourceIds
        : passing.filter(
            (id) => resourceIds === undefined || resourceIds.includes(id),
          );
    if (ids !== undefined && ids.length === 0) {
      return [];
    }

    const rows = await this.prisma.booking.findMany({
      where: {
        status: "BOOKED",
        startsAt: { lt: to },
        endsAt: { gt: from },
        resource: {
          deactivatedAt: null,
          ...(ids === undefined ? {} : { id: { in: ids } }),
        },
      },
      orderBy: [{ resourceId: "asc" }, { startsAt: "asc" }],
      select: { resourceId: true, startsAt: true, endsAt: true },
    });

    return mergeTouching(
      rows.map((row) => ({
        resourceId: row.resourceId,
        start: Math.max(row.startsAt.getTime(), from.getTime()),
        end: Math.min(row.endsAt.getTime(), to.getTime()),
      })),
    ).map((interval) => ({
      resourceId: interval.resourceId,
      start: new Date(interval.start).toISOString(),
      end: new Date(interval.end).toISOString(),
    }));
  }

  /**
   * The resources the house offers, by name, less those whose name fails the
   * register check when the reader serves a device.
   */
  private async offered(reader: ContentReader) {
    const rows = await this.prisma.bookableResource.findMany({
      where: { deactivatedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        mode: true,
        slotMinutes: true,
        opensAtMinute: true,
        closesAtMinute: true,
      },
    });
    if (!reader.forDevices) {
      return rows;
    }
    const passes = await this.registerCheck
      .load()
      .then((check) => check.passes(rows.map(bookableResourceTexts)));
    return rows.filter((_, index) => passes[index]);
  }
}

/**
 * Merges the intervals of one resource that overlap or touch.
 *
 * Expects them ordered by resource and then by start, which is the order the
 * query reads them in.
 */
export function mergeTouching(
  intervals: readonly { resourceId: string; start: number; end: number }[],
): { resourceId: string; start: number; end: number }[] {
  const merged: { resourceId: string; start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (
      last !== undefined &&
      last.resourceId === interval.resourceId &&
      interval.start <= last.end
    ) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The resource ids a plugin passed, read as a list of strings or refused. */
function readResourceIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_RESOURCE_IDS ||
    !value.every((id): id is string => typeof id === "string")
  ) {
    throw new RangeError(
      `"resourceIds" is a list of at most ${String(MAX_RESOURCE_IDS)} resource ids.`,
    );
  }
  return [...new Set(value)];
}
