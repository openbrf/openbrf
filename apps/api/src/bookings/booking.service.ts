import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type {
  BookingResourceMode,
  BookingStatus,
} from "../generated/prisma/enums";
import { failureName } from "../logging/failure";
import { lockApartmentBookings, lockResourceBookings } from "./booking-lock";
import { BookingMailerService } from "./booking-mailer.service";
import { type BookingQuota, BookingError } from "./booking.error";
import {
  daysIn,
  generateSlots,
  MAX_SLOT_DAYS,
  periodFor,
  type SlotResource,
} from "./slot-engine";
import {
  addLocalDays,
  compareLocalDays,
  dateColumnOf,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localDaysBetween,
  localMinuteOf,
  localWeekAround,
  type Period,
} from "./stockholm-calendar";

/** The kind an audit entry names a booking by. */
const BOOKING_TARGET_KIND = "booking";

/** An apartment a booking may be made for, as a picker shows it. */
export interface BookingApartmentView {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

/**
 * What a slot is to the person looking at it.
 *
 * `TAKEN` says a slot is held and never by whom. Which apartment holds which
 * hour is personal data no other resident is shown, and it is what
 * bookings:manage exists to gate - so the calendar a resident reads is a
 * calendar of free and not free.
 *
 * `MINE` is the caller's own booking, and carries its identifier so the screen
 * can offer to cancel it without a second lookup. It is deliberately the
 * caller's own and not the household's: a partner's booking is theirs to
 * cancel, and the my-bookings list is where each person sees what they hold.
 *
 * `PAST` is a free slot that has already begun. Kept in the answer rather than
 * filtered out, because a week whose earlier days simply vanished would leave
 * the screen unable to draw a grid.
 */
export type SlotState = "FREE" | "TAKEN" | "MINE" | "PAST";

export interface BookableSlotView {
  /** ISO instants, and what a booking request sends back verbatim. */
  startsAt: string;
  endsAt: string;
  /** The Stockholm calendar day the slot opens on, "YYYY-MM-DD". */
  day: string;
  /** Minutes past local midnight it opens at, so 420 is 07:00. */
  opensAtMinute: number;
  state: SlotState;
  /** Set only when the state is MINE. */
  bookingId: string | null;
}

export interface OwnBookingView {
  id: string;
  resourceId: string;
  resourceName: string;
  mode: BookingResourceMode;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  apartment: BookingApartmentView | null;
}

/**
 * Who made a booking, as the board may be told.
 *
 * The three cases the issue queue has, minus the external one: a booking is
 * always made by an account. `protected` is a person with protected personal
 * data, whose name is withheld here for the reason the issue queue withholds
 * it - the board's address book has a statutory reason to print it and a
 * booking calendar has none. `unknown` is a booker reference that no longer
 * resolves, which service-tier data has to be able to say rather than break.
 */
export type BookingBookerView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface ManagedBookingView extends OwnBookingView {
  bookedBy: BookingBookerView;
}

export interface BookInput {
  resourceId: string;
  apartmentId: string;
  /** The slot's own start, copied from the calendar rather than typed. */
  startsAt: Date;
  /** The last night's end, for a resource booked by the night. Null otherwise. */
  endsAt: Date | null;
}

/**
 * Booking a resource, cancelling a booking, and reading the calendar.
 *
 * ## The slot is claimed by the database
 *
 * A booking is inserted with `ON CONFLICT DO NOTHING` against the partial
 * unique index on (resourceId, startsAt) WHERE status = 'BOOKED', inside the
 * transaction that writes the audit entry. Two residents claiming the same
 * laundry hour in the same instant both reach the insert; one row is written
 * and the other statement affects nothing, and the transaction that affected
 * nothing is refused with `slot-taken` - the same answer a read taken a moment
 * earlier would have given, because it is the same fact.
 *
 * There is deliberately no read-then-write check before it. A read would be
 * true when it was taken and false by the time the insert ran, which is the
 * defect the index exists to remove rather than a check that helps.
 *
 * ## The quota is derived, never stored
 *
 * Both limits are counted at write time from the bookings the apartment holds,
 * and the apartment comes from the booker's own residency rows. Nothing is
 * stored anywhere that says how much of an allowance is left, which is what
 * makes three things true without any bookkeeping.
 *
 * Joint holders of one apartment share one allowance, because they book against
 * one apartment and the count is over that apartment's bookings.
 *
 * A cancelled booking gives its share back the moment it is cancelled, because
 * a cancelled row is not counted.
 *
 * A residency with a move-out date stops that person booking anything from that
 * date - the residency has to cover the period being booked, not merely today -
 * while the bookings they made before it go on counting against the household
 * they were made for. So a move-out on the Thursday bites on the Thursday, and
 * the household does not get a fresh week's allowance out of somebody leaving.
 *
 * The apartment is taken from any active residency and not only from a MEMBER
 * one. bookings:book is granted for living here rather than for holding the
 * tenant-ownership - a partner and a tenant hold it, and the capability's own
 * reasoning says so - so a MEMBER-only derivation would either refuse every
 * non-member resident a laundry hour or let them book without an allowance at
 * all. Counting against the apartment gives joint holders one shared allowance
 * either way, which is the property that has to hold.
 *
 * ## Correspondence is outside the transaction
 *
 * Both write paths hand a message to {@link BookingMailerService} after their
 * transaction has committed, and neither lets a failure to send travel out of
 * the method. Who is written to is that service's decision; why the send sits
 * after the commit is stated at the two call sites.
 *
 * ## Reserved schema room stays reserved
 *
 * Nothing here writes `startedAt` or the `RELEASED` status. "Unstarted", which
 * is what the concurrent limit counts, is read from `startsAt` being in the
 * future: it is a fact about the booked period rather than about anybody having
 * checked in, and this module has no check-in.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mailer: BookingMailerService,
  ) {}

  /**
   * The apartments the caller may book against: the ones they live in, today.
   *
   * MEMBER residencies first, so a household holding one apartment as members
   * and another as tenants gets the one they hold first. Deduplicated, because
   * joint holders and successive residencies of one apartment are several rows
   * about one home.
   */
  async ownApartments(personId: string): Promise<BookingApartmentView[]> {
    const residencies = await this.prisma.residency.findMany({
      where: activeResidencyOf(personId, new Date()),
      select: { apartment: { select: APARTMENT_SELECT } },
      orderBy: [{ role: "asc" }, { movedInOn: "asc" }],
    });

    const seen = new Set<string>();
    const apartments: BookingApartmentView[] = [];
    for (const residency of residencies) {
      if (seen.has(residency.apartment.id)) {
        continue;
      }
      seen.add(residency.apartment.id);
      apartments.push(toApartmentView(residency.apartment));
    }
    return apartments;
  }

