import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import {
  formatLocalDay,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { MeetingKind, MotionStatus } from "../generated/prisma/enums";
import { lockMeetingAgendasInOrder } from "../meetings/agenda-lock";
import {
  type MotionDeadlineView,
  motionDeadlineView,
  readMotionDeadline,
} from "./motion-deadline";
import { MotionError, type MotionTextLocation } from "./motion.error";

/**
 * The general meeting a motion has been put to.
 *
 * Named rather than given as an identifier, and it is the member's own view that
 * decides that: EFL 6 kap. 15 § gives the member the right to have their item
 * taken up at a general meeting, so "which meeting, and when" is the answer the
 * right is about - and an identifier a member holds no capability to resolve
 * would not be an answer at all. Nothing here is a disclosure: what a member is
 * told is which meeting their own item is on, and the notice states that to them
 * anyway.
 */
export interface MotionMeetingView {
  id: string;
  kind: MeetingKind;
  /** "YYYY-MM-DD": the day the meeting is held. */
  heldOn: string;
  /**
   * Whether the notice has been issued, which is what settles the agenda: once
   * it has, the item cannot be moved to another meeting or taken off this one.
   */
  summoned: boolean;
}

/** A motion as the member who submitted it reads it back. */
export interface OwnMotionView {
  id: string;
  title: string;
  body: string;
  status: MotionStatus;
  /** ISO instant. */
  submittedAt: string;
  /** ISO instant, or null while the motion is with the board. */
  closedAt: string | null;
  /** The meeting the board has put it to, or null while none has. */
  meeting: MotionMeetingView | null;
}

/**
 * Who submitted a motion, as the board may be told.
 *
 * Three cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a member with protected personal data (skyddade
 * personuppgifter). Their name is withheld even though the board's own address
 * book prints it, on the judgement `IssueReporterView` sets out: this payload is
 * a queue rather than a statutory register, and a board member who has to reach
 * them goes through the register that has a reason to name them.
 *
 * `unknown` is a submitter reference that no longer resolves to a person. Motion
 * data is service tier and a person can be purged out from under a row that is
 * still open, so the queue has to be able to say "we no longer know" rather than
 * break.
 */
export type MotionSubmitterView =
  | { kind: "member"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** A motion as the board reads it in the queue. */
export interface QueuedMotionView extends OwnMotionView {
  submitter: MotionSubmitterView;
  /** Who closed it, when somebody has. Never a name: an identifier. */
  closedByPersonId: string | null;
}

/** What the member's half of the screen needs in one answer. */
export interface MotionIntakeView {
  /** The deadline the bylaws set, or null when they set none. */
  deadline: MotionDeadlineView | null;
  motions: OwnMotionView[];
}

/** What the board's half of the screen needs in one answer. */
export interface MotionQueueView {
  deadline: MotionDeadlineView | null;
  motions: QueuedMotionView[];
}

export interface SubmitMotionInput {
  title: string;
  body: string;
}

/**
 * Motions to the general meeting (motioner till stamman): a member's intake and
 * the queue the board works.
 *
 * ## Membership, and why it is checked twice
 *
 * EFL 6 kap. 15 § gives the right to have an item taken up at a general meeting
 * to "en medlem", and BRL 9 kap. 14 § applies that chapter to a housing
 * cooperative with six exceptions of which this is not one. So the right belongs
 * to a member and to nobody else living in the building.
 *
 * The capability `motions:submit` is derived from membership in
 * `authorization/capabilities.ts`, which is what keeps a partner, an adult child
 * or a tenant off the route. {@link submit} then asks the register again, and
 * that second question is not a duplicate of the first: an administrator holds
 * every capability in the model by definition, and holding a grant on an instance
 * is not being a member of the association. Without this check the one account
 * that can do everything could put an item to the meeting as of right, which the
 * statute does not provide for. The capability decides who reaches the form; this
 * decides who has the right.
 *
 * It is asked as of the moment of submission, like the booking quota, so a
 * household that has sold up stops being able to submit on the day the residency
 * ends rather than when somebody remembers to change something.
 *
 * The same paragraph withholds the right from a member who has been excluded even
 * though the membership has not yet ended. This platform records no exclusion -
 * the member register knows entry, exit and correction, and an exclusion reaches
 * it only as the exit it eventually becomes - so this check cannot subtract that
 * case and does not pretend to. A board that has excluded somebody decides what
 * to do with their motion on facts the platform does not hold.
 *
 * ## The deadline is stated, never enforced
 *
 * See `motion-deadline.ts`. The bylaws' deadline is the condition on the right to
 * have an item taken up at a *particular* meeting, not a condition on the
 * association's ability to receive one, so a late motion is taken and the board
 * triages. Nothing here refuses on a date.
 *
 * ## The meeting it is taken up at
 *
 * {@link setMeeting} is the board's answer to which general meeting deals with
 * an item, and the notice to that meeting is what settles it: EFL 6 kap. 15 §
 * conditions the right on the request arriving in time for the item to be taken
 * up in the notice, and 6 kap. 22 § makes the notice state the matters to be
 * dealt with. So the link is writable while the meeting is still being arranged
 * and refused from the moment its notice has been issued.
 *
 * ## Free text
 *
 * The title and the body are scanned for a Swedish personal identity number and
 * refused if they carry one. Unlike an issue description - which is deliberately
 * neither scanned nor refused, because a report about a leak is exactly where a
 * third party's details turn up and refusing it would turn away the reports the
 * module exists for - a motion is written to be circulated: it goes into the
 * notice for the meeting, is read out in the room, and ends up in the minutes. A
 * personnummer in one is a disclosure the association cannot take back, so this
 * is a publication path and it carries the publication guardrail.
 */
@Injectable()
export class MotionService {
  private readonly logger = new Logger(MotionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Submits a motion, and records that a member exercised the right.
   *
   * The row and its audit entry are one transaction. A motion whose entry rolled
   * back would leave the member's own access report unable to show that they
   * submitted it, and the entry outlives the row by design - it is what answers
   * "I sent one in" once the purge has erased the motion itself.
   */
  async submit(
    principal: Principal,
    input: SubmitMotionInput,
  ): Promise<{ id: string }> {
    await this.requireMember(principal.personId);
    this.refusePersonalIdentityNumbers(input.title, input.body);

    const motion = await this.prisma.$transaction(async (tx) => {
      const created = await tx.motion.create({
        data: {
          title: input.title,
          body: input.body,
          submittedByPersonId: principal.personId,
        },
        select: { id: true },
      });

      await this.audit.record(
        {
          action: "MOTION_SUBMITTED",
          // Actor and subject are the same person: the right is theirs to
          // exercise and nobody submits on anybody's behalf.
          actorPersonId: principal.personId,
          targetPersonId: principal.personId,
          targetKind: "motion",
          targetId: created.id,
          // The identifier and the length of what was written. Not the title and
          // not a word of the body: the log is append-only and exempt from every
          // purge, so text copied into it would outlive the row it came from and
          // stay after the retention window erased the original.
          context: {
            titleLength: input.title.length,
            bodyLength: input.body.length,
          },
        },
        tx,
      );

      return created;
    });

    // The identifier and the act. What the member proposed is theirs and has no
    // business in a log line.
    this.logger.log(`Motion ${motion.id} submitted`);
    return motion;
  }

  /** The member's own motions, newest first, with the deadline that applies. */
  async intake(personId: string, now?: Date): Promise<MotionIntakeView> {
    const [deadline, motions] = await Promise.all([
      this.deadline(now),
      this.prisma.motion.findMany({
        where: { submittedByPersonId: personId },
        orderBy: { submittedAt: "desc" },
        select: MOTION_COLUMNS,
      }),
    ]);

    return { deadline, motions: motions.map(toOwnView) };
  }

  /**
   * Withdraws one's own motion.
   *
   * Only while it is open. Once the board has recorded that it received the
   * motion, taking it back is a matter for the board and the meeting rather than
   * a button - the item may already be in a notice that has been issued.
   *
   * Scoped to the caller's own motions in the same query that finds it, so a
   * motion belonging to somebody else answers exactly as one that does not
   * exist.
   */
  async withdraw(personId: string, motionId: string): Promise<OwnMotionView> {
    await this.requireMember(personId);

    const existing = await this.prisma.motion.findFirst({
      where: { id: motionId, submittedByPersonId: personId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      // Deliberately the same answer as a motion that was never submitted: see
      // the reasoning on MotionError.
      throw new MotionError("No such motion.", "motion-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new MotionError("This motion is no longer open.", "already-closed");
    }

    return this.close({
      motionId,
      status: "WITHDRAWN",
      actorPersonId: personId,
      subjectPersonId: personId,
      action: "MOTION_WITHDRAWN",
    });
  }

  /**
   * The board's queue, with the deadline that applies.
   *
   * Open motions first and oldest first within a status, because the queue is
   * worked from the top and the item that has been waiting longest is the one to
   * look at. SUBMITTED sorts before ACKNOWLEDGED and WITHDRAWN by the order the
   * enum declares, which is the order a board reads them in.
   */
  async queue(
    filter?: { status?: MotionStatus },
    now?: Date,
  ): Promise<MotionQueueView> {
    const [deadline, motions] = await Promise.all([
      this.deadline(now),
      this.prisma.motion.findMany({
        where: filter?.status === undefined ? {} : { status: filter.status },
        orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
        select: MOTION_COLUMNS,
      }),
    ]);

    const submitters = await this.submittersOf(motions);

    return {
      deadline,
      motions: motions.map((motion) => ({
        ...toOwnView(motion),
        closedByPersonId: motion.closedByPersonId,
        submitter: submitterOf(motion.submittedByPersonId, submitters),
      })),
    };
  }

  /**
   * Records that the board has received a motion and will put it to a meeting.
   *
   * Not an approval. Whether the meeting adopts the proposal is the meeting's
   * decision and is minuted there; what this records is that the item has been
   * taken up, which is the act EFL 6 kap. 15 § makes the board answerable for.
   */
  async acknowledge(
    motionId: string,
    actorPersonId: string,
  ): Promise<QueuedMotionView> {
    const existing = await this.prisma.motion.findUnique({
      where: { id: motionId },
      select: { id: true, status: true, submittedByPersonId: true },
    });
    if (existing === null) {
      throw new MotionError("No such motion.", "motion-not-found");
    }
    if (existing.status !== "SUBMITTED") {
      throw new MotionError("This motion is no longer open.", "already-closed");
    }

    const closed = await this.close({
      motionId,
      status: "ACKNOWLEDGED",
      actorPersonId,
      // The subject stays the member who submitted it, so their own access
      // report shows what the board did with their item rather than only what
      // they did themselves.
      subjectPersonId: existing.submittedByPersonId,
      action: "MOTION_ACKNOWLEDGED",
    });

    const submitters = await this.submittersOf([
      { submittedByPersonId: existing.submittedByPersonId },
    ]);

    return {
      ...closed,
      closedByPersonId: actorPersonId,
      submitter: submitterOf(existing.submittedByPersonId, submitters),
    };
  }

  /**
   * Records which general meeting takes this item up, or takes that answer back.
   *
   * The act EFL 6 kap. 15 § is about. A member's right is to have their item
   * taken up at a general meeting if the written request reaches the board in
   * time for it to be taken up in the notice to that meeting, and 6 kap. 22 §
   * makes the notice state the matters to be dealt with - so this is the board
   * answering "which meeting", and the notice is what settles the answer.
   *
   * Which is why it is refused once that notice has been issued. EFL 6 kap.
   * 25 § leaves the meeting unable to decide a matter the notice did not take up
   * without the consent of every member the failure affects, so a motion
   * attached afterwards would claim the meeting could deal with something the
   * members were never called to - and one detached afterwards would leave the
   * platform silent about an item the notice stated. Both are refused, which is
   * why the meeting being left is checked as well as the one being joined.
   *
   * A meeting recorded as held is refused for the same reason one step later. A
   * withdrawn motion is refused on different ground: the right is the member's
   * to exercise and taking it back is theirs too.
   *
   * One transaction, under the agenda lock of every meeting it decides about,
   * with the update conditional on the link *and* the state the caller read.
   * Each of the three carries a different failure.
   *
   * The lock is what makes the notice refusal a decision rather than a read a
   * notice can invalidate a moment later.
   *
   * The link condition is what makes two board members putting one item to two
   * meetings produce one link, with the loser answered exactly as a read would
   * have answered them.
   *
   * The state condition is what makes the withdrawal refusal above hold. The
   * withdrawal is the member's own act in a transaction of its own and takes no
   * key here - it is about the motion rather than about any meeting's agenda -
   * so at READ COMMITTED it can commit after that check and before this write.
   * Without the condition the board would be recording that it will take up a
   * request the member had already taken back, which is the one outcome the
   * refusal exists to prevent. The refusal is not deliberately symmetric: a
   * member withdrawing an item the board has already put to a meeting is
   * exercising their own right, and the platform records that state honestly,
   * whereas a board writing a new link onto a withdrawn request is an act with
   * nothing behind it.
   */
  async setMeeting(
    motionId: string,
    meetingId: string | null,
    actorPersonId: string,
  ): Promise<QueuedMotionView> {
    const motion = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.motion.findUnique({
        where: { id: motionId },
        select: {
          id: true,
          status: true,
          submittedByPersonId: true,
          meetingId: true,
        },
      });
      if (existing === null) {
        throw new MotionError("No such motion.", "motion-not-found");
      }
      if (existing.status === "WITHDRAWN") {
        throw new MotionError(
          "The member took this motion back, so it is not an item for a meeting.",
          "motion-withdrawn",
        );
      }

      /*
       * Both meetings, and before either is read. Sorted by the helper, because
       * a move holds two keys and two moves in opposite directions between one
       * pair of meetings would otherwise take them in opposite orders. Nothing
       * is taken when the motion is on no meeting and is being put to none:
       * there is no agenda for that request to decide about.
       */
      await lockMeetingAgendasInOrder(
        tx,
        [existing.meetingId, meetingId].filter(
          (id): id is string => id !== null,
        ),
      );

      if (existing.meetingId !== null) {
        await this.requireMeetingOpen(tx, existing.meetingId);
      }
      if (meetingId !== null && meetingId !== existing.meetingId) {
        await this.requireMeetingOpen(tx, meetingId);
      }

      const { count } = await tx.motion.updateMany({
        /*
         * Conditional on the link the caller read, so a request that moved the
         * item first is not silently overwritten by this one - and on the state,
         * so a withdrawal that committed since the check above cannot be written
         * over either. Both of the checks this method makes about the motion are
         * therefore decisions rather than reads something else can invalidate
         * before the write lands.
         */
        where: {
          id: motionId,
          meetingId: existing.meetingId,
          status: { not: "WITHDRAWN" },
        },
        data: { meetingId },
      });
      if (count === 0) {
        await this.refuseTheRaceThatWasLost(tx, motionId);
      }

      const updated = await tx.motion.findUniqueOrThrow({
        where: { id: motionId },
        select: MOTION_COLUMNS,
      });

      await this.audit.record(
        {
          action: "MOTION_MEETING_SET",
          actorPersonId,
          // The subject stays the member who submitted it, as at
          // acknowledgement: what the board did with their item has to be
          // answerable from their own access report.
          targetPersonId: existing.submittedByPersonId,
          targetKind: "motion",
          targetId: motionId,
          // Which meeting it moved to, or that it moved to none. Never the
          // motion's own text: the log is append-only and exempt from every
          // purge.
          context: { meetingId },
        },
        tx,
      );

      return updated;
    });

    this.logger.log(
      meetingId === null
        ? `Motion ${motionId} is on no meeting`
        : `Motion ${motionId} put to meeting ${meetingId}`,
    );

    const submitters = await this.submittersOf([motion]);
    return {
      ...toOwnView(motion),
      closedByPersonId: motion.closedByPersonId,
      submitter: submitterOf(motion.submittedByPersonId, submitters),
    };
  }

  /** The deadline the bylaws set, with the date it next falls on. */
  async deadline(now?: Date): Promise<MotionDeadlineView | null> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { motionDeadlineMonth: true, motionDeadlineDay: true },
    });
    if (association === null) {
      // No association row yet, so no bylaws to read a clause out of. Intake
      // stays open, which is what a missing clause means anyway.
      return null;
    }
    return motionDeadlineView(readMotionDeadline(association), now);
  }

  /**
   * Refuses a caller who is not a member of the association.
   *
   * The statutory check, asked of the register rather than of the principal: see
   * the class comment for why the capability alone is not enough. An active
   * residency with the MEMBER role is what membership is in this data model, and
   * it is the same derivation `PrincipalService` and the news mailing use.
   */
  private async requireMember(personId: string): Promise<void> {
    const now = new Date();
    const held = await this.prisma.residency.count({
      where: {
        personId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
      },
    });
    if (held === 0) {
      throw new MotionError(
        "Putting an item to the general meeting is a member's right.",
        "not-a-member",
      );
    }
  }

  /**
   * Says which of the update's conditions the caller lost, and refuses on it.
   *
   * The conditional update answers with a count and never with a reason, so the
   * row is read once more to tell the three cases apart. They are three
   * different things to tell a board member and only one of them is about a
   * meeting: the member took the item back, somebody else moved it, or it is no
   * longer there at all. Answering all three as one would send two of them
   * looking for a state the motion is not in.
   *
   * The read sees the newest committed row rather than the one the transaction
   * opened on, because each statement at READ COMMITTED takes its own snapshot -
   * which is what lets it report the write that beat this one.
   */
  private async refuseTheRaceThatWasLost(
    tx: Prisma.TransactionClient,
    motionId: string,
  ): Promise<never> {
    const now = await tx.motion.findUnique({
      where: { id: motionId },
      select: { status: true },
    });
    if (now === null) {
      throw new MotionError("No such motion.", "motion-not-found");
    }
    if (now.status === "WITHDRAWN") {
      throw new MotionError(
        "The member took this motion back, so it is not an item for a meeting.",
        "motion-withdrawn",
      );
    }
    throw new MotionError(
      "This motion has meanwhile been put to a different meeting.",
      "meeting-changed-meanwhile",
    );
  }

  /**
   * Refuses a meeting whose items are no longer the board's to change.
   *
   * Read under the meeting's agenda lock, which the caller takes before this
   * runs. Being inside the caller's transaction is not what makes the answer
   * hold: everything runs at READ COMMITTED, so a notice committing after this
   * read and before the write it guards would be invisible here and the write
   * would land anyway - a motion attached to a meeting whose agenda was already
   * frozen, with nothing in the database refusing it, because the notice is a
   * row in another table. The lock in `meetings/agenda-lock.ts` is the only
   * thing that closes that window, and it closes it only while every writer
   * takes the same key.
   *
   * Which is why this module imports one function from the meetings module. The
   * two facts needed here - whether the meeting has been held, and whether its
   * notice has been issued - are still columns read straight from the database
   * rather than through that module's service, so the motion queue does not
   * depend on the whole of it. What cannot be kept out is the key: a second
   * spelling of it here would be two locks that never meet, which is the one
   * mistake this lock cannot survive.
   */
  private async requireMeetingOpen(
    tx: Prisma.TransactionClient,
    meetingId: string,
  ): Promise<void> {
    const meeting = await tx.meeting.findUnique({
      where: { id: meetingId },
      select: { concludedAt: true, notice: { select: { id: true } } },
    });
    if (meeting === null) {
      throw new MotionError("No such general meeting.", "meeting-not-found");
    }
    if (meeting.notice !== null) {
      throw new MotionError(
        "The notice for that meeting has been issued, so what it deals with is settled.",
        "meeting-notice-issued",
      );
    }
    if (meeting.concludedAt !== null) {
      throw new MotionError(
        "That meeting has been recorded as held.",
        "meeting-already-held",
      );
    }
  }

  /**
   * Closes a motion one way or the other, with the entry in the same
   * transaction.
   *
   * The status and the closing date are written together and the update is
   * conditional on the motion still being open, so two clicks racing produce one
   * close: the loser's update matches no row and is answered exactly as a read
   * would have answered it.
   */
  private async close(input: {
    motionId: string;
    status: Extract<MotionStatus, "ACKNOWLEDGED" | "WITHDRAWN">;
    actorPersonId: string;
    subjectPersonId: string;
    action: "MOTION_ACKNOWLEDGED" | "MOTION_WITHDRAWN";
  }): Promise<OwnMotionView> {
    return this.prisma.$transaction(async (tx) => {
      const closedAt = new Date();
      const { count } = await tx.motion.updateMany({
        // Conditional on the state rather than on the primary key alone: this is
        // what makes the check above a decision instead of a read that something
        // else can invalidate before the write lands.
        where: { id: input.motionId, status: "SUBMITTED" },
        data: {
          status: input.status,
          closedAt,
          closedByPersonId: input.actorPersonId,
        },
      });
      if (count === 0) {
        throw new MotionError(
          "This motion is no longer open.",
          "already-closed",
        );
      }

      const motion = await tx.motion.findUniqueOrThrow({
        where: { id: input.motionId },
        select: MOTION_COLUMNS,
      });

      await this.audit.record(
        {
          action: input.action,
          actorPersonId: input.actorPersonId,
          targetPersonId: input.subjectPersonId,
          targetKind: "motion",
          targetId: input.motionId,
          // The state it moved to, and nothing it was carrying.
          context: { status: input.status },
        },
        tx,
      );

      this.logger.log(`Motion ${input.motionId} moved to ${input.status}`);
      return toOwnView(motion);
    });
  }

  /**
   * The people who submitted these motions, as the queue may name them.
   *
   * `submittedByPersonId` is a plain column and not a relation - which is what
   * lets the purge reach this table at all - so the persons are read in a query
   * of their own rather than joined off the motion.
   */
  private async submittersOf(
    motions: readonly { submittedByPersonId: string }[],
  ): Promise<
    Map<
      string,
      { firstName: string; lastName: string; protectedPersonalData: boolean }
    >
  > {
    const ids = [
      ...new Set(motions.map((motion) => motion.submittedByPersonId)),
    ];
    if (ids.length === 0) {
      return new Map();
    }

    const persons = await this.prisma.person.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    return new Map(persons.map((person) => [person.id, person]));
  }

  /**
   * Refuses a motion carrying a Swedish personal identity number.
   *
   * The same rule a page and a news item live under, and for the same reason: a
   * motion is circulated - into the notice, read out in the room, into the
   * minutes - so a personnummer in one is a disclosure the association cannot
   * take back, and it usually arrives pasted along with the text around it rather
   * than because anybody decided to publish it.
   *
   * The refusal names the field and the offset and never the value. What the scan
   * caught is precisely the thing that must not travel back in a response body.
   */
  private refusePersonalIdentityNumbers(title: string, body: string): void {
    const locations: MotionTextLocation[] = [
      ...scanForPersonalIdentityNumbers(title).map(
        (hit): MotionTextLocation => ({ part: "title", offset: hit.index }),
      ),
      ...scanForPersonalIdentityNumbers(body).map(
        (hit): MotionTextLocation => ({ part: "body", offset: hit.index }),
      ),
    ];

    if (locations.length > 0) {
      throw new MotionError(
        "The motion carries a personal identity number and cannot be stored.",
        "personal-identity-number",
        locations,
      );
    }
  }
}

const MOTION_COLUMNS = {
  id: true,
  title: true,
  body: true,
  status: true,
  submittedAt: true,
  submittedByPersonId: true,
  closedAt: true,
  closedByPersonId: true,
  meetingId: true,
  /*
   * The meeting itself and not only its identifier, because both views name it.
   * A real relation, unlike every person reference in this table, so it is
   * joined rather than read separately - see the schema for why a meeting may
   * carry a foreign key when a person may not.
   */
  meeting: {
    select: {
      id: true,
      kind: true,
      heldOn: true,
      notice: { select: { id: true } },
    },
  },
} as const;

interface MotionRecord {
  id: string;
  title: string;
  body: string;
  status: MotionStatus;
  submittedAt: Date;
  closedAt: Date | null;
  meeting: {
    id: string;
    kind: MeetingKind;
    heldOn: Date;
    notice: { id: string } | null;
  } | null;
}

function toOwnView(motion: MotionRecord): OwnMotionView {
  return {
    id: motion.id,
    title: motion.title,
    body: motion.body,
    status: motion.status,
    submittedAt: motion.submittedAt.toISOString(),
    closedAt: motion.closedAt?.toISOString() ?? null,
    meeting:
      motion.meeting === null
        ? null
        : {
            id: motion.meeting.id,
            kind: motion.meeting.kind,
            heldOn: formatLocalDay(localDayOfColumn(motion.meeting.heldOn)),
            summoned: motion.meeting.notice !== null,
          },
  };
}

function submitterOf(
  personId: string,
  persons: ReadonlyMap<
    string,
    { firstName: string; lastName: string; protectedPersonalData: boolean }
  >,
): MotionSubmitterView {
  const person = persons.get(personId);
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "member",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}
