import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import {
  dateColumnOf,
  formatLocalDay,
  localDayOfColumn,
  parseLocalDay,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

import type {
  AttendanceCapacity,
  AttendanceMode,
  MeetingDecisionOutcome,
  MeetingKind,
  RepresentativeGround,
} from "../generated/prisma/enums";
import { resolveRegisterEvents } from "../registers/membership-periods";
import {
  type MeetingBylaws,
  readMeetingBylaws,
  statutoryMeetingBylaws,
} from "./meeting-bylaws";
import { MeetingError } from "./meeting.error";
import { proxyAuthorityProblem } from "./proxy-authority";
import { votingRoll, type VotingRoll } from "./voting-roll";

/** One agenda item as it is written and read back. */
export interface AgendaItemView {
  id: string;
  position: number;
  title: string;
  decision: MeetingDecisionView | null;
}

/** What the meeting decided on one item, as the chair recorded it. */
export interface MeetingDecisionView {
  outcome: MeetingDecisionOutcome;
  votesFor: number;
  votesAgainst: number;
  votesAbstaining: number;
  closedBallot: boolean;
  recordedByPersonId: string;
  /** ISO instant. */
  recordedAt: string;
}

/** One line of the list EFL 6 kap. 27 § has drawn up at the meeting. */
export interface AttendanceView {
  id: string;
  personId: string;
  capacity: AttendanceCapacity;
  mode: AttendanceMode;
  /** The member or ombud a bitrade came with. Null on every other line. */
  onBehalfOfPersonId: string | null;
  /** ISO instant, or null while the person stands on the list. */
  withdrawnAt: string | null;
}

/** One member's written authority for an ombud. */
export interface ProxyAppointmentView {
  id: string;
  memberPersonId: string;
  proxyHolderPersonId: string;
  ground: RepresentativeGround;
  /** "YYYY-MM-DD": the day the member signed the fullmakt. */
  authorisedOn: string;
  /** ISO instant, or null while the authority stands. */
  withdrawnAt: string | null;
  recordedByPersonId: string;
}

/** A meeting in the board's list. */
export interface MeetingSummaryView {
  id: string;
  kind: MeetingKind;
  /** "YYYY-MM-DD": the day that decides who has a vote. */
  heldOn: string;
  /** ISO instant, or null while the meeting is being arranged. */
  concludedAt: string | null;
  agendaItemCount: number;
}

/**
 * One meeting with everything the board's screen reads in one answer.
 *
 * The bylaws travel with it rather than being fetched separately, for the reason
 * the motion intake carries the deadline: a board registering a proxy needs to
 * know what its own bylaws allow, and a screen that had to go and look that up
 * would show the form before it knew whether the form's answer would be
 * accepted. The two clauses the platform does not apply travel for the same
 * reason - they are what the board applies in the room.
 */
export interface MeetingView extends MeetingSummaryView {
  agenda: AgendaItemView[];
  attendances: AttendanceView[];
  proxyAppointments: ProxyAppointmentView[];
  bylaws: MeetingBylaws;
  /** The roll drawn from the register as of the meeting day. */
  votingRoll: VotingRoll;
}

export interface ArrangeMeetingInput {
  kind: MeetingKind;
  /** "YYYY-MM-DD". */
  heldOn: string;
}

export interface SetAgendaInput {
  items: { title: string }[];
}

export interface RecordAttendanceInput {
  personId: string;
  capacity: AttendanceCapacity;
  mode: AttendanceMode;
  /** Required for a bitrade and refused for anybody else. */
  onBehalfOfPersonId?: string | null;
}

export interface RegisterProxyInput {
  memberPersonId: string;
  proxyHolderPersonId: string;
  ground: RepresentativeGround;
  /** "YYYY-MM-DD": the day the member signed the fullmakt. */
  authorisedOn: string;
}

export interface RecordDecisionInput {
  outcome: MeetingDecisionOutcome;
  votesFor: number;
  votesAgainst: number;
  votesAbstaining: number;
  closedBallot: boolean;
}

/**
 * A read that runs either on the pool or inside a transaction.
 *
 * The alias the audit log and the event module already declare for the same
 * reason: several private reads here are called from both, and repeating the
 * union at each of them invites the two to drift.
 */
type MeetingDbClient = PrismaService | Prisma.TransactionClient;

/** The columns every meeting read selects. */
const MEETING_COLUMNS = {
  id: true,
  kind: true,
  heldOn: true,
  concludedAt: true,
} as const;

/**
 * The general meeting (foreningsstamma): arranging one, its agenda, who was
 * present, the written authorities somebody else's vote is exercised under, and
 * what the meeting decided.
 *
 * EFL 6 kap., which BRL 9 kap. 14 § applies to a housing cooperative with six
 * exceptions.
 *
 * ## What this service records, and what it does not
 *
 * It records the decisions. The protokoll is a document: EFL 6 kap. 39 § has the
 * chair see that one is kept, with the voting roll taken into it or appended to
 * it, and 40 § has it held available to the members within three weeks and kept
 * safely. That document is filed in the association's archive, which is also
 * where the motion module already says the lasting record of a meeting's
 * decision lives. So nothing here produces minutes, and nothing here signs
 * anything: a document that has to be signed under that Act may be signed with
 * an advanced electronic signature (EFL 1 kap. 15 §), which is a trust service
 * this platform does not provide.
 *
 * It does not cast a vote. The chair records the outcome and the counts, which
 * is how EFL 6 kap. 39 § has the protokoll state an omrostning. The vote table
 * exists with a nullable voter so a closed ballot is representable, and nothing
 * in this module writes a row into it.
 *
 * ## The board's, and only the board's
 *
 * One capability across the whole module. A general meeting is the members'
 * business with their own association, and arranging one, checking people in,
 * registering a fullmakt and minuting a decision are all the board's side of
 * it - which is the same judgement `motions:handle` makes about the queue a
 * member's item arrives in. An external property manager reaches none of it.
 *
 * ## Membership is asked of the register, as of the meeting day
 *
 * Every membership question here goes to the member register
 * (medlemsforteckning) and asks it about the meeting day, never about today.
 * Two reasons, and the first is the statute: only a person who is a member on
 * the meeting day has a vote at it, and BRL 9 kap. 8-9 §§ make the register the
 * record of who that is. The second is that the register is append-only and
 * exempt from every purge, so it can still answer for a meeting held two years
 * ago while residency data cannot.
 *
 * A deliberate departure from `MotionService.requireMember`, which asks the
 * residencies about today. The question there is whether the caller may
 * exercise a right now; the question here is who had a vote on a stated day.
 *
 * Which bostadsratt a membership covers is a different question and comes from
 * the residencies with the MEMBER role - the rows the apartment register itself
 * reads to list an apartment's holders. `voting-roll.ts` argues why the archive
 * cannot answer that one.
 *
 * ## The roll is derived every time it is read
 *
 * `voting-roll.ts` computes it from the register, the member residencies, the
 * attendance lines and the standing authorities. Nothing is cached and no count
 * is stored, on the booking allowance's precedent: a stored figure goes stale
 * the moment somebody moves or a transfer completes, and it goes stale silently.
 */
@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The board's list: the meeting furthest ahead first, held ones below. */
  async list(): Promise<MeetingSummaryView[]> {
    const meetings = await this.prisma.meeting.findMany({
      orderBy: [{ heldOn: "desc" }],
      select: {
        ...MEETING_COLUMNS,
        _count: { select: { agendaItems: true } },
      },
    });
    return meetings.map((meeting) => ({
      ...toSummary(meeting),
      agendaItemCount: meeting._count.agendaItems,
    }));
  }

  /**
   * Arranges a meeting.
   *
   * The day is checked as a calendar date and not as an instant, through the
   * same module the register's own statutory dates go through - except that a
   * meeting day in the future is the ordinary case rather than a refusal, which
   * is why the future check is undone here and stated. A stamma is arranged
   * before it is held; a termination is recorded after it happened.
   */
  async arrange(
    input: ArrangeMeetingInput,
    actorPersonId: string,
  ): Promise<MeetingSummaryView> {
    const heldOn = this.readMeetingDay(input.heldOn);

    const meeting = await this.prisma.$transaction(async (tx) => {
      const created = await tx.meeting.create({
        data: { kind: input.kind, heldOn },
        select: MEETING_COLUMNS,
      });
      await this.audit.record(
        {
          action: "MEETING_ARRANGED",
          actorPersonId,
          // No subject: a stamma is the association's own act and is about
          // nobody in particular.
          targetKind: "meeting",
          targetId: created.id,
          context: {
            kind: input.kind,
            heldOn: formatLocalDay(localDayOfColumn(heldOn)),
          },
        },
        tx,
      );
      return created;
    });

    this.logger.log(`Meeting ${meeting.id} arranged`);
    return { ...toSummary(meeting), agendaItemCount: 0 };
  }

  /**
   * Records that the meeting has been held.
   *
   * The one act that turns the agenda from a plan into a record of what the
   * meeting dealt with, and the roll from a projection of the register into a
   * fact about a day that has passed. Conditional on the meeting still being
   * open, so two board members clicking the same button produce one close and
   * the loser is answered exactly as a read would have answered them.
   */
  async conclude(
    meetingId: string,
    actorPersonId: string,
  ): Promise<MeetingSummaryView> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.meeting.updateMany({
        where: { id: meetingId, concludedAt: null },
        data: { concludedAt: new Date() },
      });
      if (count === 0) {
        await this.requireMeeting(tx, meetingId);
        throw new MeetingError(
          "This meeting has already been recorded as held.",
          "meeting-already-held",
        );
      }

      const meeting = await tx.meeting.findUniqueOrThrow({
        where: { id: meetingId },
        select: {
          ...MEETING_COLUMNS,
          _count: { select: { agendaItems: true } },
        },
      });

      await this.audit.record(
        {
          action: "MEETING_HELD",
          actorPersonId,
          targetKind: "meeting",
          targetId: meetingId,
          context: { heldOn: formatLocalDay(localDayOfColumn(meeting.heldOn)) },
        },
        tx,
      );

      this.logger.log(`Meeting ${meetingId} recorded as held`);
      return {
        ...toSummary(meeting),
        agendaItemCount: meeting._count.agendaItems,
      };
    });
  }

  /**
   * Replaces the agenda with the items given, in the order given.
   *
   * A replacement and not a set of edits, because an agenda is a running order:
   * moving an item is the same act as adding one, and an interface that offered
   * both would have to reconcile two orderings. The positions are written from
   * the order of the list, one-based, so the caller states the order and never
   * the numbers - a caller that stated its own could state a gap or a repeat,
   * which is not a running order.
   *
   * Deleting and rewriting inside one transaction, which drops any decision
   * recorded against an item that goes. That is the reason the agenda cannot be
   * set once the meeting has been held: afterwards the agenda is the record of
   * what the meeting dealt with, and rewriting it would discard the minute of a
   * decision the meeting took.
   */
  async setAgenda(
    meetingId: string,
    input: SetAgendaInput,
    actorPersonId: string,
  ): Promise<AgendaItemView[]> {
    return this.prisma.$transaction(async (tx) => {
      const meeting = await this.requireMeeting(tx, meetingId);
      this.refuseIfHeld(meeting);

      await tx.agendaItem.deleteMany({ where: { meetingId } });
      await tx.agendaItem.createMany({
        data: input.items.map((item, index) => ({
          meetingId,
          position: index + 1,
          title: item.title,
        })),
      });

      await this.audit.record(
        {
          action: "MEETING_AGENDA_SET",
          actorPersonId,
          targetKind: "meeting",
          targetId: meetingId,
          // How many items, and never a word of them. The log is append-only
          // and exempt from every purge, so text copied into it would outlive
          // the row it came from.
          context: { itemCount: input.items.length },
        },
        tx,
      );

      this.logger.log(
        `Agenda of meeting ${meetingId} set to ${String(input.items.length)} items`,
      );
      return this.readAgenda(tx, meetingId);
    });
  }

  /**
   * Records that somebody is present, in a stated capacity.
   *
   * Four rules, and each of them is the statute:
   *
   *   A MEMBER line requires membership on the meeting day. EFL 6 kap. 2 § gives
   *   the right to attend, speak and vote to a member, and 3 § gives them the
   *   vote.
   *
   *   A PROXY_HOLDER line requires a standing, current authority naming them.
   *   Otherwise the line is a person on the list with nothing to exercise, and
   *   the roll would have to report them as such rather than the board being
   *   told at the door.
   *
   *   An ASSISTANT line requires the member or ombud they came with to be on the
   *   list already. EFL 6 kap. 7 § has a member or an ombud bring the bitrade,
   *   so a bitrade with nobody there to have brought them is not one. At most
   *   one per principal, which the database states.
   *
   *   Nothing else may carry `onBehalfOfPersonId`, which the database also
   *   states. A member is nobody's stand-in and an ombud's principals are the
   *   authorities they hold.
   *
   * Somebody recorded and struck off again is checked in on the same line, which
   * clears the date - the sign-up's own pattern.
   */
  async recordAttendance(
    meetingId: string,
    input: RecordAttendanceInput,
    actorPersonId: string,
  ): Promise<AttendanceView> {
    return this.prisma.$transaction(async (tx) => {
      const meeting = await this.requireMeeting(tx, meetingId);
      this.refuseIfHeld(meeting);

      const onBehalfOfPersonId = input.onBehalfOfPersonId ?? null;
      /*
       * Only a bitrade came with anybody, which the table also states as a check
       * constraint. Refused rather than dropped: a member is nobody's stand-in
       * and an ombud's principals are the authorities they hold, so a request
       * naming one on either line has misunderstood the payload - and a field the
       * server silently ignored is a defect nothing surfaces.
       */
      if (input.capacity !== "ASSISTANT" && onBehalfOfPersonId !== null) {
        throw new MeetingError(
          "Only a bitrade is recorded with the person who brought them.",
          "attendance-principal-not-applicable",
        );
      }

      if (input.capacity === "MEMBER") {
        await this.requireMemberOn(tx, input.personId, meeting.heldOn, {
          reason: "not-a-member-on-the-meeting-day",
        });
      }
      if (input.capacity === "PROXY_HOLDER") {
        await this.requireStandingAuthority(tx, meetingId, input.personId);
      }
      if (input.capacity === "ASSISTANT") {
        await this.requirePrincipalPresent(tx, meetingId, onBehalfOfPersonId);
      }

      const attendance = await tx.meetingAttendance.upsert({
        where: {
          meetingId_personId_capacity: {
            meetingId,
            personId: input.personId,
            capacity: input.capacity,
          },
        },
        create: {
          meetingId,
          personId: input.personId,
          capacity: input.capacity,
          mode: input.mode,
          onBehalfOfPersonId,
        },
        // A line struck off and taken up again is the same line with its date
        // cleared, so the board's list does not grow a second row for one
        // person in one capacity.
        update: { mode: input.mode, onBehalfOfPersonId, withdrawnAt: null },
        select: ATTENDANCE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "MEETING_ATTENDANCE_RECORDED",
          actorPersonId,
          // The person present is the subject, so their own access report shows
          // that the association recorded them in the room.
          targetPersonId: input.personId,
          targetKind: "meetingAttendance",
          targetId: attendance.id,
          context: { meetingId, capacity: input.capacity, mode: input.mode },
        },
        tx,
      );

      this.logger.log(
        `Attendance ${attendance.id} recorded at meeting ${meetingId}`,
      );
      return toAttendanceView(attendance);
    });
  }

  /**
   * Strikes a line off the list.
   *
   * A date and never a delete, so "was recorded as present and struck off again"
   * stays answerable - the argument a called-off occurrence and a withdrawn
   * sign-up both make. Idempotent: striking off a line that is already off is
   * the state the caller asked for.
   */
  async withdrawAttendance(
    meetingId: string,
    attendanceId: string,
    actorPersonId: string,
  ): Promise<AttendanceView> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.meetingAttendance.findFirst({
        where: { id: attendanceId, meetingId },
        select: ATTENDANCE_COLUMNS,
      });
      if (existing === null) {
        throw new MeetingError(
          "No such attendance line at this meeting.",
          "attendance-not-found",
        );
      }
      if (existing.withdrawnAt !== null) {
        return toAttendanceView(existing);
      }

      const attendance = await tx.meetingAttendance.update({
        where: { id: attendanceId },
        data: { withdrawnAt: new Date() },
        select: ATTENDANCE_COLUMNS,
      });

      await this.audit.record(
        {
          action: "MEETING_ATTENDANCE_WITHDRAWN",
          actorPersonId,
          targetPersonId: existing.personId,
          targetKind: "meetingAttendance",
          targetId: attendanceId,
          context: { meetingId, capacity: existing.capacity },
        },
        tx,
      );

      this.logger.log(
        `Attendance ${attendanceId} struck off meeting ${meetingId}`,
      );
      return toAttendanceView(attendance);
    });
  }

  /**
   * Registers a member's written authority for an ombud, against the bylaws.
   *
   * Five checks, in the order a board would meet them, and every one of them
   * cites something:
   *
   *   The member is a member on the meeting day (EFL 6 kap. 3 §): an authority
   *   from somebody with no vote confers nothing.
   *
   *   The fullmakt is dated inside its year and not in the future (EFL 6 kap.
   *   4 § andra stycket). Asked here and again when the roll is drawn, because
   *   the meeting day can be moved afterwards.
   *
   *   The ombud is eligible on the ground stated. MEMBER is checked against the
   *   register; SPOUSE_OR_COHABITANT is the board's own statement, taken from the
   *   fullmakt, because this platform holds no record of who is married to whom;
   *   BYLAWS is accepted only where the association has recorded that its bylaws
   *   widen BRL 9 kap. 14 § 4.
   *
   *   The ombud is not already carrying as many members as the bylaws allow (BRL
   *   9 kap. 14 § 4, last sentence, defaulting to one).
   *
   *   The member is not already represented, which the database states as a
   *   unique constraint (EFL 6 kap. 4 § forsta stycket). Registering a second
   *   ombud for one member rewrites the first appointment rather than adding
   *   one, so the constraint is what makes that the only possible outcome.
   */
  async registerProxy(
    meetingId: string,
    input: RegisterProxyInput,
    actorPersonId: string,
  ): Promise<ProxyAppointmentView> {
    return this.prisma.$transaction(async (tx) => {
      const meeting = await this.requireMeeting(tx, meetingId);
      this.refuseIfHeld(meeting);

      const bylaws = await this.readBylaws(tx);
      const authorisedOn = this.readMeetingDay(input.authorisedOn);

      await this.requireMemberOn(tx, input.memberPersonId, meeting.heldOn, {
        reason: "not-a-member-on-the-meeting-day",
      });

      const problem = proxyAuthorityProblem(
        localDayOfColumn(authorisedOn),
        localDayOfColumn(meeting.heldOn),
      );
      if (problem !== null) {
        throw new MeetingError(
          "The authority does not cover the day of this meeting.",
          problem,
        );
      }

      await this.requireEligibleProxyHolder(tx, {
        proxyHolderPersonId: input.proxyHolderPersonId,
        ground: input.ground,
        meetingDay: meeting.heldOn,
        bylaws,
      });
      await this.requireProxyLimitRoom(tx, {
        meetingId,
        proxyHolderPersonId: input.proxyHolderPersonId,
        memberPersonId: input.memberPersonId,
        bylaws,
      });

      const appointment = await tx.proxyAppointment.upsert({
        where: {
          meetingId_memberPersonId: {
            meetingId,
            memberPersonId: input.memberPersonId,
          },
        },
        create: {
          meetingId,
          memberPersonId: input.memberPersonId,
          proxyHolderPersonId: input.proxyHolderPersonId,
          ground: input.ground,
          authorisedOn,
          recordedByPersonId: actorPersonId,
        },
        // A member appointing somebody else rewrites the one row they may have,
        // clearing any withdrawal: a member may not be represented by more than
        // one ombud, so there is no second row for the platform to keep.
        update: {
          proxyHolderPersonId: input.proxyHolderPersonId,
          ground: input.ground,
          authorisedOn,
          withdrawnAt: null,
          recordedByPersonId: actorPersonId,
        },
        select: PROXY_COLUMNS,
      });

      await this.audit.record(
        {
          action: "MEETING_PROXY_REGISTERED",
          actorPersonId,
          /*
           * The member who gave the authority is the subject. It is their voting
           * right that somebody else will exercise, so their own access report
           * is where that has to be visible. The ombud is not a second target
           * column here - the log has one - and reaches their own report through
           * the appointment's section, which answers for both roles.
           */
          targetPersonId: input.memberPersonId,
          targetKind: "proxyAppointment",
          targetId: appointment.id,
          context: {
            meetingId,
            ground: input.ground,
            authorisedOn: formatLocalDay(localDayOfColumn(authorisedOn)),
          },
        },
        tx,
      );

      this.logger.log(
        `Proxy appointment ${appointment.id} registered at meeting ${meetingId}`,
      );
      return toProxyView(appointment);
    });
  }

  /**
   * Withdraws an authority.
   *
   * A date and never a delete: a member who takes their fullmakt back has done
   * something, and a deleted row could only say so by absence. Idempotent, like
   * striking a line off the list.
   */
  async withdrawProxy(
    meetingId: string,
    appointmentId: string,
    actorPersonId: string,
  ): Promise<ProxyAppointmentView> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.proxyAppointment.findFirst({
        where: { id: appointmentId, meetingId },
        select: PROXY_COLUMNS,
      });
      if (existing === null) {
        throw new MeetingError(
          "No such proxy appointment at this meeting.",
          "proxy-appointment-not-found",
        );
      }
      if (existing.withdrawnAt !== null) {
        return toProxyView(existing);
      }

      const appointment = await tx.proxyAppointment.update({
        where: { id: appointmentId },
        data: { withdrawnAt: new Date() },
        select: PROXY_COLUMNS,
      });

      await this.audit.record(
        {
          action: "MEETING_PROXY_WITHDRAWN",
          actorPersonId,
          targetPersonId: existing.memberPersonId,
          targetKind: "proxyAppointment",
          targetId: appointmentId,
          context: { meetingId },
        },
        tx,
      );

      this.logger.log(
        `Proxy appointment ${appointmentId} withdrawn at meeting ${meetingId}`,
      );
      return toProxyView(appointment);
    });
  }

  /**
   * Records what the meeting decided on one agenda item.
   *
   * The counts and the outcome both, because the outcome is not computable from
   * the counts: the majority a decision needs is not uniform, and which rule an
   * item falls under is a fact about the item that nothing here holds. See the
   * MeetingDecision model comment for the three rules and where they come from.
   *
   * Written by the chair only once the meeting has been recorded as held. A
   * decision minuted against a meeting that has not happened is not a minute,
   * and the refusal is what keeps the agenda's own rewrite from discarding one.
   *
   * Corrected in place, one decision per item, with the audit log carrying the
   * counts it moved to. What stands is the signed protokoll; this row is the
   * platform's copy of the figure, and a chair who mis-keys one has to be able
   * to fix it.
   */
  async recordDecision(
    meetingId: string,
    agendaItemId: string,
    input: RecordDecisionInput,
    actorPersonId: string,
  ): Promise<AgendaItemView> {
    return this.prisma.$transaction(async (tx) => {
      const meeting = await this.requireMeeting(tx, meetingId);
      if (meeting.concludedAt === null) {
        throw new MeetingError(
          "A decision is minuted once the meeting has been held.",
          "meeting-not-held",
        );
      }

      const item = await tx.agendaItem.findFirst({
        where: { id: agendaItemId, meetingId },
        select: { id: true },
      });
      if (item === null) {
        throw new MeetingError(
          "No such agenda item at this meeting.",
          "agenda-item-not-found",
        );
      }

      const data = {
        outcome: input.outcome,
        votesFor: input.votesFor,
        votesAgainst: input.votesAgainst,
        votesAbstaining: input.votesAbstaining,
        closedBallot: input.closedBallot,
        recordedByPersonId: actorPersonId,
      };
      await tx.meetingDecision.upsert({
        where: { agendaItemId },
        create: { agendaItemId, ...data },
        update: data,
      });

      await this.audit.record(
        {
          action: "MEETING_DECISION_RECORDED",
          actorPersonId,
          // No subject: what the meeting resolved is the association's business
          // and not an act about a person, even where the item was somebody's
          // motion - the motions module writes the entry that names them.
          targetKind: "agendaItem",
          targetId: agendaItemId,
          context: {
            meetingId,
            outcome: input.outcome,
            votesFor: input.votesFor,
            votesAgainst: input.votesAgainst,
            votesAbstaining: input.votesAbstaining,
            closedBallot: input.closedBallot,
          },
        },
        tx,
      );

      this.logger.log(
        `Decision recorded on agenda item ${agendaItemId} of meeting ${meetingId}`,
      );
      const [refreshed] = await this.readAgenda(tx, meetingId, agendaItemId);
      if (refreshed === undefined) {
        throw new MeetingError(
          "No such agenda item at this meeting.",
          "agenda-item-not-found",
        );
      }
      return refreshed;
    });
  }

  /**
   * One meeting, its agenda, its list of those present, the authorities
   * registered against it, the bylaws that govern it and the roll drawn from the
   * register as of its day.
   *
   * One answer rather than six calls, on the motion intake's reasoning: a board
   * checking people in needs the list, the authorities and what its own bylaws
   * allow at once, and a screen that fetched them separately would show a state
   * that never existed at any single moment.
   */
  async read(meetingId: string): Promise<MeetingView> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        ...MEETING_COLUMNS,
        _count: { select: { agendaItems: true } },
      },
    });
    if (meeting === null) {
      throw new MeetingError("No such meeting.", "meeting-not-found");
    }

    const [agenda, attendances, proxyAppointments, bylaws, roll] =
      await Promise.all([
        this.readAgenda(this.prisma, meetingId),
        this.prisma.meetingAttendance.findMany({
          where: { meetingId },
          orderBy: [{ capacity: "asc" }, { createdAt: "asc" }],
          select: ATTENDANCE_COLUMNS,
        }),
        this.prisma.proxyAppointment.findMany({
          where: { meetingId },
          orderBy: [{ createdAt: "asc" }],
          select: PROXY_COLUMNS,
        }),
        this.readBylaws(this.prisma),
        this.readVotingRoll(meetingId, meeting.heldOn),
      ]);

    return {
      ...toSummary(meeting),
      agendaItemCount: meeting._count.agendaItems,
      agenda,
      attendances: attendances.map(toAttendanceView),
      proxyAppointments: proxyAppointments.map(toProxyView),
      bylaws,
      votingRoll: roll,
    };
  }

  /**
   * The roll, drawn from the member register as of the meeting day.
   *
   * The whole archive is read rather than a slice of it, and that is not an
   * oversight. The roll is the association's whole membership, so every person
   * the register holds is a candidate line; a query narrowed to the people who
   * turned up could not report the votes that stayed at home, which is the half
   * of the roll that says whether a meeting was worth holding. Corrections are
   * applied first, through the one function that reads this archive correctly.
   */
  private async readVotingRoll(
    meetingId: string,
    meetingDay: Date,
  ): Promise<VotingRoll> {
    const [rows, holdings, attendances, appointments, bylaws] =
      await Promise.all([
        this.prisma.memberRegisterEntry.findMany({
          orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
          select: REGISTER_COLUMNS,
        }),
        /*
         * Which bostadsratt each membership covered on the meeting day, from the
         * residencies with the MEMBER role - the same rows the apartment register
         * reads to list an apartment's holders. `voting-roll.ts` says why this
         * cannot come out of the member register archive: an EXIT is written only
         * when a person's last tenant-ownership ends, so the archive leaves an open
         * entry on an apartment somebody sold while keeping another.
         *
         * Bounded by the day at both ends. The move-in date is the first day held
         * and the move-out date is the first day not held, which is how every
         * reader of this table states it, and both are `@db.Date` columns compared
         * against a `@db.Date` value rather than against an instant.
         */
        this.prisma.residency.findMany({
          where: {
            role: "MEMBER",
            movedInOn: { lte: meetingDay },
            OR: [{ movedOutOn: null }, { movedOutOn: { gt: meetingDay } }],
          },
          select: { personId: true, apartmentId: true },
        }),
        this.prisma.meetingAttendance.findMany({
          where: { meetingId },
          select: { personId: true, capacity: true, withdrawnAt: true },
        }),
        this.prisma.proxyAppointment.findMany({
          where: { meetingId },
          select: {
            memberPersonId: true,
            proxyHolderPersonId: true,
            authorisedOn: true,
            withdrawnAt: true,
          },
        }),
        this.readBylaws(this.prisma),
      ]);

    return votingRoll({
      events: resolveRegisterEvents(rows),
      meetingDay,
      holdings,
      attendances,
      proxyAppointments: appointments,
      storageOnlyVoteLimited: bylaws.storageOnlyVoteLimited,
    });
  }

  /** The four bylaws clauses, or the statute where no association is recorded. */
  private async readBylaws(client: MeetingDbClient): Promise<MeetingBylaws> {
    const association = await client.association.findUnique({
      where: { id: 1 },
      select: {
        bylawsWidenProxyHolderEligibility: true,
        bylawsMaxMembersPerProxyHolder: true,
        bylawsLimitStorageOnlyVote: true,
        bylawsWidenAssistantEligibility: true,
      },
    });
    // No association row yet, so no bylaws to read a clause out of - and the
    // statute is what governs a cooperative whose bylaws nobody has recorded.
    return association === null
      ? statutoryMeetingBylaws()
      : readMeetingBylaws(association);
  }

  private async readAgenda(
    client: MeetingDbClient,
    meetingId: string,
    agendaItemId?: string,
  ): Promise<AgendaItemView[]> {
    const items = await client.agendaItem.findMany({
      where:
        agendaItemId === undefined
          ? { meetingId }
          : { meetingId, id: agendaItemId },
      orderBy: [{ position: "asc" }],
      select: {
        id: true,
        position: true,
        title: true,
        decision: {
          select: {
            outcome: true,
            votesFor: true,
            votesAgainst: true,
            votesAbstaining: true,
            closedBallot: true,
            recordedByPersonId: true,
            updatedAt: true,
          },
        },
      },
    });

    return items.map((item) => ({
      id: item.id,
      position: item.position,
      title: item.title,
      decision:
        item.decision === null
          ? null
          : {
              outcome: item.decision.outcome,
              votesFor: item.decision.votesFor,
              votesAgainst: item.decision.votesAgainst,
              votesAbstaining: item.decision.votesAbstaining,
              closedBallot: item.decision.closedBallot,
              recordedByPersonId: item.decision.recordedByPersonId,
              // The moment the figure that stands was written, which a
              // correction moves. What the earlier figure was is in the log.
              recordedAt: item.decision.updatedAt.toISOString(),
            },
    }));
  }

  private async requireMeeting(
    client: MeetingDbClient,
    meetingId: string,
  ): Promise<{ id: string; heldOn: Date; concludedAt: Date | null }> {
    const meeting = await client.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, heldOn: true, concludedAt: true },
    });
    if (meeting === null) {
      throw new MeetingError("No such meeting.", "meeting-not-found");
    }
    return meeting;
  }

  private refuseIfHeld(meeting: { concludedAt: Date | null }): void {
    if (meeting.concludedAt !== null) {
      throw new MeetingError(
        "This meeting has been recorded as held.",
        "meeting-already-held",
      );
    }
  }

  /**
   * A "YYYY-MM-DD" day, as a date column value.
   *
   * Strict about the date being real, which is the register's own reason for
   * parsing rather than constructing: a regular expression accepts "2027-02-30"
   * and `Date.parse` answers the 2nd of March, so a board mis-typing a month
   * would otherwise get a meeting on a different day from the one it typed.
   * Written through `dateColumnOf` for the reason `statutory-date.ts` sets out
   * at length - the same file also compares the value, and nothing may depend on
   * `new Date(text)` agreeing with it.
   *
   * Deliberately not `statutoryDate` itself, whose other rule does not apply
   * here: it refuses a date in the future because a tenant-ownership that has
   * not ceased cannot be reported as having ceased. A stamma is arranged before
   * it is held and a fullmakt is dated for a meeting still to come, so both of
   * the days this method reads are ordinarily ahead of today. The one future
   * date that is refused is a fullmakt dated after the meeting it is for, which
   * `proxy-authority.ts` decides on its own grounds.
   */
  private readMeetingDay(text: string): Date {
    const day = parseLocalDay(text);
    if (day === null) {
      throw new MeetingError(
        "That is not a calendar date.",
        "date-not-a-calendar-date",
      );
    }
    return dateColumnOf(day);
  }

  /**
   * Refuses somebody who was not a member on the given day.
   *
   * Asked of the member register and about that day, for the three reasons the
   * class comment gives. The archive is read whole and corrected first, because
   * a CORRECTION carries the event type of the row it replaces and reading the
   * raw rows would count one as a third kind of event.
   */
  private async requireMemberOn(
    client: MeetingDbClient,
    personId: string,
    meetingDay: Date,
    failure: {
      reason: "not-a-member-on-the-meeting-day" | "proxy-holder-not-a-member";
    },
  ): Promise<void> {
    const wasMember = await this.isMemberOn(client, personId, meetingDay);
    if (!wasMember) {
      throw new MeetingError(
        "That person was not a member of the association on the day of this meeting.",
        failure.reason,
      );
    }
  }

  /**
   * Whether the register shows this person as a member on the given day.
   *
   * The roll's own derivation answers the same question for everybody at once;
   * this asks it for one person, and both go through the same archive read so
   * the door and the roll cannot disagree.
   */
  private async isMemberOn(
    client: MeetingDbClient,
    personId: string,
    meetingDay: Date,
  ): Promise<boolean> {
    const rows = await client.memberRegisterEntry.findMany({
      where: { personId },
      orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
      select: REGISTER_COLUMNS,
    });
    const roll = votingRoll({
      events: resolveRegisterEvents(rows),
      meetingDay,
      // No holdings, because none is needed: they decide which lines merge and
      // never whether a line exists, so a one-person roll answers the membership
      // question with nothing to merge against.
      holdings: [],
      attendances: [],
      proxyAppointments: [],
      storageOnlyVoteLimited: false,
    });
    return roll.lines.some((line) => line.memberPersonIds.includes(personId));
  }

  /** The ombud is eligible on the ground the board stated. */
  private async requireEligibleProxyHolder(
    client: Prisma.TransactionClient,
    input: {
      proxyHolderPersonId: string;
      ground: RepresentativeGround;
      meetingDay: Date;
      bylaws: MeetingBylaws;
    },
  ): Promise<void> {
    switch (input.ground) {
      case "MEMBER":
        await this.requireMemberOn(
          client,
          input.proxyHolderPersonId,
          input.meetingDay,
          { reason: "proxy-holder-not-a-member" },
        );
        return;

      case "SPOUSE_OR_COHABITANT":
        /*
         * Accepted as stated. BRL 9 kap. 14 § 4 permits the member's spouse or
         * cohabitant outright, and this platform holds no record of who is
         * married to whom or who lives with whom - one inferred from a shared
         * residency would be wrong about siblings and lodgers alike. So the
         * board's statement is what the row carries, and refusing it would
         * refuse an appointment the statute allows.
         */
        return;

      case "BYLAWS":
        if (!input.bylaws.proxyHolderEligibilityWidened) {
          throw new MeetingError(
            "The bylaws do not permit an ombud on that ground.",
            "proxy-holder-not-permitted-by-bylaws",
          );
        }
        return;
    }
  }

  /**
   * The ombud is not already carrying as many members as the bylaws allow.
   *
   * BRL 9 kap. 14 § 4's last sentence, defaulting to one member and not to EFL
   * 6 kap. 5 §'s three. The member being registered is excluded from the count,
   * so re-registering the same pair is not refused by the limit the pair already
   * satisfies.
   *
   * Counted inside the transaction that writes, and the count is over standing
   * authorities only: an authority that was withdrawn is not one this ombud is
   * carrying.
   */
  private async requireProxyLimitRoom(
    client: Prisma.TransactionClient,
    input: {
      meetingId: string;
      proxyHolderPersonId: string;
      memberPersonId: string;
      bylaws: MeetingBylaws;
    },
  ): Promise<void> {
    const held = await client.proxyAppointment.count({
      where: {
        meetingId: input.meetingId,
        proxyHolderPersonId: input.proxyHolderPersonId,
        withdrawnAt: null,
        memberPersonId: { not: input.memberPersonId },
      },
    });
    if (held >= input.bylaws.maxMembersPerProxyHolder) {
      throw new MeetingError(
        "That person already represents as many members as the bylaws allow.",
        "proxy-holder-limit-reached",
      );
    }
  }

  /** A person recorded as an ombud holds a standing, current authority. */
  private async requireStandingAuthority(
    client: Prisma.TransactionClient,
    meetingId: string,
    proxyHolderPersonId: string,
  ): Promise<void> {
    const held = await client.proxyAppointment.count({
      where: { meetingId, proxyHolderPersonId, withdrawnAt: null },
    });
    if (held === 0) {
      throw new MeetingError(
        "That person holds no authority registered against this meeting.",
        "proxy-holder-holds-no-authority",
      );
    }
  }

  /**
   * A bitrade's principal is on the list.
   *
   * EFL 6 kap. 7 § has a member or an ombud bring the bitrade, so somebody with
   * nobody there to have brought them is not a bitrade. A principal whose own
   * line has been struck off does not count, because a bitrade cannot have been
   * brought by somebody who is not present.
   */
  private async requirePrincipalPresent(
    client: Prisma.TransactionClient,
    meetingId: string,
    onBehalfOfPersonId: string | null,
  ): Promise<void> {
    if (onBehalfOfPersonId === null) {
      throw new MeetingError(
        "A bitrade is recorded with the member or ombud who brought them.",
        "assistant-principal-not-present",
      );
    }
    const present = await client.meetingAttendance.count({
      where: {
        meetingId,
        personId: onBehalfOfPersonId,
        capacity: { in: ["MEMBER", "PROXY_HOLDER"] },
        withdrawnAt: null,
      },
    });
    if (present === 0) {
      throw new MeetingError(
        "The member or ombud who brought them is not on the list.",
        "assistant-principal-not-present",
      );
    }
  }
}