  /**
   * The slots a resource offers over a range of days, and what each one is.
   *
   * The range is inclusive at both ends and bounded, so one request cannot ask
   * a minute-slotted resource for a year.
   */
  async slots(
    personId: string,
    resourceId: string,
    from: LocalDay,
    to: LocalDay,
  ): Promise<BookableSlotView[]> {
    requireBoundedRange(from, to);

    const resource = await this.requireOfferedResource(resourceId);
    const slots = generateSlots(resource, from, to);
    if (slots.length === 0) {
      return [];
    }

    const first = slots[0];
    const last = slots[slots.length - 1];
    /* c8 ignore next 3 -- unreachable: a non-empty array has both ends */
    if (first === undefined || last === undefined) {
      return [];
    }

    const held = await this.prisma.booking.findMany({
      where: {
        resourceId,
        status: "BOOKED",
        startsAt: { lt: last.endsAt },
        endsAt: { gt: first.startsAt },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        bookedByPersonId: true,
      },
    });

    const now = Date.now();
    return slots.map((slot) => {
      /*
       * Matched by overlap rather than by an equal start time, although the
       * two agree for every booking made through this service. A board that
       * narrows a laundry room's hours leaves yesterday's bookings sitting
       * across today's slot boundaries, and a calendar that matched only exact
       * starts would draw those slots free and then refuse the claim.
       *
       * The scan is over one resource's live bookings inside the window, which
       * a two-month calendar bounds to a few hundred rows.
       */
      const booking = held.find(
        (candidate) =>
          candidate.startsAt.getTime() < slot.endsAt.getTime() &&
          candidate.endsAt.getTime() > slot.startsAt.getTime(),
      );

      const state: SlotState =
        booking === undefined
          ? slot.startsAt.getTime() <= now
            ? "PAST"
            : "FREE"
          : booking.bookedByPersonId === personId
            ? "MINE"
            : "TAKEN";

      return {
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        day: formatLocalDay(localDayOf(slot.startsAt)),
        opensAtMinute: localMinuteOf(slot.startsAt),
        state,
        bookingId: state === "MINE" ? (booking?.id ?? null) : null,
      };
    });
  }

