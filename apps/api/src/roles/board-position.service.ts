import { Injectable, Logger } from "@nestjs/common";
import { dateColumnOf, formatDateColumn, localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { BoardPosition, Prisma } from "../generated/prisma/client";
import type { BoardPositionType } from "../generated/prisma/enums";
import { holdsBoardSeat } from "../mail/board-recipients";
import { boardSeatNotEndedOn } from "../registers/held-on";
import {
  type BoardPositionView,
  hasTermEnded,
  latestElection,
  overlapsRecordedTerm,
  parseCalendarDate,
  refuseTermEnd,
  RoleChangeError,
  type TermEndRefusal,
} from "./role-changes";
import { lockBoardPositions, lockBoardRegister } from "./role-lock";

/**
 * The sentence each end-of-term refusal carries.
 *
 * A total map, so a refusal added to the rule and not given words fails the
 * build rather than reaching a caller as a bare code.
 */
const TERM_END_MESSAGE: Record<TermEndRefusal, string> = {
  "term-already-ended":
    "That term has already ended. Its dates are the record of a period " +
    "that has run and they stand.",
  "ended-before-elected":
    "A term cannot end before the election that began it.",
  "ended-too-far-ahead":
    "A term cannot be recorded as running that far into the future. Check " +
    "the year.",
};

export interface ElectInput {
  personId: string;
  position: BoardPositionType;
  /** ISO calendar date: the day the general meeting elected them. */
  electedOn: string;
  actorPersonId: string;
}

/** One seat of the board a recovery records. */
export interface RecoveredSeat {
  personId: string;
  position: BoardPositionType;
  /** ISO calendar date: the day the general meeting elected them. */
  electedOn: string;
}

export interface RecoverBoardInput {
  seats: readonly RecoveredSeat[];
  /**
   * Why the board is recorded this way rather than by the board. Kept in the
   * audit log for good, with every seat the recovery records.
   */
  reason: string;
  actorPersonId: string;
}

export interface EndTermInput {
  boardPositionId: string;
  /**
   * ISO calendar date. May be in the future, within the horizon
   * {@link refuseTermEnd} bounds: a term can be recorded as running until the
   * annual meeting.
   */
  endedOn: string;
  actorPersonId: string;
}

/**
 * Positions of trust (förtroendeuppdrag): who sits on the board, and when they
 * did.
 *
 * The table is history rather than state. A term is not a flag that is on or
 * off but a period with two ends, so nothing here deletes a row: ending a term
 * writes the date it ended and leaves the period it covered on file. That is
 * what lets the association answer, next year or in five, who answered for it
 * when a decision was taken - and it is the same reason the member register
 * appends an EXIT rather than removing an ENTRY.
 *
 * Which is also why an election carries a date the caller gives rather than
 * today's. The board is elected at the general meeting (foreningsstamma) and
 * the row is written afterwards, from the minutes; a record that stamped the
 * day somebody got round to typing it in would hold the typing rather than the
 * election.
 *
 * Re-election is two acts and not one: end the term, then record the new
 * election. Recording a second election onto a seat whose term has not ended -
 * one held today, or one recorded from a day still to come - is refused rather
 * than merged, because a single row cannot carry two elections and merging them
 * would silently drop whichever date the row kept.
 *
 * Every write is audited in the transaction that made it, like every other act
 * on the register.
 */
@Injectable()
export class BoardPositionService {
  private readonly logger = new Logger(BoardPositionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every position this person has ever held, most recent election first. */
  async forPerson(personId: string): Promise<BoardPositionView[]> {
    const seats = await this.prisma.boardPosition.findMany({
      where: { personId },
      orderBy: [{ electedOn: "desc" }],
    });
    return seats.map(toView);
  }

  /**
   * Records an election to a position of trust.
   *
   * The lock is taken before the person's other seats are read, because the
   * refusal below is decided by a query whose answer the insert changes. Two
   * elections to the same chair arriving together would otherwise both find it
   * free.
   */
  async elect(
    input: ElectInput,
    now: Date = new Date(),
  ): Promise<BoardPositionView> {
    const electedOn = parseElectionDate(input.electedOn, now);

    const seat = await this.prisma.$transaction(async (tx) => {
      await lockBoardRegister(tx);
      await lockBoardPositions(tx, input.personId);
      await refuseUnseatedActor(tx, input.actorPersonId, input.personId, now);

      const created = await recordSeat(
        tx,
        { personId: input.personId, position: input.position, electedOn },
        now,
      );

      /*
       * In the same transaction as the seat it records. The position and the
       * date are facts about the act rather than a copy of anything with a life
       * of its own, so they belong in the context; the seat itself is named by
       * targetKind and targetId, which is where the row is read back from.
       */
      await this.audit.record(
        {
          action: "BOARD_POSITION_ELECTED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          targetKind: "boardPosition",
          targetId: created.id,
          context: {
            position: input.position,
            electedOn: formatDateColumn(created.electedOn),
          },
        },
        tx,
      );

      return created;
    });

    this.logger.log(
      `Recorded ${input.position} for person ${input.personId} from ${input.electedOn}`,
    );
    return toView(seat);
  }

  /**
   * Whether the register is vacant: no seat held today and none recorded from a
   * day still to come. The one state in which {@link recoverBoard} records.
   *
   * Read without the lock, so it is an answer for a screen deciding what to
   * offer and not a permission: the recovery reads it again under the lock.
   */
  async isVacant(now: Date = new Date()): Promise<boolean> {
    return isRegisterVacant(this.prisma, now);
  }

  /**
   * Records a board on a vacant register, for somebody who holds no seat:
   * återställning av styrelsen, board recovery (GLOSSARY).
   *
   * Recording a seat is the board's own act, so {@link elect} and
   * {@link endTerm} refuse anybody without a seat. That leaves a register on
   * which every term has ended with nobody who may write it, and the only way
   * out would be the database. This is the way out instead, and it is narrow on
   * purpose:
   *
   * - only while the register is vacant, read under the register lock: no seat
   *   held today and none recorded ahead. An incoming board recorded from a
   *   later date is a board, and the days before it begins are not a way in;
   * - only seats dated today or earlier: a seat dated ahead would end the
   *   vacancy while nobody holds a seat, and with nobody to record, end or
   *   recover a term the register would stay shut until that day;
   * - never the actor's own seat, so nobody holds a seat by their own hand;
   * - always with a stated reason, kept with every seat in the audit log under
   *   an action of its own, so the log tells a recovery from an election the
   *   board recorded.
   *
   * The whole board in one act, because the first seat recorded ends the
   * vacancy: a chair recorded alone would leave the seats beside theirs to a
   * board that may have no account yet. One seat is also a board, and the
   * person seated records the rest once they sign in. All the seats or none:
   * a refusal of any one of them writes nothing.
   *
   * Corrections are the board's, through {@link endTerm}: once this commits the
   * register is no longer vacant.
   */
  async recoverBoard(
    input: RecoverBoardInput,
    now: Date = new Date(),
  ): Promise<BoardPositionView[]> {
    const reason = input.reason.trim();
    if (reason === "") {
      throw new RoleChangeError(
        "A board recovery needs a stated reason.",
        "reason-required",
      );
    }
    if (input.seats.some((seat) => seat.personId === input.actorPersonId)) {
      throw new RoleChangeError(OWN_SEAT_MESSAGE, "board-seat-required");
    }
    const seats = input.seats.map((seat) => ({
      personId: seat.personId,
      position: seat.position,
      electedOn: parseRecoveredElectionDate(seat.electedOn, now),
    }));

    const recorded = await this.prisma.$transaction(async (tx) => {
      await lockBoardRegister(tx);
      // Sorted, so two writers naming the same people take their locks in the
      // same order and cannot each hold one the other waits for.
      const personIds = [...new Set(seats.map((seat) => seat.personId))];
      for (const personId of personIds.sort()) {
        await lockBoardPositions(tx, personId);
      }

      if (!(await isRegisterVacant(tx, now))) {
        throw new RoleChangeError(
          "A board is recorded on the register. Only a board member records " +
            "its seats.",
          "board-not-vacant",
        );
      }

      const created: BoardPosition[] = [];
      for (const seat of seats) {
        // One at a time, so a seat listed twice meets the first as a position
        // already held.
        created.push(await recordSeat(tx, seat, now));
      }

      /*
       * One entry per seat, so each person's access report shows the act that
       * seated them. The reason is the permitted free text of an audit entry -
       * the actor's own statement, with no other home - and the endpoint bounds
       * its length. `seats` says how many the one act recorded.
       */
      for (const seat of created) {
        await this.audit.record(
          {
            action: "BOARD_RECOVERY_RECORDED",
            channel: "WEB",
            actorPersonId: input.actorPersonId,
            targetPersonId: seat.personId,
            targetKind: "boardPosition",
            targetId: seat.id,
            context: {
              position: seat.position,
              electedOn: formatDateColumn(seat.electedOn),
              seats: created.length,
              reason,
            },
          },
          tx,
        );
      }

      return created;
    });

    this.logger.warn(
      `Board recovery by person ${input.actorPersonId} recorded ${String(
        recorded.length,
      )} seat(s)`,
    );
    return recorded.map(toView);
  }

  /**
   * Says when a term ends, by writing the date onto the seat.
   *
   * Never a delete. The row is the record that this person answered for the
   * association between two dates, and the board roster, the data subject
   * access report and anybody asking who signed a decision all read it.
   *
   * A date in the future is allowed and is not a special case: the principal
   * treats a seat as held until its end date passes, so a board recording in
   * April that a term runs to the annual meeting keeps the person's access
   * until then, and nobody has to remember to come back and press a button.
   *
   * Which is also why this writes the date of a term that already carries a
   * future one rather than refusing it. A future end date is a statement about
   * a term still running, and a statement that cannot be corrected is a typed
   * year the board would have to reach the database to undo - while the seat
   * went on conferring what a seat confers. So the seat is amendable for as
   * long as it is held, and settled once its date has passed.
   *
   * @param now the moment the term is judged against. Taken as a parameter for
   * the same reason {@link elect} takes one: the rule turns on it, and a rule
   * that reads the clock itself is a rule that can only be tested by waiting.
   */
  async endTerm(
    input: EndTermInput,
    now: Date = new Date(),
  ): Promise<BoardPositionView> {
    const endedOn = parseCalendarDate(input.endedOn);

    const seat = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.boardPosition.findUnique({
        where: { id: input.boardPositionId },
      });
      if (existing === null) {
        throw new RoleChangeError(
          "No such position of trust.",
          "board-position-not-found",
        );
      }

      await lockBoardRegister(tx);
      await lockBoardPositions(tx, existing.personId);
      await refuseUnseatedActor(
        tx,
        input.actorPersonId,
        existing.personId,
        now,
      );

      const refusal = refuseTermEnd({
        electedOn: existing.electedOn,
        currentEndedOn: existing.endedOn,
        endedOn,
        now,
      });
      if (refusal !== null) {
        throw new RoleChangeError(TERM_END_MESSAGE[refusal], refusal);
      }

      /*
       * Conditional on the seat still carrying the date this transaction read,
       * so two people writing an end date at once produce one date rather than
       * the second overwriting the first. The loser matches no rows and is
       * refused with the same conflict the read above would have given it.
       *
       * `endedOn: null` in a filter is IS NULL, so the open case is the same
       * condition rather than a second one: two people ending an open term
       * race exactly as two people amending a dated one do.
       */
      const written = await tx.boardPosition.updateMany({
        where: { id: input.boardPositionId, endedOn: existing.endedOn },
        data: { endedOn },
      });
      if (written.count === 0) {
        throw new RoleChangeError(
          TERM_END_MESSAGE["term-already-ended"],
          "term-already-ended",
        );
      }

      /*
       * One action for both writes, with the date it replaced beside the date
       * it wrote. The act is the same one - saying when this term ends - and a
       * second name for it would claim two kinds of act where there is one;
       * what a reader of the log needs is what the seat said before, which is
       * the fact rather than the name.
       */
      await this.audit.record(
        {
          action: "BOARD_POSITION_ENDED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: existing.personId,
          targetKind: "boardPosition",
          targetId: existing.id,
          context: {
            position: existing.position,
            // The period the seat covered, which is what a later question about
            // who answered for the association is asked against.
            electedOn: formatDateColumn(existing.electedOn),
            endedOn: input.endedOn,
            previousEndedOn:
              existing.endedOn === null
                ? null
                : formatDateColumn(existing.endedOn),
          },
        },
        tx,
      );

      return { ...existing, endedOn };
    });

    this.logger.log(
      `Ended ${seat.position} for person ${seat.personId} on ${input.endedOn}`,
    );
    return toView(seat);
  }
}

