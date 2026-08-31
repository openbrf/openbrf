import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type BookableResourceView,
  BookableResourceService,
} from "./bookable-resource.service";
import { MINUTES_PER_DAY } from "./resource-schedule";

const MODES = ["TIME_SLOTS", "WHOLE_DAY", "DATE_RANGE"] as const;

/**
 * A minute of the day, or nothing.
 *
 * `nullish` rather than `optional` throughout the schema below: a form that
 * clears the slot length sends null, and a shape that only accepted absence
 * would leave the board unable to change a laundry room into a common room.
 * The service reads null and absent as the same thing.
 */
const minuteOfDay = z.coerce
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY)
  .nullish();

const resourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /**
   * Bounded but generous. A description says where the laundry room is and
   * what the house rules are about it, which is a short paragraph.
   */
  description: z.string().trim().max(1000).nullish(),
  mode: z.enum(MODES),
  slotMinutes: z.coerce.number().int().min(1).max(MINUTES_PER_DAY).nullish(),
  opensAtMinute: minuteOfDay,
  closesAtMinute: minuteOfDay,
  /**
   * Bounded well above anything a house would set. The lower bound is the one
   * that matters and it is the service's: zero is refused there rather than
   * here, because "a quota of none" is a rule about what a quota means and not
   * about what a request may carry.
   */
  maxConcurrentBookings: z.coerce.number().int().min(0).max(999).nullish(),
  maxBookingsPerWeek: z.coerce.number().int().min(0).max(999).nullish(),
});

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches one to every route that is not @Public(), so
 * reaching this throw means the guard stopped doing that - and a 500 naming the
 * guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/** The parsed body, with every optional field settled to null. */
function resourceInput(body: unknown) {
  const parsed = resourceSchema.parse(body);
  return {
    name: parsed.name,
    description: parsed.description ?? null,
    mode: parsed.mode,
    slotMinutes: parsed.slotMinutes ?? null,
    opensAtMinute: parsed.opensAtMinute ?? null,
    closesAtMinute: parsed.closesAtMinute ?? null,
    maxConcurrentBookings: parsed.maxConcurrentBookings ?? null,
    maxBookingsPerWeek: parsed.maxBookingsPerWeek ?? null,
  };
}

/**
 * The board's own catalogue of bookable resources.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. bookings:configure rather than
 * bookings:manage: running the calendar and writing the rules the calendar runs
 * by are different acts, and one controller carrying both capabilities would be
 * a route open to the wrong half of them.
 *
 * Booking itself, and the board's view of who has booked what, are not here and
 * have a base path and a capability of their own. Nothing on this controller
 * reads a booking; the counts it returns are counts.
 *
 * There is no route that offers a withdrawn resource again. Withdrawing is a
 * decision about what the house offers, and reversing it is a decision of the
 * same size rather than a checkbox on a form somebody was already editing.
 */
@Controller("api/bookable-resources")
@RequireCapability("bookings:configure")
export class BookableResourceAdminController {
  constructor(private readonly resources: BookableResourceService) {}

  @Get()
  async list(): Promise<BookableResourceView[]> {
    return this.resources.listAll();
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BookableResourceView> {
    return this.resources.create(
      resourceInput(body),
      requirePrincipal(request).personId,
    );
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BookableResourceView> {
    return this.resources.update(
      id,
      resourceInput(body),
      requirePrincipal(request).personId,
    );
  }

  /**
   * Withdraws a resource from booking.
   *
   * A POST to a named act rather than a DELETE, because nothing is deleted:
   * the row stays and so does every booking made against it, and a verb that
   * said otherwise would be the wrong promise on the one route where the
   * distinction is the whole point.
   */
  @Post(":id/deactivate")
  async deactivate(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BookableResourceView> {
    return this.resources.deactivate(id, requirePrincipal(request).personId);
  }
}