  /**
   * The caller's own live bookings that have not ended, soonest first.
   *
   * Live and unfinished, because this is the list a resident acts on: what they
   * hold and may cancel. A cancelled booking has given its slot back and has
   * nothing left to do; a finished one is history, and the history of every
   * booking somebody made is the access report's section rather than a screen.
   */
  async listOwn(personId: string): Promise<OwnBookingView[]> {
    const bookings = await this.prisma.booking.findMany({
      where: {
        bookedByPersonId: personId,
        status: "BOOKED",
        endsAt: { gt: new Date() },
      },
      orderBy: [{ startsAt: "asc" }],
      include: BOOKING_INCLUDE,
    });
    return bookings.map((booking) => toOwnView(booking));
  }

  /**
   * Every booking on the calendar in a window, with who made it.
   *
   * Reached with bookings:manage, which is the capability that lets the board
   * see which apartment holds which hour. Cancelled bookings are included: the
   * board reading this is often reading it because somebody says they cancelled
   * something, and a list that hid cancellations could not answer that.
   */
  async listForBoard(filter: {
    resourceId?: string;
    from: LocalDay;
    to: LocalDay;
  }): Promise<ManagedBookingView[]> {
    requireBoundedRange(filter.from, filter.to);

    const window = windowOf(filter.from, filter.to);
    const bookings = await this.prisma.booking.findMany({
      where: {
        ...(filter.resourceId === undefined
          ? {}
          : { resourceId: filter.resourceId }),
        startsAt: { lt: window.endsAt },
        endsAt: { gt: window.startsAt },
      },
      orderBy: [{ startsAt: "asc" }],
      include: BOOKING_INCLUDE,
    });

    const personIds = [
      ...new Set(bookings.map((booking) => booking.bookedByPersonId)),
    ];
    const persons = await this.prisma.person.findMany({
      where: { id: { in: personIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return bookings.map((booking) => ({
      ...toOwnView(booking),
      bookedBy: bookerOf(booking.bookedByPersonId, byId),
    }));
  }

  /**
   * Claims a slot for one of the caller's own apartments.
   *
   * Everything that decides the answer happens in one transaction: the locks,
   * the quota counts, the insert that the index arbitrates, and the audit
   * entry. A refusal rolls the whole of it back, so there is no state in which
   * the log says a booking was made and no booking exists, or the reverse.
   */
  async book(personId: string, input: BookInput): Promise<OwnBookingView> {
    const now = new Date();
    const resource = await this.requireOfferedResource(input.resourceId);

    const period = periodFor(resource, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
    if (period === null) {
      throw new BookingError(
        "That period is not a slot this resource offers.",
        "slot-not-bookable",
      );
    }
    if (period.startsAt.getTime() <= now.getTime()) {
      // A slot that has begun is not bookable, however free it is. Booking the
      // hour somebody is standing in would be a claim on time that has gone.
      throw new BookingError(
        "That slot has already begun.",
        "slot-not-bookable",
      );
    }

    // After the period, because whether the caller holds the apartment is a
    // question about the period and not about today.
    const apartmentId = await this.requireOwnApartment(
      personId,
      input.apartmentId,
      period,
    );

    const booking = await this.prisma.$transaction(async (tx) => {
      // Apartment first and resource second, which is the one order every
      // booking takes; see booking-lock.ts.
      await lockApartmentBookings(tx, apartmentId);
      if (resource.mode === "DATE_RANGE") {
        await lockResourceBookings(tx, resource.id);
        await this.refuseOverlap(tx, resource.id, period);
      }

      await this.refuseOverQuota(tx, resource, apartmentId, period, now);

      /*
       * The claim, and the whole of what refuses a double booking.
       *
       * `skipDuplicates` is ON CONFLICT DO NOTHING, so the loser of a race
       * matches zero rows rather than raising something to be inspected: the
       * row exists and belongs to somebody else, which is a fact and not an
       * error, and it is the same fact a read would have reported. It is also
       * what makes the two claims wait for each other rather than guess - the
       * second insert blocks on the first transaction's uncommitted row and
       * then does nothing.
       *
       * No conflict target is named, so any unique index on the table
       * arbitrates. There are two: the primary key, whose value is a cuid this
       * statement generated, and the partial one over the resource and the
       * start time. In practice it is the partial one.
       */
      const { count } = await tx.booking.createMany({
        data: [
          {
            resourceId: resource.id,
            apartmentId,
            bookedByPersonId: personId,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
          },
        ],
        skipDuplicates: true,
      });

      if (count === 0) {
        throw new BookingError("That slot is already booked.", "slot-taken");
      }

      /*
       * Read back by what the index makes unique rather than by an identifier
       * the insert returned, because a bulk insert does not return one. Inside
       * this transaction the pair and the status name exactly the row just
       * written: the index is what guarantees there is no second one.
       */
      const created = await tx.booking.findFirstOrThrow({
        where: {
          resourceId: resource.id,
          startsAt: period.startsAt,
          status: "BOOKED",
        },
        include: BOOKING_INCLUDE,
      });

      await this.audit.record(
        {
          action: "BOOKING_MADE",
          actorPersonId: personId,
          targetPersonId: personId,
          targetKind: BOOKING_TARGET_KIND,
          targetId: created.id,
          /*
           * The identifiers, the mechanics and when the period starts, which is
           * what makes the entry answerable later. Never the resource's name or
           * the household's: those belong to rows with a lifecycle, and a copy
           * in the append-only log would outlive them by design.
           */
          context: {
            resourceId: resource.id,
            apartmentId,
            mode: resource.mode,
            startsAt: period.startsAt.toISOString(),
            days: daysIn(period),
          },
        },
        tx,
      );

      return created;
    });

    /*
     * The confirmation, after the commit and best effort.
     *
     * The slot is held by now and the index will not let anybody else have it,
     * so letting a mail outage reject the request would report a booking that
     * was made as a failure - and here that costs more than an unsent message.
     * The resident reads the refusal, presses the button again, and meets
     * `slot-taken` raised by their own booking: an hour they hold, that they
     * have been told twice they do not.
     *
     * The failure is named by the booking and by the class of what went wrong.
     * A mail server's rejection quotes the envelope, and that envelope holds an
     * address decrypted inside the call above.
     */
    try {
      await this.mailer.sendConfirmation({
        bookingId: booking.id,
        bookedByPersonId: booking.bookedByPersonId,
        resourceName: booking.resource.name,
        mode: booking.resource.mode,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      });
    } catch (error) {
      this.logger.error(
        `Booking confirmation failed for booking ${booking.id}: ` +
          failureName(error),
      );
    }

    // The identifiers and the mode. Which household booked which hour is the
    // thing the capability gates, and a log line is not behind it.
    this.logger.log(
      `Booked ${booking.id} on resource ${resource.id} (${resource.mode})`,
    );
    return toOwnView(booking);
  }

  /**
   * Cancels a booking the caller made.
   *
   * A booking belonging to somebody else is answered exactly as one that does
   * not exist, so this endpoint cannot be used to find out who holds what.
   */
  async cancelOwn(
    personId: string,
    bookingId: string,
  ): Promise<OwnBookingView> {
    return this.cancel(bookingId, personId, personId);
  }

  /**
   * Cancels anybody's booking. Reached with bookings:manage.
   *
   * The board's own act: a guest apartment held by a household that has moved
   * out, a laundry room closed for repair. The entry names the board member who
   * did it as the actor and the person who made the booking as the subject, so
   * the access report shows the resident that somebody else cancelled it.
   */
  async cancelForBoard(
    actorPersonId: string,
    bookingId: string,
  ): Promise<OwnBookingView> {
    return this.cancel(bookingId, actorPersonId, null);
  }

  /**
   * Sets a booking to CANCELLED and records who did it.
   *
   * The status is the whole of it. The row stays - a cancellation is a fact
   * about a booking that was made, and it is erased on the same clock as any
   * other booking - and the partial unique index covers live bookings only, so
   * cancelling is also what gives the slot back to the calendar.
   *
   * @param ownerPersonId The person the booking must belong to, or null when
   *   the caller may cancel anybody's.
   */
  private async cancel(
    bookingId: string,
    actorPersonId: string,
    ownerPersonId: string | null,
  ): Promise<OwnBookingView> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: {
          id: bookingId,
          ...(ownerPersonId === null
            ? {}
            : { bookedByPersonId: ownerPersonId }),
        },
        include: BOOKING_INCLUDE,
      });
      if (booking === null) {
        throw new BookingError("No such booking.", "booking-not-found");
      }

      /*
       * A conditional update rather than a plain one, so two people cancelling
       * the same booking at the same instant produce one cancellation and one
       * refusal. The second matches zero rows because the status it required is
       * no longer there, which is the same shape the claim above has and for
       * the same reason: the read that found the booking was true when it was
       * taken.
       */
      const { count } = await tx.booking.updateMany({
        where: { id: bookingId, status: "BOOKED" },
        data: { status: "CANCELLED" },
      });
      if (count === 0) {
        throw new BookingError(
          "That booking is not live, so there is nothing to cancel.",
          "already-cancelled",
        );
      }

      await this.audit.record(
        {
          action: "BOOKING_CANCELLED",
          actorPersonId,
          // The person whose booking it was, whoever cancelled it. That is what
          // puts the entry in their access report as something about them.
          targetPersonId: booking.bookedByPersonId,
          targetKind: BOOKING_TARGET_KIND,
          targetId: bookingId,
          context: {
            resourceId: booking.resourceId,
            apartmentId: booking.apartmentId,
            mode: booking.resource.mode,
            startsAt: booking.startsAt.toISOString(),
          },
        },
        tx,
      );

      return { booking, view: toOwnView({ ...booking, status: "CANCELLED" }) };
    });

    /*
     * The notice, after the commit and best effort, for the reason the
     * confirmation gives: the slot has already gone back to the calendar and
     * cancelling twice is refused, so a mail outage has nothing to offer but a
     * refusal the caller cannot act on.
     *
     * Whether anybody is written to at all is BookingMailerService's decision,
     * and stated there: the actor is passed rather than tested here, because the
     * rule is about who cancelled whose booking and not about which of the two
     * routes reached this method.
     */
    const { booking } = cancelled;
    try {
      await this.mailer.sendCancellation({
        bookingId: booking.id,
        bookedByPersonId: booking.bookedByPersonId,
        cancelledByPersonId: actorPersonId,
        resourceName: booking.resource.name,
        mode: booking.resource.mode,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      });
    } catch (error) {
      this.logger.error(
        `Cancellation notice failed for booking ${booking.id}: ` +
          failureName(error),
      );
    }

    this.logger.log(`Cancelled booking ${bookingId}`);
    return cancelled.view;
  }

