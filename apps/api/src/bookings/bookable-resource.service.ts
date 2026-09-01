import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { BookingResourceMode } from "../generated/prisma/enums";
import { BookingError, type BookingTextLocation } from "./booking.error";
import { checkResourceSchedule } from "./resource-schedule";

/** The kind an audit entry names a resource by. */
const RESOURCE_TARGET_KIND = "bookableResource";

/** A resource as the board configures it. */
export interface BookableResourceView {
  id: string;
  name: string;
  description: string | null;
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
  /** ISO instant, or null while the resource is offered for booking. */
  deactivatedAt: string | null;
  /**
   * How many bookings have been made against it, cancelled ones included.
   *
   * A count and never a list: the board needs it to see what withdrawing a
   * resource would leave behind, and nothing about who booked what belongs on
   * a configuration screen.
   */
  bookingCount: number;
}

/**
 * A resource as somebody booking it is shown it.
 *
 * The catalogue view minus the booking count, which is configuration detail:
 * how much has been booked against a resource is what a board weighs before
 * withdrawing one, and has nothing to do with taking a laundry hour.
 *
 * The two limits are on it. They are the rules the person booking is subject
 * to, so a screen can say why a slot was refused before it is - and they are
 * the board's policy for its own building rather than anybody's data.
 */
export type BookableResourceSummary = Omit<
  BookableResourceView,
  "bookingCount" | "deactivatedAt"
>;

/**
 * A resource as the board states it.
 *
 * Every optional field is `null` rather than absent, so a value the board
 * cleared and a value it did not send are the same thing. The alternative -
 * treating absence as "leave it alone" - would let a resource keep a slot
 * length after it was changed to whole-day booking, which is exactly the dead
 * configuration {@link checkResourceSchedule} exists to refuse.
 */
export interface BookableResourceInput {
  name: string;
  description: string | null;
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
}

/** The configuration fields an update reports as changed, by name. */
const COMPARED_FIELDS = [
  "name",
  "description",
  "mode",
  "slotMinutes",
  "opensAtMinute",
  "closesAtMinute",
  "maxConcurrentBookings",
  "maxBookingsPerWeek",
] as const satisfies readonly (keyof BookableResourceInput)[];

/**
 * The free-text fields the personal-identity-number scan reads.
 *
 * The two the board writes in its own words. Everything else on a resource is
 * an enum or a number, and neither can carry a personal identity number.
 */
const SCANNED_FIELDS = [
  "name",
  "description",
] as const satisfies readonly BookingTextLocation["field"][];

/**
 * The fields that decide what a booking on this resource can be.
 *
 * Changing any of them moves the grid the bookings already made were cut from.
 * A laundry room switched from two-hour slots to whole days, or opened an hour
 * later, leaves every standing booking with a start and an end that correspond
 * to no period the resource now offers - a row nothing on the calendar can
 * draw and no cancellation screen can explain. So these four are refused while
 * such a booking stands; see {@link BookableResourceService.update}.
 *
 * The two quotas are deliberately not here. They bound what may be booked next
 * and say nothing about what an existing booking is, so lowering a weekly limit
 * bites from the following claim onwards and invalidates nothing already made.
 * Neither is the name or the description: those are what the board calls the
 * thing, and a house renaming its laundry room must not have to cancel a week
 * of bookings first.
 */
const MECHANICS_FIELDS = [
  "mode",
  "slotMinutes",
  "opensAtMinute",
  "closesAtMinute",
] as const satisfies readonly (keyof BookableResourceInput)[];

