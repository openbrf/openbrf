import {
  Body,
  Controller,
  Delete,
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
import { MINUTES_PER_DAY, parseLocalDay } from "../bookings/stockholm-calendar";
import { EventError } from "./event.error";
import { type EventInput, EventService, type EventView } from "./event.service";
import { MAX_DURATION_MINUTES, MAX_OCCURRENCES } from "./recurrence";

const FREQUENCIES = ["WEEKLY", "MONTHLY", "ANNUAL"] as const;

/**
 * The recurrence rule as a request states it.
 *
 * Bounded generously here and decided in the service. What a request may carry
 * is one question - an interval of a thousand weeks is a mistake at the wire -
 * and whether the rule fits inside the two years a calendar is written out for
 * is another, which depends on the first date and belongs where that is known.
 *
 * `nullish` on both ends rather than optional, so a form that clears the last
 * date sends null and is read the same way as one that never had one.
 */
const recurrenceSchema = z.object({
  frequency: z.enum(FREQUENCIES),
  interval: z.coerce.number().int().min(1).max(52),
  count: z.coerce.number().int().min(1).max(MAX_OCCURRENCES).nullish(),
  /** "YYYY-MM-DD" on the association's own clock. */
  until: z.string().nullish(),
});

const eventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  /**
   * Bounded but generous. A description says what is being done, what to bring
   * and where to meet, which is a short paragraph.
   */
  description: z.string().trim().max(2000).nullish(),
  category: z.string().trim().max(60).nullish(),
  location: z.string().trim().max(200).nullish(),
  signupOpen: z.boolean().optional(),
  /**
   * Bounded well above anything a house would set. The lower bound is the
   * service's: zero is refused there, because "a capacity of none" is a rule
   * about what a capacity means and not about what a request may carry.
   */
  capacity: z.coerce.number().int().min(0).max(9999).nullish(),
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  firstOn: z.string(),
  startsAtMinute: z.coerce
    .number()
    .int()
    .min(0)
    .max(MINUTES_PER_DAY - 1),
  durationMinutes: z.coerce.number().int().min(1).max(MAX_DURATION_MINUTES),
  recurrence: recurrenceSchema.nullish(),
});

const publishSchema = z.object({
  published: z.boolean(),
  visibility: z.enum(["PUBLIC", "MEMBER"]).optional(),
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

/**
 * A "YYYY-MM-DD" calendar date on the association's own clock.
 *
 * Parsed rather than handed to `new Date`, which would read it as UTC midnight
 * and put the date in the hour before the day it names for part of the year.
 * The refusal is a domain reason rather than a schema issue because it is the
 * same mistake wherever a date arrives, and one code for all of it is what a
 * screen can translate.
 */
function localDay(value: string) {
  const day = parseLocalDay(value);
  if (day === null) {
    throw new EventError(
      "A date is written YYYY-MM-DD and has to be a real one.",
      "invalid-date",
    );
  }
  return day;
}

/** The parsed body, with every optional field settled to null. */
function eventInput(body: unknown): EventInput {
  const parsed = eventSchema.parse(body);
  const rule = parsed.recurrence;

  return {
    title: parsed.title,
    description: parsed.description ?? null,
    category: parsed.category ?? null,
    location: parsed.location ?? null,
    signupOpen: parsed.signupOpen ?? false,
    capacity: parsed.capacity ?? null,
    firstOn: localDay(parsed.firstOn),
    startsAtMinute: parsed.startsAtMinute,
    durationMinutes: parsed.durationMinutes,
    recurrence:
      rule == null
        ? null
        : {
            frequency: rule.frequency,
            interval: rule.interval,
            count: rule.count ?? null,
            until: rule.until == null ? null : localDay(rule.until),
          },
  };
}

/**
 * The board's own event calendar, over HTTP.
 *
 * One capability, declared on the class so a route added here later inherits it
 * rather than being open by omission. events:manage is the whole of this
 * controller: arranging what the association does, announcing it, and calling a
 * date off are one job held by one audience.
 *
 * Reading the calendar as a resident, and signing up to a date, are not here.
 * They are a different audience with a capability of their own and will have a
 * base path of their own, on the argument the booking module makes: one
 * controller carrying two capabilities is a route open to the wrong half of the
 * house.
 *
 * The publish route is separate from the ordinary save. It is what decides who
 * may read a series, it is what the audit log records as the publication, and a
 * second way to reach either through a save would be a second way for the record
 * to be missed.
 */
@Controller("api/events")
@RequireCapability("events:manage")
export class EventAdminController {
  constructor(private readonly events: EventService) {}

  @Get()
  async list(): Promise<EventView[]> {
    return this.events.list();
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<EventView> {
    return this.events.create(
      eventInput(body),
      requirePrincipal(request).personId,
    );
  }

  /**
   * Calls off one date.
   *
   * Declared above the parameter routes so "occurrences" is never read as a
   * series' id, and a POST to a named act rather than a DELETE because nothing
   * is deleted: the row stays with the date it was called off on.
   */
  @Post("occurrences/:occurrenceId/cancel")
  async cancelOccurrence(
    @Param("occurrenceId") occurrenceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<EventView> {
    return this.events.cancelOccurrence(
      occurrenceId,
      requirePrincipal(request).personId,
    );
  }

  @Get(":id")
  async byId(@Param("id") id: string): Promise<EventView> {
    return this.events.byId(id);
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<EventView> {
    return this.events.update(
      id,
      eventInput(body),
      requirePrincipal(request).personId,
    );
  }

  @Post(":id/publish")
  async publish(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<EventView> {
    const input = publishSchema.parse(body);
    return this.events.publish(id, input, requirePrincipal(request).personId);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.events.remove(id, requirePrincipal(request).personId);
  }
}