const OWN_SEAT_MESSAGE =
  "A seat on the board is recorded by the board, not by the person it seats.";

/** An election date, refused when it lies past the election horizon. */
function parseElectionDate(value: string, now: Date): Date {
  const electedOn = parseCalendarDate(value);
  if (electedOn.getTime() > latestElection(now).getTime()) {
    throw new RoleChangeError(
      "An election cannot be dated that far into the future. Check the year.",
      "elected-too-far-ahead",
    );
  }
  return electedOn;
}

/**
 * The election date of a recovered seat: an election date that is not after
 * today either.
 *
 * A recovery records a board that holds its seats now. A seat dated ahead
 * would end the vacancy without seating anybody, and until its day arrived
 * nobody could record, end or recover a term. An incoming board recorded
 * ahead is the board's to record once it has a seat.
 */
function parseRecoveredElectionDate(value: string, now: Date): Date {
  const electedOn = parseElectionDate(value, now);
  if (electedOn.getTime() > dateColumnOf(localDayOf(now)).getTime()) {
    throw new RoleChangeError(
      "A recovered seat cannot be dated after today. Record the day the " +
        "meeting elected the board.",
      "recovery-dated-ahead",
    );
  }
  return electedOn;
}

/**
 * Writes one seat, after the refusals every election meets whoever records
 * it. The caller holds the person's lock and writes the audit entry.
 */