  /** The resource, when it exists and is still offered for booking. */
  private async requireOfferedResource(
    resourceId: string,
  ): Promise<ResourceRecord> {
    const resource = await this.prisma.bookableResource.findUnique({
      where: { id: resourceId },
      select: RESOURCE_SELECT,
    });
    if (resource === null) {
      throw new BookingError(
        "No such bookable resource.",
        "resource-not-found",
      );
    }
    if (resource.deactivatedAt !== null) {
      // Named rather than hidden. A resident who could book the sauna last week
      // is better served by being told it was withdrawn than by being told it
      // never existed, and the catalogue is not secret.
      throw new BookingError(
        "That resource has been withdrawn from booking.",
        "resource-deactivated",
      );
    }
    return resource;
  }

  /**
   * The apartment, when the caller holds it for the period they are booking.
   *
   * The residency has to cover the booked period rather than merely today. A
   * household with a move-out date on the Thursday does not hold the laundry
   * room on the Friday, and a booking made on the Monday for the Friday would
   * otherwise stand in a week when nobody living there could use it - which is
   * an hour taken from the household that moved in. The same rule at the other
   * end: somebody moving in next month does not hold this month's slots.
   *
   * Derived from the residency rows at write time and nothing else, which is
   * what makes a move-out bite the day it says without a job having to walk the
   * bookings and cancel any.
   */
  private async requireOwnApartment(
    personId: string,
    apartmentId: string,
    period: Period,
  ): Promise<string> {
    const held = await this.prisma.residency.count({
      where: {
        ...residencyCoveringPeriod(personId, period),
        apartmentId,
      },
    });
    if (held === 0) {
      // Deliberately the same answer as an apartment that is not in the
      // register: otherwise this endpoint enumerates the building.
      throw new BookingError("No such apartment.", "apartment-not-found");
    }
    return apartmentId;
  }

