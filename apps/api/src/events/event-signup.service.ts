import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { formatLocalDay, localDayOf } from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { EventError } from "./event.error";
import { lockOccurrenceSignups } from "./event-signup-lock";

/** The kind an audit entry names a sign-up by, and the purge names its rows by. */
export const SIGNUP_TARGET_KIND = "eventSignup";

/**
 * How far ahead the calendar a resident reads goes.
 *
 * Half a year, which is well inside the two years occurrences are written out
 * for. A calendar is read to decide what to do next, and a date eighteen months
 * out is a plan the board may still change; the bound also stops a house with
 * several weekly series handing one screen a thousand rows. A general meeting
 * further out than this is announced as news as well, which is how a board tells
 * people about something they have to plan around.
 */
const CALENDAR_HORIZON_DAYS = 180;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The caller's own sign-up to one date, standing or stood down. */
export interface OwnSignupView {
  signupId: string;
  /** ISO instant the sign-up that stands now was made. */
  signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  withdrawnAt: string | null;
}

/**
 * One date, as somebody deciding whether to go reads it.
 *
 * Carries a count and never a name. How many places are gone is what a person
 * choosing needs; who has taken them is personal data about other residents, and
 * it is what events:manage exists to gate - so the roll-call is a different
 * answer on a different controller.
 *
 * `own` is the whole of the caller's own state, and it comes back with every
 * answer this service gives - including the answer to a sign-up that was refused.
 * That is what lets a screen be server-authoritative rather than optimistic: the
 * count and the button are read from one payload, so they cannot disagree after a
 * race.
 */
export interface AttendableOccurrenceView {
  occurrenceId: string;
  eventId: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /**
   * "YYYY-MM-DD", the local date it falls on.
   *
   * Derived from the start instant on the association's own clock rather than
   * left to the reader's browser or to a UTC slice of the instant. A midsummer
   * party starting at half past midnight is on the 21st of June in Stockholm and
   * on the 20th in UTC, and the notice in the stairwell says the 21st.
   */
  on: string;
  /** ISO instant the board called it off, or null while it is going ahead. */
  cancelledAt: string | null;
  /** Whether the series takes sign-ups at all. */
  signupOpen: boolean;
  /** Places at this date. Null is no limit. */
  capacity: number | null;
  /** Standing sign-ups at this date, withdrawals not counted. */
  placesTaken: number;
  /** Places still free, or null when there is no limit. */
  placesLeft: number | null;
  own: OwnSignupView | null;
}

/**
 * Who signed up, as whoever manages events may be told.
 *
 * Three cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it, on the reading the issue queue applies to a reporter:
 * that register has a statutory reason to name them and a roll-call has none. The
 * place they hold is still counted, because a place that vanished would be a
 * place the board handed to somebody else.
 *
 * `unknown` is a person reference that no longer resolves. Sign-ups are service
 * tier and a person can be purged out from under one, so the roll-call has to be
 * able to say "we no longer know" rather than break.
 */
export type EventAttendeeView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface RollCallEntryView {
  signupId: string;
  attendee: EventAttendeeView;
  signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  withdrawnAt: string | null;
}

/** One date and everybody who has put their name down for it. */
export interface RollCallView {
  occurrenceId: string;
  eventId: string;
  title: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** "YYYY-MM-DD" on the association's own clock. */
  on: string;
  cancelledAt: string | null;
  capacity: number | null;
  /** Standing sign-ups, which is what the capacity is measured against. */
  placesTaken: number;
  /** Everybody with a row for this date, the ones who stood down included. */
  entries: RollCallEntryView[];
}

const OCCURRENCE_SELECT = {
  id: true,
  eventId: true,
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
  event: {
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      location: true,
      published: true,
      signupOpen: true,
      capacity: true,
    },
  },
} as const satisfies Prisma.EventOccurrenceSelect;

type OccurrenceRecord = Prisma.EventOccurrenceGetPayload<{
  select: typeof OCCURRENCE_SELECT;
}>;