async function recordSeat(
  tx: Prisma.TransactionClient,
  seat: { personId: string; position: BoardPositionType; electedOn: Date },
  now: Date,
): Promise<BoardPosition> {
  const person = await tx.person.findUnique({
    where: { id: seat.personId },
    select: { id: true },
  });
  if (person === null) {
    throw new RoleChangeError("No such person.", "person-not-found");
  }

  const held = await tx.boardPosition.findMany({
    where: { personId: seat.personId, position: seat.position },
    select: { id: true, electedOn: true, endedOn: true },
  });
  if (held.some((existing) => !hasTermEnded(existing, now))) {
    throw new RoleChangeError(
      "This person already holds that position. End the term before " +
        "recording a new election to it.",
      "position-already-held",
    );
  }
  if (overlapsRecordedTerm(held, seat.electedOn)) {
    throw new RoleChangeError(
      "An earlier term in that position runs past this election date.",
      "term-overlaps",
    );
  }

  return tx.boardPosition.create({
    data: {
      personId: seat.personId,
      position: seat.position,
      electedOn: seat.electedOn,
    },
  });
}

/**
 * Whether no seat is held today and none is recorded from a day still to come.
 *
 * Read from the whole register and not from the seats held today, so the days
 * between one board's end and the next one's start are not a vacancy: the
 * incoming seats are the board's. Whether a holder can sign in does not enter
 * into it - a board whose members have not activated their accounts is a board,
 * and the administrator invites them rather than recording another.
 */