/**
 * The catalogue of bookable resources, as the board keeps it.
 *
 * The board names its own, the way it names its issue types: an association
 * with two laundry rooms, a sauna and a guest apartment does not describe its
 * house the way one with a roof terrace and a workshop does. What is fixed is
 * not the list but the three ways a thing can be booked, which is why `mode`
 * is an enum and the resource itself is free text.
 *
 * Deactivated, never deleted. The bookings already made against a resource say
 * what they were for only through it, so a board tidying its catalogue in
 * October must not make September's guest-apartment bookings unreadable. There
 * is deliberately no removal method here at all - not one that refuses when the
 * resource has been used, the way the issue types have, because a resource that
 * has never been booked is still the thing the quota counts against and the
 * distinction would only be a trap.
 *
 * Every write is audited in the transaction that performs it. The entries carry
 * the mode, the field names that changed and the counts affected, and never the
 * name or the description: those are free text belonging to a row with a
 * lifecycle, and a copy in the append-only log would outlive the row by design.
 *
 * The name and the description are also scanned for a personal identity number
 * before either write reaches the table, which is the guardrail every
 * board-publish path in this platform carries. There is no publication step
 * here to hang it on - a resource is on every resident's calendar as soon as it
 * exists - so both write paths are scanned. What those two fields reach is set
 * out on `refusePersonalIdentityNumbers` below.
 */
