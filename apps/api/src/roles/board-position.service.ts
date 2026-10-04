import { Injectable, Logger } from "@nestjs/common";
import { formatDateColumn, localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { BoardPositionType } from "../generated/prisma/enums";
import { boardSeatHeldOn, boardSeatNotEndedOn } from "../registers/held-on";
import {
  type BoardPositionView,
  hasTermEnded,
  earliestElection,
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
    const electedOn = parseCalendarDate(input.electedOn);
    if (electedOn.getTime() > latestElection(now).getTime()) {
      throw new RoleChangeError(
        "An election cannot be dated that far into the future. Check the year.",
        "elected-too-far-ahead",
      );
    }
    if (electedOn.getTime() < earliestElection(now).getTime()) {
      throw new RoleChangeError(
        "An election cannot be dated that far back. Check the year.",
        "elected-too-far-back",
      );
    }

    const seat = await this.prisma.$transaction(async (tx) => {
      await lockBoardRegister(tx);
      await lockBoardPositions(tx, input.personId);
      await refuseUnseatedActor(tx, input.actorPersonId, input.personId, now);

      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new RoleChangeError("No such person.", "person-not-found");
      }

      const held = await tx.boardPosition.findMany({
        where: { personId: input.personId, position: input.position },
        select: { id: true, electedOn: true, endedOn: true },
      });
      if (held.some((existing) => !hasTermEnded(existing, now))) {
        throw new RoleChangeError(
          "This person already holds that position. End the term before " +
            "recording a new election to it.",
          "position-already-held",
        );
      }
      if (overlapsRecordedTerm(held, electedOn)) {
        throw new RoleChangeError(
          "An earlier term in that position runs past this election date.",
          "term-overlaps",
        );
      }

      const created = await tx.boardPosition.create({
        data: {
          personId: input.personId,
          position: input.position,
          electedOn,
        },
      });

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

/**
 * Refuses a write to the board's seats by somebody who holds none, unless it
 * is the first board being recorded, and never on their own seat.
 *
 * Recording a seat is the board's own act (GLOSSARY, förtroendeuppdrag), and a
 * seat confers what no grant of capabilities carries (ADR 0017): an
 * administrator who could seat themselves would hold it by their own hand. The
 * administrator's `boardPosition:manage` is kept for one case, a register with
 * no board that could act yet, where somebody has to record the one the meeting
 * elected - all of it, and a correction to it, because a chair with no account
 * cannot record the seats beside their own.
 *
 * "A board that could act" is a seat that has not ended, held by a person who
 * can sign in. It is read from the whole register and not from the seats held
 * today, so the days between one board's end and the next one's start - an
 * incoming board recorded from a day still to come - are not a window: those
 * seats are the board's. Once one exists the board keeps its own register.
 *
 * Counted under {@link lockBoardRegister}, which the caller holds.
 */
async function refuseUnseatedActor(
  tx: Prisma.TransactionClient,
  actorPersonId: string,
  targetPersonId: string,
  now: Date,
): Promise<void> {
  const today = localDayOf(now);
  const actorSeated = await tx.boardPosition.count({
    where: { personId: actorPersonId, ...boardSeatHeldOn(today) },
  });
  if (actorSeated > 0) {
    return;
  }
  if (actorPersonId === targetPersonId) {
    throw new RoleChangeError(
      "A seat on the board is recorded by the board, not by the person it " +
        "seats.",
      "board-seat-required",
    );
  }
  const candidates = await tx.boardPosition.findMany({
    where: {
      ...boardSeatNotEndedOn(today),
      person: { userAccount: { isNot: null } },
    },
    select: { electedOn: true, endedOn: true },
  });
  // A withdrawn election that is still dated ahead has not ended by its date
  // but covers no day, and is no board.
  if (candidates.some((seat) => !hasTermEnded(seat, now))) {
    throw new RoleChangeError(
      "Only a board member records the board's seats once a board has been " +
        "elected.",
      "board-seat-required",
    );
  }
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