async function isRegisterVacant(
  client: Pick<Prisma.TransactionClient, "boardPosition">,
  now: Date,
): Promise<boolean> {
  const notEnded = await client.boardPosition.findMany({
    where: boardSeatNotEndedOn(localDayOf(now)),
    select: { electedOn: true, endedOn: true },
  });
  // A withdrawn election that is still dated ahead has not ended by its date
  // but covers no day, and is no board.
  return notEnded.every((seat) => hasTermEnded(seat, now));
}

/**
 * Refuses a write to the board's seats by somebody who holds none today.
 *
 * Recording a seat is the board's own act (GLOSSARY, förtroendeuppdrag), and a
 * seat confers what no grant of capabilities carries (ADR 0017): an
 * administrator who could seat themselves would hold it by their own hand, and
 * one who could seat somebody else on the strength of the grant alone would be
 * choosing the board. So neither an election nor an end date is written for an
 * actor with no seat, whatever state the register is in. A register with no
 * board at all is recorded through {@link BoardPositionService.recoverBoard},
 * which is its own act with its own audit entry and a stated reason.
 *
 * Counted under {@link lockBoardRegister}, which the caller holds.
 */
async function refuseUnseatedActor(
  tx: Prisma.TransactionClient,
  actorPersonId: string,
  targetPersonId: string,
  now: Date,
): Promise<void> {
  if (await holdsBoardSeat(tx, actorPersonId, now)) {
    return;
  }
  if (actorPersonId === targetPersonId) {
    throw new RoleChangeError(OWN_SEAT_MESSAGE, "board-seat-required");
  }
  throw new RoleChangeError(
    "Only a board member records the board's seats. A register with no board " +
      "is recorded through a board recovery.",
    "board-seat-required",
  );
}

function toView(seat: {
  id: string;
  personId: string;
  position: BoardPositionType;
  electedOn: Date;
  endedOn: Date | null;
}): BoardPositionView {
  return {
    boardPositionId: seat.id,
    personId: seat.personId,
    position: seat.position,
    electedOn: formatDateColumn(seat.electedOn),
    endedOn: seat.endedOn === null ? null : formatDateColumn(seat.endedOn),
  };
}