const ATTENDANCE_COLUMNS = {
  id: true,
  personId: true,
  capacity: true,
  mode: true,
  onBehalfOfPersonId: true,
  withdrawnAt: true,
} as const;

const PROXY_COLUMNS = {
  id: true,
  memberPersonId: true,
  proxyHolderPersonId: true,
  ground: true,
  authorisedOn: true,
  withdrawnAt: true,
  recordedByPersonId: true,
} as const;

/**
 * The archive columns the roll and the door read.
 *
 * `resolveRegisterEvents` takes the whole row shape, so every column it names is
 * selected - the recorded name and address among them, which nothing here
 * prints. They are read because the correction chain is followed through the
 * rows themselves, and a projection would have to reimplement it.
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

function toSummary(meeting: {
  id: string;
  kind: MeetingKind;
  heldOn: Date;
  concludedAt: Date | null;
}): Omit<MeetingSummaryView, "agendaItemCount"> {
  return {
    id: meeting.id,
    kind: meeting.kind,
    heldOn: formatLocalDay(localDayOfColumn(meeting.heldOn)),
    concludedAt: meeting.concludedAt?.toISOString() ?? null,
  };
}

function toAttendanceView(row: {
  id: string;
  personId: string;
  capacity: AttendanceCapacity;
  mode: AttendanceMode;
  onBehalfOfPersonId: string | null;
  withdrawnAt: Date | null;
}): AttendanceView {
  return {
    id: row.id,
    personId: row.personId,
    capacity: row.capacity,
    mode: row.mode,
    onBehalfOfPersonId: row.onBehalfOfPersonId,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  };
}

function toProxyView(row: {
  id: string;
  memberPersonId: string;
  proxyHolderPersonId: string;
  ground: RepresentativeGround;
  authorisedOn: Date;
  withdrawnAt: Date | null;
  recordedByPersonId: string;
}): ProxyAppointmentView {
  return {
    id: row.id,
    memberPersonId: row.memberPersonId,
    proxyHolderPersonId: row.proxyHolderPersonId,
    ground: row.ground,
    authorisedOn: formatLocalDay(localDayOfColumn(row.authorisedOn)),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    recordedByPersonId: row.recordedByPersonId,
  };
}