@Injectable()
export class BookableResourceService {
  private readonly logger = new Logger(BookableResourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The whole catalogue, withdrawn resources included.
   *
   * Offered first and then withdrawn, each half by name, so a board reading the
   * screen sees what the house currently offers before what it used to.
   */
  async listAll(): Promise<BookableResourceView[]> {
    const resources = await this.prisma.bookableResource.findMany({
      orderBy: [
        { deactivatedAt: { sort: "asc", nulls: "first" } },
        { name: "asc" },
      ],
      include: { _count: { select: { bookings: true } } },
    });

    return resources.map((resource) => ({
      ...toView(resource),
      bookingCount: resource._count.bookings,
    }));
  }

  /**
   * The resources the house currently offers, by name.
   *
   * Withdrawn ones are absent rather than marked: this is the list somebody
   * chooses from, and a choice that cannot be made is not a choice. The board's
   * own screen reads {@link listAll}, which keeps them.
   */
  async listOffered(): Promise<BookableResourceSummary[]> {
    const resources = await this.prisma.bookableResource.findMany({
      where: { deactivatedAt: null },
      orderBy: [{ name: "asc" }],
    });

    return resources.map((resource) => {
      const { deactivatedAt: _withdrawn, ...offered } = toView(resource);
      return offered;
    });
  }

  async create(
    input: BookableResourceInput,
    actorPersonId: string,
  ): Promise<BookableResourceView> {
    const data = this.validated(input);

    const resource = await this.prisma.$transaction(async (tx) => {
      const created = await tx.bookableResource.create({ data });

      await this.audit.record(
        {
          action: "BOOKING_RESOURCE_CREATED",
          actorPersonId,
          targetKind: RESOURCE_TARGET_KIND,
          targetId: created.id,
          // The mechanics and the limits, never the name: see the class
          // comment. `quotas` says which limits were set without asserting
          // that an unset one is unlimited twice over.
          context: {
            mode: created.mode,
            quotas: quotaFieldsSet(created),
          },
        },
        tx,
      );

      return created;
    });

    this.logger.log(
      `Added bookable resource ${resource.id} (${resource.mode})`,
    );
    return { ...toView(resource), bookingCount: 0 };
  }

  /**
   * Rewrites a resource's configuration.
   *
   * A withdrawn resource is refused rather than silently edited. Editing one
   * would be configuring something the house does not offer, and the board's
   * next question after seeing the refusal is whether they meant to offer it
   * again - which is a decision rather than a side effect of saving a form.
   *
   * So is a change to the booking mechanics while bookings made under the old
   * ones are still to come. A booking carries the instants it was cut from the
   * grid at, not a reference to a slot, so moving the grid does not move them:
   * the resident who holds Tuesday 19:00-21:00 would go on holding it after the
   * board made the room whole-day, and neither the calendar nor the quota nor
   * the double-booking index would agree any more about what they hold. The
   * board's own next question is whether those bookings should be cancelled,
   * which is a decision taken booking by booking rather than the silent effect
   * of saving a settings form. Only what has not happened yet counts: a
   * finished booking is a record of what was, and rewriting the slots does not
   * make last March untrue.
   */
  async update(
    id: string,
    input: BookableResourceInput,
    actorPersonId: string,
  ): Promise<BookableResourceView> {
    const data = this.validated(input);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.bookableResource.findUnique({
        where: { id },
        include: { _count: { select: { bookings: true } } },
      });
      if (existing === null) {
        throw new BookingError(
          "No such bookable resource.",
          "resource-not-found",
        );
      }
      if (existing.deactivatedAt !== null) {
        throw new BookingError(
          "That resource has been withdrawn from booking.",
          "resource-deactivated",
        );
      }

      const changed = COMPARED_FIELDS.filter(
        (field) => existing[field] !== data[field],
      );

      if (MECHANICS_FIELDS.some((field) => changed.includes(field))) {
        /*
         * Counted here rather than taken from `_count.bookings` above, which is
         * every booking the resource ever carried. What refuses this change is
         * the ones still to come and not yet cancelled: a past booking is a
         * record of what was, and a cancelled one claims nothing.
         */
        const standing = await tx.booking.count({
          where: {
            resourceId: id,
            status: "BOOKED",
            endsAt: { gt: new Date() },
          },
        });
        if (standing > 0) {
          throw new BookingError(
            "This resource has bookings still to come. Cancel them, or wait until they have passed, before changing how it is booked.",
            "resource-in-use",
          );
        }
      }

      const resource = await tx.bookableResource.update({
        where: { id },
        data,
      });

      await this.audit.record(
        {
          action: "BOOKING_RESOURCE_UPDATED",
          actorPersonId,
          targetKind: RESOURCE_TARGET_KIND,
          targetId: id,
          // Which fields moved, and what the mechanics are now. Not what the
          // name was before or after: the entry names the record and the name
          // is read from the record while it exists.
          context: {
            mode: resource.mode,
            changed: [...changed],
            quotas: quotaFieldsSet(resource),
          },
        },
        tx,
      );

      return { ...toView(resource), bookingCount: existing._count.bookings };
    });
  }

  /**
   * Withdraws a resource from booking.
   *
   * The row stays, and so does every booking made against it. Withdrawing the
   * sauna does not cancel the bookings anybody already holds - that is a
   * separate decision, taken booking by booking by whoever holds
   * bookings:manage - so what this changes is that no new booking can be made.
   */
  async deactivate(
    id: string,
    actorPersonId: string,
  ): Promise<BookableResourceView> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.bookableResource.findUnique({
        where: { id },
        include: { _count: { select: { bookings: true } } },
      });
      if (existing === null) {
        throw new BookingError(
          "No such bookable resource.",
          "resource-not-found",
        );
      }
      if (existing.deactivatedAt !== null) {
        throw new BookingError(
          "That resource has already been withdrawn from booking.",
          "resource-deactivated",
        );
      }

      const resource = await tx.bookableResource.update({
        where: { id },
        data: { deactivatedAt: new Date() },
      });

      await this.audit.record(
        {
          action: "BOOKING_RESOURCE_DEACTIVATED",
          actorPersonId,
          targetKind: RESOURCE_TARGET_KIND,
          targetId: id,
          // The count says how much history the withdrawal leaves standing,
          // which is the fact somebody reading this entry later needs.
          context: {
            mode: resource.mode,
            bookings: existing._count.bookings,
          },
        },
        tx,
      );

      this.logger.log(`Withdrew bookable resource ${id} from booking`);
      return { ...toView(resource), bookingCount: existing._count.bookings };
    });
  }

  /**
   * The stated configuration, or a refusal.
   *
   * The schedule and the quota rules live here rather than in the endpoint's
   * schema, because both are about fields agreeing with each other rather than
   * about one field being well formed, and because the schema bounds what a
   * request may carry while this bounds what the table may hold.
   *
   * The personal-identity-number scan is here for a different reason: this
   * method is the one path both {@link BookableResourceService.create} and
   * {@link BookableResourceService.update} take to reach the table, so a guard
   * sitting on it cannot be got round by rewriting a resource that already
   * exists, and a third write path added later has to come through it as well.
   * Two call sites would be two places to remember.
   */
  private validated(input: BookableResourceInput): BookableResourceInput {
    this.refusePersonalIdentityNumbers(input);

    const problem = checkResourceSchedule(input);
    if (problem !== null) {
      throw new BookingError(scheduleMessage(problem), problem);
    }

    for (const quota of [
      input.maxConcurrentBookings,
      input.maxBookingsPerWeek,
    ]) {
      if (quota !== null && (!Number.isInteger(quota) || quota < 1)) {
        // Zero is refused rather than read as "none allowed". A board that
        // means nobody may book this has withdrawn the resource; a quota of
        // zero would be a resource that is offered and cannot be taken, which
        // no screen could explain.
        throw new BookingError(
          "A quota must be at least one booking. Leave it empty for no limit.",
          "quota-not-positive",
        );
      }
    }

    return input;
  }

  /**
   * Refuses a resource carrying a Swedish personal identity number.
   *
   * The same rule a page, a news item, a motion and an event series live under,
   * and it belongs here for the reason it belongs there: a personal identity
   * number on something the association publishes is a disclosure it cannot
   * take back, and it arrives pasted along with the text around it rather than
   * because anybody decided to publish it. A board member writing down who has
   * the sauna key, and the number beside their name so the next board knows
   * which neighbour is meant, is recording a practical arrangement rather than
   * deciding to publish somebody's identity number.
   *
   * What these two fields reach is wider than the settings form they are typed
   * on. Both are read by every resident: the name labels the resource on the
   * booking calendar and the description sits above it. The name travels
   * further still, into the confirmation mail sent once a booking commits and
   * into the notice sent when somebody else cancels one - so a number pasted
   * here is copied out to mailboxes the association does not control, which is
   * the one disclosure no later edit reaches. A resource is also the
   * longest-lived row in the module: it is withdrawn rather than deleted,
   * because the bookings made against it say what they were for only through
   * it, and it is outside every purge scope for the same reason. Text refused
   * here is text that would otherwise have stayed as long as the association
   * does.
   *
   * There is no publication step to hang the scan on, unlike an event series or
   * a news item: a resource is on every resident's calendar from the moment it
   * exists. So it is scanned on the way in, and on both write paths - a
   * resource that is already there must not be the way round the guard.
   *
   * The refusal names the field and the offset and never the value: the thing
   * the scan caught is precisely the thing that must not travel back. The
   * offset is published because the response is the only place it could come
   * from, and whether to render it is the screen's decision rather than this
   * one's - the settings panel names the field alone, on the reading the motion
   * form and the events panel apply to the same refusal, that a character
   * position in a textarea is not something a person acts on while the field
   * is.
   */
  private refusePersonalIdentityNumbers(input: BookableResourceInput): void {
    const locations: BookingTextLocation[] = [];

    for (const field of SCANNED_FIELDS) {
      const text = input[field];
      if (text === null) {
        continue;
      }
      for (const hit of scanForPersonalIdentityNumbers(text)) {
        locations.push({ field, offset: hit.index });
      }
    }

    if (locations.length > 0) {
      throw new BookingError(
        "The resource carries a personal identity number and cannot be saved.",
        "personal-identity-number",
        { locations },
      );
    }
  }
}