/**
 * Signing up to a date, standing down again, and who is coming.
 *
 * ## The place is claimed under a lock, and the claim is conditional
 *
 * Two invariants, and they are held by two different mechanisms because they are
 * two different shapes of statement - which is exactly how the booking module
 * splits its own pair.
 *
 * One sign-up per person and date is a statement about a single row, so a unique
 * index holds it: the claim is an insert with `ON CONFLICT DO NOTHING` and a
 * second row for the same person matches nothing rather than raising something to
 * be inspected, the way a double booking is refused by the partial unique index
 * over a resource and a start time.
 *
 * The capacity is a statement about a set of rows measured against a number
 * stored on another table, which no index can express. So it is a lock keyed on
 * the occurrence, taken before anything the decision rests on is read - see
 * `event-signup-lock.ts` for why nothing weaker works, including a single
 * statement carrying the count in its own WHERE clause. Everything after the lock
 * runs with a competing claim either finished or not yet started, which is what
 * makes the count decisive rather than a guess that was true when it was taken.
 *
 * Both the count and the insert are inside the transaction that writes the audit
 * entry, so a refusal rolls the whole of it back. There is no state in which the
 * log says somebody signed up and no sign-up exists, or the reverse.
 *
 * ## Standing down is a dated close
 *
 * Withdrawing writes a date on the row and never deletes it, and the write is a
 * conditional update: two people standing down from the same sign-up in the same
 * instant produce one withdrawal and one refusal, the shape a booking
 * cancellation already has. The place is free the moment the date is written,
 * because the places taken are the rows with no withdrawal date - so a place given
 * back is takeable again without anything having to be recomputed.
 *
 * Signing up again after standing down clears that date on the same row rather
 * than writing a second one, which is what the unique constraint requires and
 * what keeps one person one line on the roll-call. It is a claim like any other:
 * somebody who stood down and changed their mind takes a place at the back of the
 * queue rather than keeping one in reserve.
 *
 * Standing down is not refused once the date has begun. It is a fact about the
 * person's intention with a date on it, and the board reading a roll-call can see
 * that a withdrawal was recorded after the morning it was for; refusing it would
 * only strand somebody who forgot to say so in time.
 *
 * ## Who is coming is a different answer
 *
 * The occurrence list a resident reads carries counts and no names. The roll-call
 * carries names and is behind events:manage, and a person with protected personal
 * data is named on it to nobody at all - their place is counted and their name is
 * not, on the reading the issue queue applies to a reporter.
 *
 * ## What the audit entries carry
 *
 * The identifiers, the date, and the state of the places. Never the title of the
 * series, the description or the location: those are free text on a row with a
 * lifecycle, and a copy in the append-only log would outlive the row by design.
 */