  /** Refuses a range of nights that runs across one already held. */
  private async refuseOverlap(
    tx: Prisma.TransactionClient,
    resourceId: string,
    period: Period,
  ): Promise<void> {
    const clash = await tx.booking.findFirst({
      where: {
        resourceId,
        status: "BOOKED",
        startsAt: { lt: period.endsAt },
        endsAt: { gt: period.startsAt },
      },
      select: { id: true },
    });
    if (clash !== null) {
      // The same refusal the index gives for a slot, because it is the same
      // fact: somebody else holds part of what was asked for.
      throw new BookingError(
        "Part of that period is already booked.",
        "slot-taken",
      );
    }
  }

  /** Refuses a booking that would put the apartment over either limit. */
  private async refuseOverQuota(
    tx: Prisma.TransactionClient,
    resource: ResourceRecord,
    apartmentId: string,
    period: Period,
    now: Date,
  ): Promise<void> {
    if (resource.maxConcurrentBookings !== null) {
      /*
       * Unstarted, which is `startsAt` in the future. The limit is about how
       * much of the future one household may hold at once - what stops one of
       * them reserving every Saturday until spring - so a booking that has
       * begun is no longer holding anything back from anybody.
       *
       * Read from the booked period and deliberately not from `startedAt`,
       * which is reserved schema room this module neither reads nor writes.
       */
      const held = await tx.booking.count({
        where: {
          resourceId: resource.id,
          apartmentId,
          status: "BOOKED",
          startsAt: { gt: now },
        },
      });
      if (held >= resource.maxConcurrentBookings) {
        throw quotaReached(
          "maxConcurrentBookings",
          resource.maxConcurrentBookings,
        );
      }
    }

    if (resource.maxBookingsPerWeek !== null) {
      /*
       * The week the booking is for, not the week it is being made in. A
       * resident planning next month reads the limit as "two a week" about the
       * week they are looking at, and counting the week they happen to be
       * sitting in would let one household take every slot of every future week
       * in a single afternoon.
       */
      const week = localWeekAround(period.startsAt);
      const made = await tx.booking.count({
        where: {
          resourceId: resource.id,
          apartmentId,
          status: "BOOKED",
          startsAt: { gte: week.startsAt, lt: week.endsAt },
        },
      });
      if (made >= resource.maxBookingsPerWeek) {
        throw quotaReached("maxBookingsPerWeek", resource.maxBookingsPerWeek);
      }
    }
  }
}