/** The refusal in words, for the server log and for a developer reading it. */
function scheduleMessage(problem: string): string {
  switch (problem) {
    case "schedule-required":
      return "A resource booked in time slots needs a slot length and an opening and closing time.";
    case "schedule-not-applicable":
      return "Only a resource booked in time slots carries a slot length and opening hours.";
    case "closes-before-opens":
      return "The closing time has to come after the opening time.";
    default:
      return "The slot length does not divide the opening hours into whole slots.";
  }
}

/** Which of the two limits are set, by name. */
function quotaFieldsSet(resource: {
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
}): string[] {
  const set: string[] = [];
  if (resource.maxConcurrentBookings !== null) {
    set.push("maxConcurrentBookings");
  }
  if (resource.maxBookingsPerWeek !== null) {
    set.push("maxBookingsPerWeek");
  }
  return set;
}

function toView(resource: {
  id: string;
  name: string;
  description: string | null;
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
  deactivatedAt: Date | null;
}): Omit<BookableResourceView, "bookingCount"> {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    mode: resource.mode,
    slotMinutes: resource.slotMinutes,
    opensAtMinute: resource.opensAtMinute,
    closesAtMinute: resource.closesAtMinute,
    maxConcurrentBookings: resource.maxConcurrentBookings,
    maxBookingsPerWeek: resource.maxBookingsPerWeek,
    deactivatedAt: resource.deactivatedAt?.toISOString() ?? null,
  };
}