@Injectable()
export class EventSignupService {
  private readonly logger = new Logger(EventSignupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The dates still to come, with the caller's own place on each.
   *
   * Every published series, whether or not it takes sign-ups: this is the
   * calendar somebody living here reads, and a cleaning day that is signed up for
   * and a notice that the water is off belong on the same list. `signupOpen` says
   * which is which.
   *
   * Drafts are absent, and that is the whole of the visibility rule here. A
   * series published to the members and one published to the street are both
   * readable by anybody who is signed in - which everybody holding events:attend
   * is - so the audience decides what reaches the website and not what reaches
   * this list.
   *
   * A date that has begun but not ended stays on the list. It is today's event,
   * and a resident looking at it while it runs is entitled to see it rather than
   * to find it gone; what refuses a sign-up to it is the claim, not the read.
   */
  async upcoming(
    personId: string,
    now: Date = new Date(),
  ): Promise<AttendableOccurrenceView[]> {
    const horizon = new Date(
      now.getTime() + CALENDAR_HORIZON_DAYS * MILLISECONDS_PER_DAY,
    );

    const occurrences = await this.prisma.eventOccurrence.findMany({
      where: {
        event: { published: true },
        endsAt: { gte: now },
        startsAt: { lte: horizon },
      },
      // The id breaks a tie, so two dates at the same instant come back in one
      // order rather than in whichever the database happened to produce.
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: OCCURRENCE_SELECT,
    });
    if (occurrences.length === 0) {
      return [];
    }

    const ids = occurrences.map((occurrence) => occurrence.id);
    const taken = await this.placesTakenAcross(this.prisma, ids);
    const own = await this.prisma.eventSignup.findMany({
      where: { occurrenceId: { in: ids }, personId },
      select: {
        id: true,
        occurrenceId: true,
        signedUpAt: true,
        withdrawnAt: true,
      },
    });
    const ownByOccurrence = new Map(
      own.map((row) => [row.occurrenceId, row] as const),
    );

    return occurrences.map((occurrence) =>
      attendableView(
        occurrence,
        taken.get(occurrence.id) ?? 0,
        ownByOccurrence.get(occurrence.id) ?? null,
      ),
    );
  }

  /**
   * Takes a place at one date for the caller.
   *
   * Answers with the date as it stands afterwards, read inside the same
   * transaction: the count, the places left and the caller's own row in one
   * payload, so a screen never has to work out what its own request did.
   */
  async signUp(
    personId: string,
    occurrenceId: string,
    now: Date = new Date(),
  ): Promise<AttendableOccurrenceView> {
    const view = await this.prisma.$transaction(async (tx) => {
      /*
       * The lock first, before anything the decision rests on is read.
       *
       * The capacity the board has set, the places already taken and the
       * caller's own row are all read after it, so a claim that was in flight
       * when this one started has either committed - and is counted - or has not
       * begun. Reading first and locking afterwards would leave the count
       * describing a moment that had passed, which is the whole failure the lock
       * exists to remove.
       *
       * The key is the occurrence, so claims on different dates never wait for
       * each other. It is hashed from the identifier as it arrived rather than
       * from one this transaction has validated, which costs nothing: the lock is
       * released by the commit or the rollback a few statements below, and an
       * identifier naming nothing is refused by the read that follows.
       */
      await lockOccurrenceSignups(tx, occurrenceId);

      const occurrence = await this.requireAttendable(tx, occurrenceId);
      if (!occurrence.event.signupOpen) {
        throw new EventError(
          "That event does not take sign-ups.",
          "signup-not-offered",
        );
      }
      if (occurrence.cancelledAt !== null) {
        throw new EventError(
          "That date has been called off.",
          "occurrence-cancelled",
        );
      }
      if (occurrence.startsAt.getTime() <= now.getTime()) {
        // A date that has begun is not one to put a name down for, however free
        // it is. Signing up for the hour somebody is standing in would be a
        // claim on time that has gone, which is the same rule a booking lives
        // under.
        throw new EventError(
          "That date has already begun.",
          "occurrence-started",
        );
      }

      const standing = await tx.eventSignup.findUnique({
        where: { occurrenceId_personId: { occurrenceId, personId } },
        select: { id: true, withdrawnAt: true },
      });
      if (standing !== null && standing.withdrawnAt === null) {
        throw new EventError(
          "You have already signed up for that date.",
          "already-signed-up",
        );
      }

      const taken = await tx.eventSignup.count({
        where: { occurrenceId, withdrawnAt: null },
      });
      const capacity = occurrence.event.capacity;
      if (capacity !== null && taken >= capacity) {
        throw new EventError(
          "The places at that date are taken.",
          "occurrence-full",
        );
      }

      const signupId =
        standing === null
          ? await this.insertClaim(tx, occurrenceId, personId, now)
          : await this.reopenClaim(tx, standing.id, now);

      await this.audit.record(
        {
          action: "EVENT_SIGNUP_MADE",
          actorPersonId: personId,
          // Both the actor and the subject: nobody signs up on anybody else's
          // behalf, and the entry belongs in this person's own access report.
          targetPersonId: personId,
          targetKind: SIGNUP_TARGET_KIND,
          targetId: signupId,
          /*
           * The identifiers, the date and the state of the places - what makes
           * the entry answerable later, including whether a place was one of a
           * limited number. Never the title of the series or where it is: those
           * are free text on a row with a lifecycle, and this log outlives it.
           */
          context: {
            eventId: occurrence.eventId,
            occurrenceId,
            on: formatLocalDay(localDayOf(occurrence.startsAt)),
            placesTaken: taken + 1,
            capacity,
            // Whether they had stood down before. The row is the same one, so
            // without this the log would show two sign-ups and no withdrawal
            // between them.
            signedUpAgain: standing !== null,
          },
        },
        tx,
      );

      return this.readAttendable(tx, occurrence, personId);
    });

    // The identifiers and nothing else. Which resident is going to which
    // cleaning day is the thing the roll-call capability gates, and a log line is
    // not behind it.
    this.logger.log(
      `Recorded a sign-up to event occurrence ${occurrenceId} in series ${view.eventId}`,
    );
    return view;
  }

  /**
   * Stands the caller down from one date.
   *
   * Keyed on the date rather than on the sign-up's own identifier, because that
   * is what the person has: they are standing down from the cleaning day on the
   * 18th, and a screen that had to keep hold of a row identifier to offer it
   * would have one more thing to get wrong after a race. The board's own
   * withdrawal is keyed on the sign-up, which is what its roll-call gives it.
   */
  async withdrawOwn(
    personId: string,
    occurrenceId: string,
    now: Date = new Date(),
  ): Promise<AttendableOccurrenceView> {
    const view = await this.prisma.$transaction(async (tx) => {
      const occurrence = await this.requireAttendable(tx, occurrenceId);

      /*
       * The conditional update first, and a read only afterwards to word the
       * refusal.
       *
       * A read taken first would be the stale thing: the board may be
       * withdrawing the same sign-up in the same instant. This way one of the two
       * writes matches the row and the other matches nothing, and the read that
       * follows a failure is asked about a fact that has settled.
       */
      const { count } = await tx.eventSignup.updateMany({
        where: { occurrenceId, personId, withdrawnAt: null },
        data: { withdrawnAt: now },
      });
      if (count === 0) {
        await this.refuseMissingSignup(tx, { occurrenceId, personId });
      }

      const signup = await tx.eventSignup.findUniqueOrThrow({
        where: { occurrenceId_personId: { occurrenceId, personId } },
        select: { id: true },
      });

      await this.recordWithdrawal(tx, {
        signupId: signup.id,
        subjectPersonId: personId,
        actorPersonId: personId,
        occurrence,
      });

      return this.readAttendable(tx, occurrence, personId);
    });

    this.logger.log(
      `Withdrew a sign-up to event occurrence ${occurrenceId} in series ${view.eventId}`,
    );
    return view;
  }

  /**
   * Everybody who has put their name down for one date.
   *
   * Drafts included: whoever manages events is the audience the drafts belong to,
   * and a series is entered before it is published rather than after. A person
   * with protected personal data is counted and not named - see
   * {@link EventAttendeeView}.
   *
   * The ones who stood down are on it too, with the date they did. A roll-call
   * that silently omitted them would leave the board unable to tell somebody who
   * never signed up from somebody who changed their mind, which is the answer the
   * dated close exists to keep.
   */
  async rollCall(occurrenceId: string): Promise<RollCallView> {
    const occurrence = await this.prisma.eventOccurrence.findUnique({
      where: { id: occurrenceId },
      select: OCCURRENCE_SELECT,
    });
    if (occurrence === null) {
      throw new EventError(
        "There is no such date in any event.",
        "occurrence-not-found",
      );
    }

    const signups = await this.prisma.eventSignup.findMany({
      where: { occurrenceId },
      // Who put their name down first, which is the order the places went in.
      // The id breaks a tie so the list is one ordering rather than either of
      // two.
      orderBy: [{ signedUpAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        personId: true,
        signedUpAt: true,
        withdrawnAt: true,
      },
    });

    /*
     * The people, read separately because `personId` is a plain column and not a
     * relation - the same trade every table naming a person makes here, and the
     * reason a purge can reach this one at all.
     */
    const personIds = [...new Set(signups.map((signup) => signup.personId))];
    const persons =
      personIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: personIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return {
      occurrenceId: occurrence.id,
      eventId: occurrence.eventId,
      title: occurrence.event.title,
      startsAt: occurrence.startsAt.toISOString(),
      endsAt: occurrence.endsAt.toISOString(),
      on: formatLocalDay(localDayOf(occurrence.startsAt)),
      cancelledAt: occurrence.cancelledAt?.toISOString() ?? null,
      capacity: occurrence.event.capacity,
      placesTaken: signups.filter((signup) => signup.withdrawnAt === null)
        .length,
      entries: signups.map((signup) => ({
        signupId: signup.id,
        attendee: attendeeOf(signup.personId, byId),
        signedUpAt: signup.signedUpAt.toISOString(),
        withdrawnAt: signup.withdrawnAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Stands somebody down on their behalf.
   *
   * What makes the series-change refusal actionable. An edit that would move a
   * date people are standing on is refused and names the dates; the board's
   * answer is to leave those dates alone or to deal with the sign-ups, and this
   * is dealing with them - one recorded act per person rather than the silent
   * effect of saving a form.
   *
   * The entry names the person whose sign-up it was as the subject whoever
   * withdrew it, exactly as a booking cancelled by the board does, so their own
   * access report shows a withdrawal somebody else decided on.
   */
  async withdrawFor(
    signupId: string,
    actorPersonId: string,
    now: Date = new Date(),
  ): Promise<RollCallView> {
    const occurrenceId = await this.prisma.$transaction(async (tx) => {
      const signup = await tx.eventSignup.findUnique({
        where: { id: signupId },
        select: { id: true, personId: true, occurrenceId: true },
      });
      if (signup === null) {
        throw new EventError("There is no such sign-up.", "signup-not-found");
      }

      const { count } = await tx.eventSignup.updateMany({
        where: { id: signupId, withdrawnAt: null },
        data: { withdrawnAt: now },
      });
      if (count === 0) {
        throw new EventError(
          "That sign-up has already been withdrawn.",
          "already-withdrawn",
        );
      }

      const occurrence = await tx.eventOccurrence.findUniqueOrThrow({
        where: { id: signup.occurrenceId },
        select: OCCURRENCE_SELECT,
      });

      await this.recordWithdrawal(tx, {
        signupId,
        subjectPersonId: signup.personId,
        actorPersonId,
        occurrence,
      });

      return signup.occurrenceId;
    });

    this.logger.log(
      `Withdrew sign-up ${signupId} on behalf of the person who made it`,
    );
    return this.rollCall(occurrenceId);
  }

  /**
   * The occurrence, when it exists and belongs to a series the caller may read.
   *
   * A date of an unpublished series is answered exactly as one that does not
   * exist. The alternative would let anybody holding events:attend discover what
   * the board is drafting, one identifier at a time, from the difference between
   * "no such date" and "that date is not taking sign-ups" - which is the reading
   * the issues module applies to a type the caller may not report under and the
   * media layer to a file it will not serve.
   */
  private async requireAttendable(
    tx: Prisma.TransactionClient,
    occurrenceId: string,
  ): Promise<OccurrenceRecord> {
    const occurrence = await tx.eventOccurrence.findUnique({
      where: { id: occurrenceId },
      select: OCCURRENCE_SELECT,
    });
    if (occurrence === null || !occurrence.event.published) {
      throw new EventError(
        "There is no such date in any event.",
        "occurrence-not-found",
      );
    }
    return occurrence;
  }

  /**
   * The claim, for somebody with no row for this date yet.
   *
   * `skipDuplicates` is `ON CONFLICT DO NOTHING`, so a second row for the same
   * person and date matches nothing rather than raising something to be
   * inspected - the shape the booking claim has, and for its reason: the row
   * already exists and belongs to this person, which is a fact and not an error.
   * Under the lock this cannot happen, because the read above would have found
   * it; it is written this way so that the invariant is held by the index rather
   * than by the read having been taken.
   */
  private async insertClaim(
    tx: Prisma.TransactionClient,
    occurrenceId: string,
    personId: string,
    now: Date,
  ): Promise<string> {
    const { count } = await tx.eventSignup.createMany({
      data: [{ occurrenceId, personId, signedUpAt: now }],
      skipDuplicates: true,
    });
    /* c8 ignore next 6 -- unreachable: the read above holds the same lock */
    if (count === 0) {
      throw new EventError(
        "You have already signed up for that date.",
        "already-signed-up",
      );
    }

    // Read back by what the index makes unique rather than by an identifier the
    // insert returned, because a bulk insert does not return one. Inside this
    // transaction the pair names exactly the row just written.
    const created = await tx.eventSignup.findUniqueOrThrow({
      where: { occurrenceId_personId: { occurrenceId, personId } },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * The claim, for somebody who stood down and has changed their mind.
   *
   * A conditional update rather than a plain one: the row is only reopened while
   * it is closed, so a second request in the same instant reopens nothing and is
   * refused with the answer a read would have given.
   */
  private async reopenClaim(
    tx: Prisma.TransactionClient,
    signupId: string,
    now: Date,
  ): Promise<string> {
    const { count } = await tx.eventSignup.updateMany({
      where: { id: signupId, withdrawnAt: { not: null } },
      data: { withdrawnAt: null, signedUpAt: now },
    });
    /* c8 ignore next 6 -- unreachable: the read above holds the same lock */
    if (count === 0) {
      throw new EventError(
        "You have already signed up for that date.",
        "already-signed-up",
      );
    }
    return signupId;
  }

  /** The entry a withdrawal writes, whoever asked for it. */
  private async recordWithdrawal(
    tx: Prisma.TransactionClient,
    withdrawal: {
      signupId: string;
      subjectPersonId: string;
      actorPersonId: string;
      occurrence: OccurrenceRecord;
    },
  ): Promise<void> {
    const taken = await tx.eventSignup.count({
      where: { occurrenceId: withdrawal.occurrence.id, withdrawnAt: null },
    });

    await this.audit.record(
      {
        action: "EVENT_SIGNUP_WITHDRAWN",
        actorPersonId: withdrawal.actorPersonId,
        // The person whose sign-up it was, whoever withdrew it. That is what
        // puts the entry in their access report as something about them.
        targetPersonId: withdrawal.subjectPersonId,
        targetKind: SIGNUP_TARGET_KIND,
        targetId: withdrawal.signupId,
        context: {
          eventId: withdrawal.occurrence.eventId,
          occurrenceId: withdrawal.occurrence.id,
          on: formatLocalDay(localDayOf(withdrawal.occurrence.startsAt)),
          placesTaken: taken,
          capacity: withdrawal.occurrence.event.capacity,
        },
      },
      tx,
    );
  }

  /**
   * Refuses a withdrawal that matched nothing, saying which of the two it was.
   *
   * Two facts and two answers: there is no such sign-up, or there is one and it
   * is already closed. A single code would leave a screen unable to tell somebody
   * who never signed up from somebody who has already stood down, and the second
   * of those is the one that happens when a request is sent twice.
   */
  private async refuseMissingSignup(
    tx: Prisma.TransactionClient,
    key: { occurrenceId: string; personId: string },
  ): Promise<never> {
    const existing = await tx.eventSignup.findUnique({
      where: {
        occurrenceId_personId: {
          occurrenceId: key.occurrenceId,
          personId: key.personId,
        },
      },
      select: { id: true },
    });
    if (existing === null) {
      throw new EventError(
        "You have no sign-up for that date.",
        "signup-not-found",
      );
    }
    throw new EventError(
      "That sign-up has already been withdrawn.",
      "already-withdrawn",
    );
  }

  /** One date as it stands, read on the client that wrote it. */
  private async readAttendable(
    tx: Prisma.TransactionClient,
    occurrence: OccurrenceRecord,
    personId: string,
  ): Promise<AttendableOccurrenceView> {
    const taken = await tx.eventSignup.count({
      where: { occurrenceId: occurrence.id, withdrawnAt: null },
    });
    const own = await tx.eventSignup.findUnique({
      where: {
        occurrenceId_personId: { occurrenceId: occurrence.id, personId },
      },
      select: {
        id: true,
        signedUpAt: true,
        withdrawnAt: true,
      },
    });
    return attendableView(occurrence, taken, own);
  }

  /** The standing sign-ups per occurrence, for the ids that have any. */
  private async placesTakenAcross(
    db: PrismaService,
    occurrenceIds: readonly string[],
  ): Promise<Map<string, number>> {
    const groups = await db.eventSignup.groupBy({
      by: ["occurrenceId"],
      where: { occurrenceId: { in: [...occurrenceIds] }, withdrawnAt: null },
      _count: { _all: true },
    });
    return new Map(
      groups.map((group) => [group.occurrenceId, group._count._all] as const),
    );
  }
}

/** Places still free, or null when the board set no limit. */
export function placesLeftOf(
  capacity: number | null,
  placesTaken: number,
): number | null {
  if (capacity === null) {
    return null;
  }
  // Floored at nothing rather than allowed to go negative. A board that lowered
  // the capacity below what is already taken has fewer places than sign-ups, and
  // "minus three places left" is not something a screen can say.
  return Math.max(0, capacity - placesTaken);
}

function attendableView(
  occurrence: OccurrenceRecord,
  placesTaken: number,
  own: {
    id: string;
    signedUpAt: Date;
    withdrawnAt: Date | null;
  } | null,
): AttendableOccurrenceView {
  return {
    occurrenceId: occurrence.id,
    eventId: occurrence.eventId,
    title: occurrence.event.title,
    description: occurrence.event.description,
    category: occurrence.event.category,
    location: occurrence.event.location,
    startsAt: occurrence.startsAt.toISOString(),
    endsAt: occurrence.endsAt.toISOString(),
    on: formatLocalDay(localDayOf(occurrence.startsAt)),
    cancelledAt: occurrence.cancelledAt?.toISOString() ?? null,
    signupOpen: occurrence.event.signupOpen,
    capacity: occurrence.event.capacity,
    placesTaken,
    placesLeft: placesLeftOf(occurrence.event.capacity, placesTaken),
    own:
      own === null
        ? null
        : {
            signupId: own.id,
            signedUpAt: own.signedUpAt.toISOString(),
            withdrawnAt: own.withdrawnAt?.toISOString() ?? null,
          },
  };
}

/**
 * One person as the roll-call may name them.
 *
 * Exported so the view can be built and asserted without a database, which is
 * where the protected-data rule is worth stating: a person the register masks is
 * named to nobody here, and the two other cases are the ones a service-tier table
 * naming a person has to be able to answer at all.
 */
export function attendeeOf(
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
): EventAttendeeView {
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