/**
 * Refuses a range that runs backwards or covers too many days.
 *
 * One rule for both calendars, because a caller asking for a year of a
 * minute-slotted resource is the same request whichever endpoint takes it, and
 * two copies of the number would eventually disagree.
 */
function requireBoundedRange(from: LocalDay, to: LocalDay): void {
  if (
    compareLocalDays(from, to) > 0 ||
    localDaysBetween(from, to) >= MAX_SLOT_DAYS
  ) {
    throw new BookingError(
      `A calendar may be asked for at most ${String(MAX_SLOT_DAYS)} days, ending on or after it begins.`,
      "range-invalid",
    );
  }
}

function quotaReached(limit: BookingQuota, allowed: number): BookingError {
  return new BookingError(
    "The apartment already holds as many bookings of this resource as it may.",
    "quota-reached",
    { limit, allowed },
  );
}

/**
 * A residency that has not ended, as every reader of this table states it.
 *
 * The same predicate the principal is built from, so "may book" and "which
 * apartment may I book against" cannot disagree: a person the guard treats as a
 * resident is offered an apartment here, and one it does not is offered none.
 */
function activeResidencyOf(
  personId: string,
  now: Date,
): Prisma.ResidencyWhereInput {
  return {
    personId,
    OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
  };
}

/**
 * A residency covering every day a period falls on, both ends included.
 *
 * The move-out date is the first day not held, which is how every other reader
 * of this table treats it, and the move-in date is the first day that is.
 *
 * Checking the start alone is enough for a resource whose period begins and
 * ends inside one day, and wrong for one that does not. A guest apartment is
 * booked as a stay: a household whose move-out date falls on the twelfth could
 * claim the tenth to the fifteenth on the strength of the tenth, and the nights
 * from the twelfth would then stand in a flat it no longer holds - taken from
 * whoever moved in. So the day the period's last instant falls on is checked as
 * well as the day it opens on, and `endsAt` is exclusive, which is why it is
 * the moment before it whose day has to be held.
 *
 * Both bounds are compared as calendar dates rather than as instants, because
 * both residency columns are `@db.Date` and a date is not an instant. A whole
 * day and a night open at local midnight, which is the evening before in UTC,
 * so an instant comparison puts a residency beginning on the booked day after
 * the period it covers - and answers the household that the apartment does not
 * exist on the day it moves in. It gets the other end wrong the same way, for a
 * time slot in the hour after midnight: read as instants, a residency ending
 * that morning would still cover it. {@link dateColumnOf} is what puts the two
 * sides in the same terms.
 */
