import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type BookableResourceSummary,
  type BookableResourceView,
  BookableResourceService,
} from "./bookable-resource.service";
import { BookingError } from "./booking.error";
import {
  type BookableSlotView,
  type BookingApartmentView,
  BookingService,
  type ManagedBookingView,
  type OwnBookingView,
} from "./booking.service";
import {
  addLocalDays,
  type LocalDay,
  localDayOf,
  MINUTES_PER_DAY,
  parseLocalDay,
} from "./stockholm-calendar";

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

/**
 * A "YYYY-MM-DD" calendar date on the association's own clock.
 *
 * Parsed rather than handed to `new Date`, which would read it as UTC midnight
 * and put every request in the hour before the day it names for half the year.
 * The refusal is a domain reason rather than a schema issue because the range
 * as a whole is what can be wrong - a start after an end, a span past the cap -
 * and one code for all of it is what a screen can translate.
 */
function localDay(value: unknown, fallback: LocalDay): LocalDay {
  const text = z.string().optional().parse(value);
  if (text === undefined || text === "") {
    return fallback;
  }
  const day = parseLocalDay(text);
  if (day === null) {
    throw new BookingError(
      "A date is written YYYY-MM-DD and has to be a real one.",
      "range-invalid",
    );
  }
  return day;
}

/** The range a calendar request covers, defaulting to the month ahead. */
function calendarRange(
  from: unknown,
  to: unknown,
): { from: LocalDay; to: LocalDay } {
  const today = localDayOf(new Date());
  const start = localDay(from, today);
  return { from: start, to: localDay(to, addLocalDays(start, 30)) };
}

const bookingSchema = z.object({
  resourceId: z.string().min(1),
  /**
   * Required, and checked against the caller's own residencies.
   *
   * The apartment is what the quota is counted against, so a booking without
   * one would be a claim no allowance applies to. A caller who holds none is
   * offered none by the apartments route and has nothing to send, which is the
   * same shape the issue report form has.
   */
  apartmentId: z.string().min(1),
  /** Copied from the slot, so the server compares instants and not wall time. */
  startsAt: z.iso.datetime(),
  /**
   * The check-out, for a resource booked by the night. Absent everywhere else:
   * one slot is one booking, and its end is the slot's own.
   */
  endsAt: z.iso.datetime().nullish(),
});

/**
 * Booking a resource, and reading one's own bookings.
 *
 * The capability sits on the class, so a route added here later inherits it
 * rather than being open by omission. Everything on it is scoped to the caller:
 * the calendar says free or taken and never who holds a slot, and the cancel
 * route answers a booking that is not the caller's exactly as one that does not
 * exist. Seeing who booked what is bookings:manage and lives on the controller
 * below.
 */
@Controller("api/bookings")
@RequireCapability("bookings:book")
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly resources: BookableResourceService,
  ) {}

  /** What the house offers today. Withdrawn resources are not on it. */
  @Get("resources")
  async resourceList(): Promise<BookableResourceSummary[]> {
    return this.resources.listOffered();
  }

  /** The caller's own apartments, for the picker on the form. */
  @Get("apartments")
  async ownApartments(
    @Req() request: RequestWithPrincipal,
  ): Promise<BookingApartmentView[]> {
    return this.bookings.ownApartments(requirePrincipal(request).personId);
  }

  @Get("resources/:id/slots")
  async slots(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<BookableSlotView[]> {
    const range = calendarRange(from, to);
    return this.bookings.slots(
      requirePrincipal(request).personId,
      id,
      range.from,
      range.to,
    );
  }

  @Get("mine")
  async listOwn(
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnBookingView[]> {
    return this.bookings.listOwn(requirePrincipal(request).personId);
  }

  @Post()
  @HttpCode(201)
  async book(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<OwnBookingView> {
    const input = bookingSchema.parse(body);
    return this.bookings.book(requirePrincipal(request).personId, {
      resourceId: input.resourceId,
      apartmentId: input.apartmentId,
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt == null ? null : new Date(input.endsAt),
    });
  }

  /**
   * Cancels one of the caller's own bookings.
   *
   * A POST to a named act rather than a DELETE, because nothing is deleted: the
   * row stays with a cancelled status, which is what gives the slot back while
   * keeping the record that the booking was made.
   */
  @Post(":id/cancel")
  async cancel(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnBookingView> {
    return this.bookings.cancelOwn(requirePrincipal(request).personId, id);
  }
}

/**
 * The board's view of the calendar: who has booked what, and cancelling it.
 *
 * Its own base path rather than routes under the controller above, because the
 * capability covers the whole class: one @RequireCapability("bookings:book")
 * and one @RequireCapability("bookings:manage") on the same controller would be
 * a route open to the wrong half of the house.
 *
 * Named for what it is rather than for a queue. A queue in this domain is a
 * waiting list for a garage or a parking space - households waiting in order
 * for a thing to become free - which is a different feature entirely, and using
 * the word here would leave the two sharing a name.
 */
@Controller("api/booking-admin")
@RequireCapability("bookings:manage")
export class BookingAdminController {
  constructor(private readonly bookings: BookingService) {}

  @Get()
  async list(
    @Query("resourceId") resourceId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<ManagedBookingView[]> {
    const range = calendarRange(from, to);
    return this.bookings.listForBoard({
      ...(resourceId === undefined || resourceId === "" ? {} : { resourceId }),
      from: range.from,
      to: range.to,
    });
  }

  /** Cancels anybody's booking, recorded against the board member who did. */
  @Post(":id/cancel")
  async cancel(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<OwnBookingView> {
    return this.bookings.cancelForBoard(requirePrincipal(request).personId, id);
  }
}
