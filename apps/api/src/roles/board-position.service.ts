import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { BoardPositionType } from "../generated/prisma/enums";
import {
  type BoardPositionView,
  isHeldOn,
  parseCalendarDate,
  refuseTermEnd,
  RoleChangeError,
  type TermEndRefusal,
  toCalendarDate,
} from "./role-changes";
import { lockBoardPositions } from "./role-lock";

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
 * Positions of trust (fortroendeuppdrag): who sits on the board, and when they
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
 * election. Recording a second election onto a seat that is still held is
 * refused rather than merged, because a single row cannot carry two elections
 * and merging them would silently drop whichever date the row kept.
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

    const seat = await this.prisma.$transaction(async (tx) => {
      await lockBoardPositions(tx, input.personId);

      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new RoleChangeError("No such person.", "person-not-found");
      }

      const held = await tx.boardPosition.findMany({
        where: { personId: input.personId, position: input.position },
        select: { id: true, endedOn: true },
      });
      if (held.some((existing) => isHeldOn(existing, now))) {
        throw new RoleChangeError(
          "This person already holds that position. End the term before " +
            "recording a new election to it.",
          "position-already-held",
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
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          targetKind: "boardPosition",
          targetId: created.id,
          context: {
            position: input.position,
            electedOn: toCalendarDate(created.electedOn),
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

      await lockBoardPositions(tx, existing.personId);

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
          actorPersonId: input.actorPersonId,
          targetPersonId: existing.personId,
          targetKind: "boardPosition",
          targetId: existing.id,
          context: {
            position: existing.position,
            // The period the seat covered, which is what a later question about
            // who answered for the association is asked against.
            electedOn: toCalendarDate(existing.electedOn),
            endedOn: input.endedOn,
            previousEndedOn:
              existing.endedOn === null
                ? null
                : toCalendarDate(existing.endedOn),
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
    electedOn: toCalendarDate(seat.electedOn),
    endedOn: seat.endedOn === null ? null : toCalendarDate(seat.endedOn),
  };
}
