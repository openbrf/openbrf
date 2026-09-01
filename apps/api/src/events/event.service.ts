import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import {
  dateColumnOf,
  formatLocalDay,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type {
  EventRecurrenceFrequency,
  PageVisibility,
} from "../generated/prisma/enums";
import { occurrencesWithSignups } from "./event-attendance";
import {
  type EventTextLocation,
  EventError,
  type EventReason,
} from "./event.error";
import { lockOccurrencesSignups } from "./event-signup-lock";
import {
  displacedBy,
  planOccurrences,
  type StoredOccurrence,
} from "./occurrence-plan";
import {
  checkRecurrenceSchedule,
  occurrencePeriods,
  type RecurrenceRule,
  type SeriesSchedule,
} from "./recurrence";

/** The kind an audit entry names a series by. */
const EVENT_TARGET_KIND = "event";

/** The kind an audit entry names one date in a series by. */
const OCCURRENCE_TARGET_KIND = "eventOccurrence";

/** The recurrence rule as a request states it and a response answers with it. */
export interface EventRecurrenceView {
  frequency: EventRecurrenceFrequency;
  interval: number;
  /** How many occurrences in total, or null when the rule ends on a date. */
  count: number | null;
  /** "YYYY-MM-DD", or null when the rule ends on a count. */
  until: string | null;
}

/** One date in a series, as a screen reads it. */
export interface EventOccurrenceView {
  id: string;
  /** ISO instant. */
  startsAt: string;
  endsAt: string;
  /**
   * "YYYY-MM-DD", the local date it falls on.
   *
   * Sent beside the instants rather than left to the browser, so the date a
   * calendar files it under is the association's own and not the reader's. A
   * member reading the calendar from another time zone sees the cleaning day on
   * the day the notice in the stairwell says.
   */
  on: string;
  /** ISO instant the board called it off, or null while it is going ahead. */
  cancelledAt: string | null;
}

/** A series as the board's own screen shows it: drafts included. */
export interface EventView {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  visibility: PageVisibility;
  published: boolean;
  /** ISO instant it was first published, or null while it never has been. */
  publishedAt: string | null;
  signupOpen: boolean;
  /** Places at ONE occurrence. Null is no limit. */
  capacity: number | null;
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  firstOn: string;
  /** Minutes past local midnight, so 600 is 10:00. */
  startsAtMinute: number;
  durationMinutes: number;
  /** The rule, or null for a single event. */
  recurrence: EventRecurrenceView | null;
  /** Every date in the series, earliest first, called-off ones included. */
  occurrences: EventOccurrenceView[];
}

/**
 * A series as the board states it.
 *
 * Every optional field is `null` rather than absent, on the argument
 * BookableResourceInput makes: a form that cleared the location and a form that
 * did not send one are the same thing, and treating absence as "leave it alone"
 * would let a series keep a recurrence rule after it was changed into a one-off.
 */
export interface EventInput {
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  signupOpen: boolean;
  capacity: number | null;
  firstOn: LocalDay;
  startsAtMinute: number;
  durationMinutes: number;
  recurrence: RecurrenceRule | null;
}

/** Whether a series is published, and who for. */
export interface PublishEventInput {
  published: boolean;
  /** Left alone when absent, exactly as a news item's audience is. */
  visibility?: PageVisibility;
}

/** The free-text fields the personal-identity-number scan reads. */
const SCANNED_FIELDS = [
  "title",
  "description",
  "category",
  "location",
] as const satisfies readonly EventTextLocation["field"][];

/**
 * The fields an edit reports as changed, by name.
 *
 * The schedule fields are here as well as the prose ones, because the audit
 * entry has to say that the times moved - the occurrence counts beside it say
 * how much, but not that the board meant to.
 */
const COMPARED_FIELDS = [
  "title",
  "description",
  "category",
  "location",
  "signupOpen",
  "capacity",
  "firstOn",
  "startsAtMinute",
  "durationMinutes",
  "recurrenceFrequency",
  "recurrenceInterval",
  "recurrenceCount",
  "recurrenceUntil",
] as const;

const EVENT_COLUMNS = {
  id: true,
  title: true,
  description: true,
  category: true,
  location: true,
  visibility: true,
  published: true,
  publishedAt: true,
  signupOpen: true,
  capacity: true,
  firstOn: true,
  startsAtMinute: true,
  durationMinutes: true,
  recurrenceFrequency: true,
  recurrenceInterval: true,
  recurrenceCount: true,
  recurrenceUntil: true,
} as const satisfies Prisma.EventSelect;

const OCCURRENCE_COLUMNS = {
  id: true,
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
} as const satisfies Prisma.EventOccurrenceSelect;

const WITH_OCCURRENCES = {
  ...EVENT_COLUMNS,
  occurrences: {
    select: OCCURRENCE_COLUMNS,
    orderBy: { startsAt: "asc" },
  },
} as const satisfies Prisma.EventSelect;

/**
 * The association's event calendar (evenemangskalender), as the board keeps it.
 *
 * One series is one row here and one row per date it falls on. A series with no
 * recurrence rule is a series with one date: there is no separate model for a
 * one-off, no flag saying which kind this is, and no second code path anywhere
 * below. That is deliberate - two paths would have been two sets of rules about
 * publishing, editing and calling off, and the single-event one would have been
 * the one nobody remembered to fix.
 *
 * ## What the write path guarantees
 *
 * A series is entered unpublished. Publishing is a separate act with its own
 * entry in the audit log and its own scan for personal identity numbers, on the
 * news module's precedent and for its reason: what nobody may read yet cannot
 * disclose anything, and the guardrail belongs on the act that makes it
 * readable. A published series is scanned again on every edit, because an edit
 * to something already published is itself a publication.
 *
 * Members only unless the board says otherwise. A cleaning day is arranged for
 * the people who live in the house, and putting one on the street is a
 * deliberate second answer rather than the default a slip lands on.
 *
 * ## Editing does not move what people are standing on
 *
 * An edit is planned before it is applied: `planOccurrences` says which dates
 * stay, which move, which go and which arrive, and the ones that would move or
 * go are checked for sign-ups. If anybody has signed up to one of them the whole
 * edit is refused, with the dates named - the same shape as the booking module
 * refusing to reshape a resource somebody holds a booking of, and for the same
 * reason: whether those dates should change is a decision the board takes date
 * by date rather than the silent effect of saving a form.
 *
 * Occurrences that have already started are never touched at all. They are the
 * record of what was arranged, and rewriting the recurrence does not make last
 * spring untrue.
 *
 * One date can be called off on its own, which is why the dates are rows. The
 * rest of the series is untouched, and the row stays with a date on it rather
 * than being deleted: "the cleaning day on the 18th was called off" is a
 * different thing to say than "there was never one".
 *
 * ## What the audit entries carry
 *
 * The visibility, the counts, the field names that changed, and the frequency.
 * Never the title, the description, the category or the location: those are free
 * text belonging to a row with a lifecycle, and a copy in the append-only log
 * would outlive the row by design.
 */
@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Every series, drafts included, most recently arranged first.
   *
   * The board's own screen. Ordered by the series' first date rather than by
   * what is coming next, because a series is one thing on this screen and the
   * dates it holds travel with it - the next one is somewhere in the list a
   * screen already has.
   */
  async list(): Promise<EventView[]> {
    const rows = await this.prisma.event.findMany({
      orderBy: [{ firstOn: "desc" }, { title: "asc" }],
      select: WITH_OCCURRENCES,
    });
    return rows.map(toView);
  }

  async byId(id: string): Promise<EventView> {
    return toView(await this.require(id));
  }

  /**
   * Enters a series and writes out the dates it falls on.
   *
   * Unpublished, always, for the reason the news module gives: it is written
   * before it is meant to be read, and publishing is a separate act with its own
   * record - which is also why creating one runs no scan. Nothing it holds is
   * readable by anyone yet.
   */
  async create(input: EventInput, actorPersonId: string): Promise<EventView> {
    const schedule = this.validated(input);
    const periods = occurrencePeriods(schedule);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          ...columnsOf(input),
          published: false,
          authorPersonId: actorPersonId,
        },
        select: { id: true },
      });

      await tx.eventOccurrence.createMany({
        data: periods.map((period) => ({
          eventId: created.id,
          startsAt: period.startsAt,
          endsAt: period.endsAt,
        })),
      });

      await this.audit.record(
        {
          action: "EVENT_SERIES_CREATED",
          actorPersonId,
          targetKind: EVENT_TARGET_KIND,
          targetId: created.id,
          // The shape of the series and how much of the calendar it takes up.
          // Not what it is called: see the class comment.
          context: {
            frequency: input.recurrence?.frequency ?? null,
            interval: input.recurrence?.interval ?? null,
            occurrences: periods.length,
            firstOn: formatLocalDay(input.firstOn),
            signupOpen: input.signupOpen,
          },
        },
        tx,
      );

      return this.readInTransaction(tx, created.id);
    });

    this.logger.log(
      `Entered event series ${row.id} with ${String(periods.length)} occurrences`,
    );
    return toView(row);
  }

  /**
   * Rewrites what a series says and when it runs.
   *
   * Not whether it is published and not who it is for: publishing is its own
   * act, so correcting a spelling mistake in an announced cleaning day cannot
   * change who may read it.
   *
   * The occurrences are reconciled rather than replaced. See the class comment
   * for what that protects and for what refuses the edit outright.
   */
  async update(
    id: string,
    input: EventInput,
    actorPersonId: string,
  ): Promise<EventView> {
    const schedule = this.validated(input);
    const planned = occurrencePeriods(schedule);
    const now = new Date();

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.event.findUnique({
        where: { id },
        select: WITH_OCCURRENCES,
      });
      if (existing === null) {
        throw new EventError("There is no such event.", "not-found");
      }
      if (existing.published) {
        this.refusePersonalIdentityNumbers(input);
      }

      const plan = planOccurrences(existing.occurrences, planned, now);
      const displaced = displacedBy(plan);

      /*
       * The refusal, taken inside the transaction that will do the writing.
       *
       * Inside rather than before it, so a sign-up taken while the board is
       * saving the form either loses the race or refuses the edit. Asked of the
       * whole displaced set at once, because the refusal is about the edit and
       * not about one date: an edit that would move six dates and drop one
       * somebody has signed up to is refused whole rather than applied in part.
       *
       * And behind the claim's own lock, taken before the count it rests on is
       * read - the ordering `event-signup-lock.ts` sets out. Being inside the
       * transaction is not enough on its own: at READ COMMITTED this read sees
       * the snapshot it began with, so without the lock a claim that committed
       * while the board was saving would neither refuse the edit nor lose to it.
       */
      const displacedIds = displaced.map((occurrence) => occurrence.id);
      await lockOccurrencesSignups(tx, displacedIds);
      const held = await occurrencesWithSignups(tx, displacedIds);
      if (held.size > 0) {
        throw new EventError(
          "People have signed up to dates this change would move or remove. Leave those dates where they are, or deal with the sign-ups first.",
          "occurrence-in-use",
          {
            dates: displaced
              .filter((occurrence) => held.has(occurrence.id))
              .map((occurrence) =>
                formatLocalDay(localDayOf(occurrence.startsAt)),
              )
              .sort(),
          },
        );
      }

      /*
       * Dropped, then moved, then added.
       *
       * The order is the constraint's. One occurrence per series and start
       * instant is a unique index, and a row moved onto an instant a row being
       * dropped still holds would trip it - so the deletes go first, and the
       * inserts last for the same reason in the other direction.
       */
      if (plan.dropped.length > 0) {
        await tx.eventOccurrence.deleteMany({
          where: {
            id: { in: plan.dropped.map((occurrence) => occurrence.id) },
          },
        });
      }
      for (const entry of plan.moved) {
        await tx.eventOccurrence.update({
          where: { id: entry.occurrence.id },
          // The id and the cancellation stay: this is the same date, at a
          // different time of day.
          data: {
            startsAt: entry.period.startsAt,
            endsAt: entry.period.endsAt,
          },
        });
      }
      if (plan.added.length > 0) {
        await tx.eventOccurrence.createMany({
          data: plan.added.map((period) => ({
            eventId: id,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
          })),
        });
      }

      const data = columnsOf(input);
      const changed = COMPARED_FIELDS.filter((field) =>
        differs(existing[field], data[field]),
      );

      await tx.event.update({ where: { id }, data });

      await this.audit.record(
        {
          action: "EVENT_SERIES_UPDATED",
          actorPersonId,
          targetKind: EVENT_TARGET_KIND,
          targetId: id,
          // Which fields moved, and what the change did to the calendar. The
          // three counts are the fact somebody reading this entry later needs:
          // an edit that moved nine dates is a different act from one that
          // corrected a spelling mistake.
          context: {
            changed: [...changed],
            frequency: input.recurrence?.frequency ?? null,
            occurrencesMoved: plan.moved.length,
            occurrencesDropped: plan.dropped.length,
            occurrencesAdded: plan.added.length,
          },
        },
        tx,
      );

      return this.readInTransaction(tx, id);
    });

    return toView(row);
  }

  /**
   * Publishes a series, or takes it down, and says who it is for.
   *
   * Publication and audience are one decision rather than two routes, exactly as
   * a news item's are: a series is announced to the people it was arranged for,
   * and saying who those are in the same act is what puts the audience into the
   * entry the audit log keeps of the publication.
   */
  async publish(
    id: string,
    input: PublishEventInput,
    actorPersonId: string,
  ): Promise<EventView> {
    const now = new Date();

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.event.findUnique({
        where: { id },
        select: WITH_OCCURRENCES,
      });
      if (existing === null) {
        throw new EventError("There is no such event.", "not-found");
      }

      const visibility = input.visibility ?? existing.visibility;
      if (input.published) {
        this.refusePersonalIdentityNumbers(existing);
      }

      /*
       * A write that changes nothing writes nothing.
       *
       * Pressing publish on a series that is already published to the same
       * people is not an event and does not belong in the audit log.
       */
      if (
        existing.published === input.published &&
        existing.visibility === visibility
      ) {
        return existing;
      }

      await tx.event.update({
        where: { id },
        data: {
          published: input.published,
          visibility,
          // Kept once set. It is when the series was first announced, and a
          // correction afterwards does not make it newer.
          publishedAt:
            input.published && existing.publishedAt === null
              ? now
              : existing.publishedAt,
        },
      });

      await this.audit.record(
        {
          action: "EVENT_SERIES_PUBLISHED",
          actorPersonId,
          targetKind: EVENT_TARGET_KIND,
          targetId: id,
          context: {
            published: input.published,
            visibility,
            occurrences: existing.occurrences.length,
          },
        },
        tx,
      );

      return this.readInTransaction(tx, id);
    });

    return toView(row);
  }

  /**
   * Calls off one date, leaving the rest of the series standing.
   *
   * The whole reason the dates are rows. A cleaning day rained off in April does
   * not cancel the one in October, and the board should not have to rewrite the
   * recurrence to say so.
   *
   * The row stays with a date on it. It was announced, people may have signed up
   * to it, and a deleted row would say there had never been one.
   */
  async cancelOccurrence(
    occurrenceId: string,
    actorPersonId: string,
  ): Promise<EventView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const occurrence = await tx.eventOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { id: true, eventId: true, startsAt: true, cancelledAt: true },
      });
      if (occurrence === null) {
        throw new EventError(
          "There is no such date in any event.",
          "occurrence-not-found",
        );
      }
      if (occurrence.cancelledAt !== null) {
        throw new EventError(
          "That date has already been called off.",
          "occurrence-already-cancelled",
        );
      }

      await tx.eventOccurrence.update({
        where: { id: occurrenceId },
        data: { cancelledAt: new Date() },
      });

      await this.audit.record(
        {
          action: "EVENT_OCCURRENCE_CANCELLED",
          actorPersonId,
          targetKind: OCCURRENCE_TARGET_KIND,
          targetId: occurrenceId,
          // The series it belonged to and the date it was, so the entry says
          // which date was called off without carrying what the series is
          // called.
          context: {
            eventId: occurrence.eventId,
            on: formatLocalDay(localDayOf(occurrence.startsAt)),
          },
        },
        tx,
      );

      return this.readInTransaction(tx, occurrence.eventId);
    });

    this.logger.log(`Called off event occurrence ${occurrenceId}`);
    return toView(row);
  }

  /**
   * Removes a series and every date in it.
   *
   * Refused while anybody has signed up to one of those dates, by the same rule
   * that refuses moving one: the sign-ups are people expecting to be somewhere,
   * and a series removed under them would take that away without telling
   * anybody. Every date, and not only the ones still to come - removing a series
   * removes the record of what was arranged, which is a decision about the
   * whole of it.
   *
   * Taking a published series down is recorded as a publication change, on the
   * news module's precedent: something people could read stopped being readable,
   * and that is the act. A draft nobody could read leaves no entry.
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.event.findUnique({
        where: { id },
        select: WITH_OCCURRENCES,
      });
      if (existing === null) {
        throw new EventError("There is no such event.", "not-found");
      }

      // Every date of the series, behind the claim's own lock and before the
      // count is read, for the reason the edit path gives: the delete cascades
      // to the sign-ups, so a claim that committed after an unlocked read would
      // be erased by the removal it should have refused.
      const occurrenceIds = existing.occurrences.map(
        (occurrence) => occurrence.id,
      );
      await lockOccurrencesSignups(tx, occurrenceIds);
      const held = await occurrencesWithSignups(tx, occurrenceIds);
      if (held.size > 0) {
        throw new EventError(
          "People have signed up to dates in this event. Deal with the sign-ups before removing it.",
          "occurrence-in-use",
          {
            dates: existing.occurrences
              .filter((occurrence) => held.has(occurrence.id))
              .map((occurrence) =>
                formatLocalDay(localDayOf(occurrence.startsAt)),
              )
              .sort(),
          },
        );
      }

      // The occurrences go with it: the relation cascades, which is what the
      // refusal above stands in front of.
      await tx.event.delete({ where: { id } });

      if (existing.published) {
        await this.audit.record(
          {
            action: "EVENT_SERIES_PUBLISHED",
            actorPersonId,
            targetKind: EVENT_TARGET_KIND,
            targetId: id,
            context: {
              published: false,
              deleted: true,
              visibility: existing.visibility,
              occurrences: existing.occurrences.length,
            },
          },
          tx,
        );
      }
    });

    this.logger.log(`Removed event series ${id}`);
  }

  /**
   * The stated series as a schedule, or a refusal.
   *
   * Both rules live here rather than in the endpoint's schema, because both are
   * about fields agreeing with each other rather than about one field being well
   * formed, and because the schema bounds what a request may carry while this
   * bounds what the table may hold.
   */
  private validated(input: EventInput): SeriesSchedule {
    if (
      input.capacity !== null &&
      (!Number.isInteger(input.capacity) || input.capacity < 1)
    ) {
      // Zero is refused rather than read as "nobody may come". A series nobody
      // may sign up to is one with sign-up closed; a capacity of zero would be
      // sign-up offered and impossible, which no screen could explain.
      throw new EventError(
        "A capacity has to be at least one place. Leave it empty for no limit.",
        "capacity-not-positive",
      );
    }

    const schedule: SeriesSchedule = {
      firstOn: input.firstOn,
      startsAtMinute: input.startsAtMinute,
      durationMinutes: input.durationMinutes,
      recurrence: input.recurrence,
    };

    const problem = checkRecurrenceSchedule(schedule);
    if (problem !== null) {
      throw new EventError(scheduleMessage(problem), problem);
    }

    return schedule;
  }

  /**
   * Refuses a series carrying a Swedish personal identity number.
   *
   * The same rule a page and a news item live under, and for the same reason: a
   * personnummer on something the association publishes is a disclosure it
   * cannot take back, and it usually arrives pasted along with the text around
   * it rather than because somebody decided to publish it.
   *
   * The refusal names the field and the offset and never the value - the thing
   * the scan caught is precisely the thing that must not travel back.
   */
  private refusePersonalIdentityNumbers(
    fields: Record<EventTextLocation["field"], string | null>,
  ): void {
    const locations: EventTextLocation[] = [];

    for (const field of SCANNED_FIELDS) {
      const text = fields[field];
      if (text === null) {
        continue;
      }
      for (const hit of scanForPersonalIdentityNumbers(text)) {
        locations.push({ field, offset: hit.index });
      }
    }

    if (locations.length > 0) {
      throw new EventError(
        "The event carries a personal identity number and cannot be published.",
        "personal-identity-number",
        { locations },
      );
    }
  }

  private async require(id: string) {
    const row = await this.prisma.event.findUnique({
      where: { id },
      select: WITH_OCCURRENCES,
    });
    if (row === null) {
      throw new EventError("There is no such event.", "not-found");
    }
    return row;
  }

  /** The series as it stands after a write, read on the writing client. */
  private async readInTransaction(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.event.findUnique({
      where: { id },
      select: WITH_OCCURRENCES,
    });
    /* c8 ignore next 6 -- unreachable: read back inside the writing transaction */
    if (row === null) {
      throw new EventError("There is no such event.", "not-found");
    }
    return row;
  }
}

