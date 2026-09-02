import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import {
  dateColumnOf,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  isCurrentMembership,
  membershipPeriods,
  resolveRegisterEvents,
} from "../registers/membership-periods";
import { NOTICE_DELIVERY_FAILURES } from "./meeting-notice-delivery";
import { MeetingNoticeMailerService } from "./meeting-notice-mailer.service";
import { MeetingError } from "./meeting.error";

/** How the sending of one notice is going, as the board's screen reports it. */
export interface NoticeDeliveryReport {
  /** Claimed when the notice was issued and not yet handed to a mail server. */
  pending: number;
  sent: number;
  failed: number;
  /**
   * That at least one copy failed because this instance has no mail server. The
   * notice is issued either way, and that distinction is the whole of what the
   * screen has to say about it.
   */
  mailNotConfigured: boolean;
  /**
   * The members the notice did not reach, by identifier and never by name.
   *
   * On the report because a notice is a summons rather than an announcement.
   * EFL 6 kap. 21 § has the members called, so a member this platform could not
   * reach is one the board still has to call - and a report that gave only a
   * count would leave it unable to say which of them.
   */
  unreachedPersonIds: string[];
}

/** The notice on one meeting, as the board reads it back. */
export interface MeetingNoticeView {
  id: string;
  /** ISO instant. */
  startsAt: string;
  place: string;
  digitalParticipation: string | null;
  /** ISO instant. */
  issuedAt: string;
  issuedByPersonId: string;
  deliveries: NoticeDeliveryReport;
}

export interface IssueNoticeInput {
  /** "HH:MM" on the meeting's own day, on the association's clock. */
  startsAt: string;
  place: string;
  digitalParticipation: string | null;
}

/** The columns a notice read selects. */
const NOTICE_COLUMNS = {
  id: true,
  startsAt: true,
  place: true,
  digitalParticipation: true,
  issuedAt: true,
  issuedByPersonId: true,
} as const;

/**
 * The columns the recipient snapshot reads out of the member register archive.
 *
 * `resolveRegisterEvents` takes the whole row shape, so every column it names is
 * selected. Nothing here prints the recorded name or address: they are read
 * because the correction chain is followed through the rows themselves.
 */
const REGISTER_COLUMNS = {
  id: true,
  personId: true,
  apartmentId: true,
  eventType: true,
  eventOn: true,
  recordedFirstName: true,
  recordedLastName: true,
  recordedPostalStreet: true,
  recordedPostalCode: true,
  recordedPostalCity: true,
  correctsEntryId: true,
  createdAt: true,
} as const;

/**
 * The notice (kallelse) that summons a general meeting, and the ledger of whom
 * it was sent to.
 *
 * ## What makes this a notice
 *
 * EFL 6 kap. 22 §, which states what a notice must contain: the time and the
 * place; where the meeting is to be held digitally, how the members are to take
 * part and to vote; and the matters to be dealt with, clearly stated. The first
 * two are written on the notice row. The third is the meeting's agenda, which
 * this service does not copy - it freezes it, so that what the notice stated
 * and what the meeting may deal with are one list rather than two.
 *
 * That freeze is the load-bearing part. EFL 6 kap. 15 § gives a member the right
 * to have an item taken up *in the notice*, and 6 kap. 25 § leaves the meeting
 * unable to decide a matter the notice did not take up without the consent of
 * every member the failure affects. So issuing the notice is what settles which
 * items the meeting deals with, and after it the agenda is a record rather than
 * a plan: `MeetingService.setAgenda` refuses, and so does linking a motion to
 * the meeting.
 *
 * Three refusals follow from the same paragraph. A meeting with no agenda cannot
 * be summoned, because a notice stating no matters is not a notice. A meeting
 * recorded as held cannot be summoned, because the summons comes first. And a
 * meeting already summoned is not summoned twice: 6 kap. 25 § gives the remedy
 * for a notice that went wrong, and it is that the meeting may resolve to
 * convene an extra general meeting - a meeting of its own, with a notice of its
 * own - rather than that a second notice repairs the first.
 *
 * ## Electronic means
 *
 * Lawful for a housing cooperative: BRL 1 kap. 10 § applies the rules on
 * information by electronic means in EFL 1 kap. 16 § to a bostadsrattsforening
 * sending kallelser. That paragraph attaches three conditions - the general
 * meeting has resolved on it, the association has reliable routines for
 * identifying the recipient and reliable information on how to reach them, and
 * the recipient has consented, which the second paragraph presumes where a
 * request sent by post went unanswered for at least two weeks - and a consent
 * may be withdrawn at any time.
 *
 * This platform decides none of the three and claims none of them. What it
 * records is that the association sent the notice, which is the same line
 * ProxyAuthorisation draws between the board seeing a signed document and the
 * platform producing one. The manner in which the members are called is the
 * bylaws' own under EFL 6 kap. 21 § forsta stycket, and the cases in which that
 * section additionally requires a letter are three facts this platform does not
 * hold.
 *
 * The time within which a notice is to be issued - EFL 6 kap. 17 § for an
 * ordinary meeting, 18 § for an extra one - is stated and never enforced, for
 * the reason the motion deadline is: both sections let the bylaws move the
 * latest date, and refusing on the statutory dates alone would refuse an
 * association acting on its own lawful clause.
 *
 * ## Who is summoned
 *
 * The members, read out of the member register (medlemsforteckning) and not out
 * of the residencies, which is this module's rule for every membership question
 * and the opposite of the news mailing's. Asked about the day the notice is
 * issued rather than about the meeting day: the board summons whoever is a
 * member when it calls the meeting, and who has a vote when the meeting sits is
 * a different question that `voting-register.ts` answers on the day.
 *
 * Every member gets a ledger row, including one the association holds no
 * address for. That is deliberately not what the news mailing does - it leaves
 * an unreachable member out of the snapshot rather than writing a failure - and
 * the difference is that a notice is a summons the association owes each member
 * rather than an announcement they can also read on the website. A member this
 * platform cannot reach has to appear on the board's screen, because calling
 * them is then the board's own job.
 *
 * Joint holders are summoned one by one, although BRL 9 kap. 14 § 1 gives them
 * one vote between them. The vote is merged in the voting register; the summons
 * is not, because the right to be called is each member's own.
 */