function residencyCoveringPeriod(
  personId: string,
  period: Period,
): Prisma.ResidencyWhereInput {
  const lastInstant = new Date(period.endsAt.getTime() - 1);
  const opensOn = dateColumnOf(localDayOf(period.startsAt));
  const closesOn = dateColumnOf(localDayOf(lastInstant));
  return {
    personId,
    movedInOn: { lte: opensOn },
    OR: [{ movedOutOn: null }, { movedOutOn: { gt: closesOn } }],
  };
}

/**
 * The instants a range of local days spans, the end exclusive.
 *
 * Local midnight to the local midnight after the last day, so a window over the
 * October Sunday is 25 hours longer than the days in it suggest - which is the
 * point of asking the calendar rather than multiplying by 24.
 */
function windowOf(from: LocalDay, to: LocalDay): Period {
  const startsAt = instantAt(from, 0);
  const endsAt = instantAt(addLocalDays(to, 1), 0);
  /* c8 ignore next 5 -- unreachable: Sweden's clock has never skipped midnight */
  if (startsAt === null || endsAt === null) {
    throw new Error(
      `No local midnight bounds ${formatLocalDay(from)} to ${formatLocalDay(to)}.`,
    );
  }
  return { startsAt, endsAt };
}

const RESOURCE_SELECT = {
  id: true,
  name: true,
  mode: true,
  slotMinutes: true,
  opensAtMinute: true,
  closesAtMinute: true,
  maxConcurrentBookings: true,
  maxBookingsPerWeek: true,
  deactivatedAt: true,
} as const;

interface ResourceRecord extends SlotResource {
  id: string;
  name: string;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
  deactivatedAt: Date | null;
}

const APARTMENT_SELECT = {
  id: true,
  number: true,
  address: { select: { street: true, number: true } },
} as const;

const BOOKING_INCLUDE = {
  resource: { select: { id: true, name: true, mode: true } },
  apartment: { select: APARTMENT_SELECT },
} as const;

interface ApartmentRecord {
  id: string;
  number: string;
  address: { street: string; number: string };
}

function toApartmentView(apartment: ApartmentRecord): BookingApartmentView {
  return {
    id: apartment.id,
    number: apartment.number,
    address: `${apartment.address.street} ${apartment.address.number}`,
  };
}

function toOwnView(booking: {
  id: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  resource: { id: string; name: string; mode: BookingResourceMode };
  apartment: ApartmentRecord | null;
}): OwnBookingView {
  return {
    id: booking.id,
    resourceId: booking.resource.id,
    resourceName: booking.resource.name,
    mode: booking.resource.mode,
    status: booking.status,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    apartment:
      booking.apartment === null ? null : toApartmentView(booking.apartment),
  };
}

function bookerOf(
  personId: string,
  persons: ReadonlyMap<
    string,
    {
      id: string;
      firstName: string;
      lastName: string;
      protectedPersonalData: boolean;
    }
  >,
): BookingBookerView {
  const person = persons.get(personId);
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId: person.id };
  }
  return {
    kind: "resident",
    personId: person.id,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}