/** The refusal in words, for the server log and for a developer reading it. */
function scheduleMessage(problem: EventReason): string {
  switch (problem) {
    case "duration-invalid":
      return "An event runs for between one minute and a whole day.";
    case "start-does-not-exist":
      return "The clocks skip that time of day on that date, so there is no such moment.";
    case "recurrence-interval-invalid":
      return "A repeating event repeats every whole number of weeks, months or years.";
    case "recurrence-end-required":
      return "A repeating event states when it stops: a number of times, or a last date.";
    case "recurrence-end-ambiguous":
      return "State either a number of times or a last date, not both.";
    case "recurrence-end-invalid":
      return "That end is reached before the event comes round again. Remove the repetition instead.";
    default:
      return "A repeating event is written out for at most two years ahead.";
  }
}

/** Whether two values a comparison of stored and stated fields yields differ. */
function differs(before: unknown, after: unknown): boolean {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() !== after.getTime();
  }
  return before !== after;
}

/** The stated series as the columns hold it. */
function columnsOf(input: EventInput) {
  return {
    title: input.title,
    description: input.description,
    category: input.category,
    location: input.location,
    signupOpen: input.signupOpen,
    capacity: input.capacity,
    firstOn: dateColumnOf(input.firstOn),
    startsAtMinute: input.startsAtMinute,
    durationMinutes: input.durationMinutes,
    recurrenceFrequency: input.recurrence?.frequency ?? null,
    recurrenceInterval: input.recurrence?.interval ?? null,
    recurrenceCount: input.recurrence?.count ?? null,
    recurrenceUntil:
      input.recurrence?.until == null
        ? null
        : dateColumnOf(input.recurrence.until),
  } satisfies Prisma.EventUncheckedUpdateInput;
}