@Injectable()
export class MeetingNoticeService {
  private readonly logger = new Logger(MeetingNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mailer: MeetingNoticeMailerService,
  ) {}

  /**
   * Issues the notice, writes the ledger and hands the sending to the queue.
   *
   * One transaction. The notice, the ledger row for every member, the audit
   * entry and the job commit together or not at all: a notice whose ledger
   * rolled back would be a summons with no record of whom it was sent to, and a
   * job sent after the commit could fail on its own and leave a notice issued
   * with nothing coming for it.
   *
   * What is deliberately outside that transaction is the sending. A mail server
   * refusing one member's copy is written on that member's row by the worker and
   * changes nothing about the notice: the meeting has been summoned, and one
   * unreachable address is a fact for the board to act on rather than a reason
   * to un-summon everybody else.
   */
  async issue(
    meetingId: string,
    input: IssueNoticeInput,
    actorPersonId: string,
  ): Promise<MeetingNoticeView> {
    // Before the transaction opens, because creating a queue is the queue
    // backend's own work on its own connection.
    await this.mailer.ensureQueues();

    const { notice, recipients } = await this.prisma.$transaction(
      async (tx) => {
        const meeting = await tx.meeting.findUnique({
          where: { id: meetingId },
          select: {
            id: true,
            heldOn: true,
            concludedAt: true,
            notice: { select: { id: true } },
            _count: { select: { agendaItems: true } },
          },
        });
        if (meeting === null) {
          throw new MeetingError("No such meeting.", "meeting-not-found");
        }
        if (meeting.concludedAt !== null) {
          throw new MeetingError(
            "This meeting has been recorded as held.",
            "meeting-already-held",
          );
        }
        if (meeting.notice !== null) {
          throw new MeetingError(
            "This meeting has already been summoned.",
            "notice-already-issued",
          );
        }
        if (meeting._count.agendaItems === 0) {
          throw new MeetingError(
            "A notice states the matters the meeting is to deal with, and this meeting has none.",
            "meeting-has-no-agenda",
          );
        }

        const startsAt = this.readStartOfMeeting(
          input.startsAt,
          meeting.heldOn,
        );

        const created = await tx.meetingNotice.create({
          data: {
            meetingId,
            startsAt,
            place: input.place,
            digitalParticipation: input.digitalParticipation,
            issuedByPersonId: actorPersonId,
          },
          select: NOTICE_COLUMNS,
        });

        const summoned = await this.membersOn(tx, localDayOf(created.issuedAt));

        // No skipDuplicates. The unique triple is the guarantee, and a duplicate
        // reaching here would mean the notice row above had not been the only
        // one - which must abort the summons loudly rather than be dropped.
        await tx.meetingNoticeDelivery.createMany({
          data: summoned.map((personId) => ({
            noticeId: created.id,
            personId,
            channel: "EMAIL" as const,
          })),
        });

        await this.audit.record(
          {
            action: "MEETING_NOTICE_ISSUED",
            actorPersonId,
            // No subject: summoning the members is the association's own act.
            targetKind: "meeting",
            targetId: meetingId,
            // How many were summoned and by what means. Never a recipient, and
            // never the time, the place or an item: the log is append-only and
            // exempt from every purge.
            context: {
              channel: "EMAIL",
              recipients: summoned.length,
              heldOn: formatLocalDay(localDayOfColumn(meeting.heldOn)),
            },
          },
          tx,
        );

        // In this transaction, so the job row commits with the ledger it works
        // through or with neither.
        await this.mailer.enqueueInTransaction(tx, created.id);

        return { notice: created, recipients: summoned.length };
      },
    );

    // The meeting and the count. Whom the board summoned is in the ledger.
    this.logger.log(
      `Notice for meeting ${meetingId} issued to ${String(recipients)} members`,
    );

    return {
      ...toNoticeView(notice),
      deliveries: emptyReport(recipients),
    };
  }