/** A stored series as a screen reads it. */
function toView(row: {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: Date | null;
  signupOpen: boolean;
  capacity: number | null;
  firstOn: Date;
  startsAtMinute: number;
  durationMinutes: number;
  recurrenceFrequency: EventRecurrenceFrequency | null;
  recurrenceInterval: number | null;
  recurrenceCount: number | null;
  recurrenceUntil: Date | null;
  occurrences: StoredOccurrence[];
}): EventView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    location: row.location,
    visibility: row.visibility,
    published: row.published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    signupOpen: row.signupOpen,
    capacity: row.capacity,
    firstOn: formatLocalDay(localDayOfColumn(row.firstOn)),
    startsAtMinute: row.startsAtMinute,
    durationMinutes: row.durationMinutes,
    recurrence:
      row.recurrenceFrequency === null || row.recurrenceInterval === null
        ? null
        : {
            frequency: row.recurrenceFrequency,
            interval: row.recurrenceInterval,
            count: row.recurrenceCount,
            until:
              row.recurrenceUntil === null
                ? null
                : formatLocalDay(localDayOfColumn(row.recurrenceUntil)),
          },
    occurrences: row.occurrences.map(occurrenceView),
  };
}

function occurrenceView(occurrence: StoredOccurrence): EventOccurrenceView {
  return {
    id: occurrence.id,
    startsAt: occurrence.startsAt.toISOString(),
    endsAt: occurrence.endsAt.toISOString(),
    on: formatLocalDay(localDayOf(occurrence.startsAt)),
    cancelledAt: occurrence.cancelledAt?.toISOString() ?? null,
  };
}