  /**
   * The notice on one meeting, or null while none has been issued.
   *
   * Read through the same client the caller is already using, so a board reading
   * a meeting sees the notice and the agenda as they stood at one instant.
   */
  async read(
    client: PrismaService | Prisma.TransactionClient,
    meetingId: string,
  ): Promise<MeetingNoticeView | null> {
    const notice = await client.meetingNotice.findUnique({
      where: { meetingId },
      select: {
        ...NOTICE_COLUMNS,
        deliveries: {
          select: { personId: true, status: true, failureReason: true },
        },
      },
    });
    if (notice === null) {
      return null;
    }

    return {
      ...toNoticeView(notice),
      deliveries: {
        pending: notice.deliveries.filter((one) => one.status === "PENDING")
          .length,
        sent: notice.deliveries.filter((one) => one.status === "SENT").length,
        failed: notice.deliveries.filter((one) => one.status === "FAILED")
          .length,
        mailNotConfigured: notice.deliveries.some(
          (one) =>
            one.failureReason === NOTICE_DELIVERY_FAILURES.mailNotConfigured,
        ),
        unreachedPersonIds: notice.deliveries
          .filter((one) => one.status === "FAILED")
          .map((one) => one.personId),
      },
    };
  }

  /**
   * The members the register shows on a given day.
   *
   * The archive is read whole and corrected first, because a CORRECTION carries
   * the event type of the row it replaces and reading the raw rows would count
   * one as a third kind of event. A membership counts when it has begun and has
   * not ended: an entry dated ahead of the day is somebody who is not a member
   * yet, and calling them would be summoning somebody with no right to be there.
   */
  private async membersOn(
    client: Prisma.TransactionClient,
    day: LocalDay,
  ): Promise<string[]> {
    const on = dateColumnOf(day);
    const rows = await client.memberRegisterEntry.findMany({
      orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
      select: REGISTER_COLUMNS,
    });

    const members = new Set<string>();
    for (const period of membershipPeriods(resolveRegisterEvents(rows))) {
      const begun =
        period.entry !== null && period.entry.eventOn.getTime() <= on.getTime();
      if (begun && isCurrentMembership(period, on)) {
        members.add(period.personId);
      }
    }
    return [...members];
  }

  /**
   * The instant the meeting begins, from a time of day on the meeting's own day.
   *
   * The caller states a time and never a date, which is what keeps the meeting
   * day the single answer to "which day". Refused rather than clamped when the
   * association's clock has no such instant: the hour that does not exist on the
   * spring-forward night is a time nobody can be summoned to, and reading it as
   * the next one would summon them to an hour the notice does not say.
   */
  private readStartOfMeeting(text: string, heldOn: Date): Date {
    const parts = /^(\d{2}):(\d{2})$/u.exec(text);
    const hours = parts === null ? -1 : Number(parts[1]);
    const minutes = parts === null ? -1 : Number(parts[2]);
    /*
     * The clock's own bounds, checked here as well as in the request schema.
     * `instantAt` rolls a minute past midnight into the following day, so "25:00"
     * left unchecked would be a notice for the day after the meeting - which is
     * the one wrong answer this method exists to make impossible.
     */
    const at =
      hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
        ? instantAt(localDayOfColumn(heldOn), hours * 60 + minutes)
        : null;
    if (at === null) {
      throw new MeetingError(
        "There is no such time on the day of this meeting.",
        "notice-time-not-on-the-meeting-day",
      );
    }
    return at;
  }
}

function toNoticeView(notice: {
  id: string;
  startsAt: Date;
  place: string;
  digitalParticipation: string | null;
  issuedAt: Date;
  issuedByPersonId: string;
}): Omit<MeetingNoticeView, "deliveries"> {
  return {
    id: notice.id,
    startsAt: notice.startsAt.toISOString(),
    place: notice.place,
    digitalParticipation: notice.digitalParticipation,
    issuedAt: notice.issuedAt.toISOString(),
    issuedByPersonId: notice.issuedByPersonId,
  };
}

/**
 * The report a notice has the moment it is issued.
 *
 * Every row is PENDING and none has failed, which is true by construction: the
 * ledger was written in the transaction that has just committed and the worker
 * has not run. Stated rather than read back, so the answer to the request that
 * issued the notice cannot depend on whether the queue happened to be quick.
 */
function emptyReport(recipients: number): NoticeDeliveryReport {
  return {
    pending: recipients,
    sent: 0,
    failed: 0,
    mailNotConfigured: false,
    unreachedPersonIds: [],
  };
}
