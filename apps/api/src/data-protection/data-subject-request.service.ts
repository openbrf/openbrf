import { Injectable } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type {
  DataSubjectRequestDecision,
  DataSubjectRequestKind,
  ErasureException,
  ErasureGround,
} from "../generated/prisma/enums";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { lockDataSubjectRequests } from "./data-subject-request-lock";
import { DataSubjectRequestError } from "./data-subject-request.error";
import {
  toDataSubjectRequestView,
  type DataSubjectRequestView,
} from "./data-subject-request";

const REQUEST_SELECT = {
  id: true,
  personId: true,
  kind: true,
  requestedOn: true,
  ground: true,
  erasureGround: true,
  issueId: true,
  decision: true,
  erasureException: true,
  decisionGround: true,
  decidedAt: true,
  decidedByPersonId: true,
  executedAt: true,
  closedAt: true,
  closeReason: true,
  closedByPersonId: true,
  recordedByPersonId: true,
} as const;

/**
 * What a person asked about their own data, recorded and decided by the board.
 *
 * Erasure (GDPR art. 17), objection (art. 21) and restriction (art. 18) are one
 * service because they are one conversation with one person on one clock:
 * art. 12(3) gives a month from the request whichever right was exercised, and
 * art. 12(4) requires a refusal to carry its reasons. Splitting them into three
 * would mean three places that answer the same question about the same person.
 *
 * ## Who records a request
 *
 * The board, on the person's behalf. A person exercises art. 20 themselves,
 * from their own profile, because an export is a copy of what they already
 * gave; the other three are decisions the association has to make and be
 * answerable for, so what the product records is the decision and its grounds
 * rather than a form somebody filled in.
 *
 * ## What a grant does, and what it does not
 *
 * An objection or a restriction takes effect the moment it is granted: a dated
 * flag on the person, which the mailers, the directory, the roster, the plugin
 * reads and every purge consult. Erasure takes effect on the next nightly run.
 * That is deliberate and not a queue: the purge is the one piece of code that
 * knows what service data is, and a second eraser written beside it would be
 * the place the two drifted apart.
 *
 * ## Why a grant can be refused by the platform
 *
 * The reason codes for a residency, a board seat, a system role, a hold or a
 * restriction are not the board being overruled. They are the platform
 * declining to record a grant the purge could not carry out - which would leave
 * a person told their data was erased and a row saying so, with the data still
 * there. The board's own refusal is a REFUSED decision with its ground, which
 * is what art. 12(4) asks for.
 */
@Injectable()
export class DataSubjectRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every request about one person, newest first. */
  async forPerson(
    personId: string,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      where: { personId },
      orderBy: [{ requestedOn: "desc" }, { createdAt: "desc" }],
      select: REQUEST_SELECT,
    });
    return rows.map((row) => toDataSubjectRequestView(row, now));
  }

  /** Every request the board has to look at, the open ones first. */
  async list(now: Date = new Date()): Promise<DataSubjectRequestView[]> {
    const rows = await this.prisma.dataSubjectRequest.findMany({
      orderBy: [{ closedAt: "asc" }, { requestedOn: "asc" }],
      select: REQUEST_SELECT,
    });
    return rows.map((row) => toDataSubjectRequestView(row, now));
  }

  /**
   * Records what a person has asked for.
   *
   * The art. 17(1) ground is required on an erasure and refused on the other
   * two kinds, because which alternative the person invokes decides what the
   * board has to weigh: consent withdrawn is answered by asking whether another
   * basis remains, an objection upheld by art. 21, no longer necessary by the
   * purpose the data was collected for.
   *
   * An issue may be named, and only on an erasure. That is the case of a person
   * whose name appears in free text somebody else wrote: the request is about
   * their data all the same, it is decided here, and what is then done to the
   * text is the board's own act on the issue - the purge never rewrites a
   * description.
   */
  async record(input: {
    personId: string;
    kind: DataSubjectRequestKind;
    requestedOn: Date;
    ground: string;
    erasureGround?: ErasureGround | null;
    issueId?: string | null;
    actorPersonId: string;
  }): Promise<DataSubjectRequestView> {
    const person = await this.prisma.person.findUnique({
      where: { id: input.personId },
      select: { id: true },
    });
    if (person === null) {
      throw new DataSubjectRequestError(
        "There is no such person.",
        "person-not-found",
      );
    }

    const erasureGround = input.erasureGround ?? null;
    if (input.kind === "ERASURE" && erasureGround === null) {
      throw new DataSubjectRequestError(
        "An erasure request states the ground in art. 17(1) it rests on.",
        "erasure-ground-required",
      );
    }
    if (input.kind !== "ERASURE" && erasureGround !== null) {
      throw new DataSubjectRequestError(
        "An art. 17(1) ground belongs to an erasure request alone.",
        "ground-not-applicable",
      );
    }

    const issueId = input.issueId ?? null;
    if (issueId !== null) {
      if (input.kind !== "ERASURE") {
        throw new DataSubjectRequestError(
          "Only an erasure request is about an issue.",
          "issue-kind-inconsistent",
        );
      }
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        select: { id: true },
      });
      if (issue === null) {
        throw new DataSubjectRequestError(
          "There is no such issue.",
          "issue-not-found",
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await lockDataSubjectRequests(tx, input.personId);

      /*
       * One live request of a kind at a time. Two open erasure requests would
       * make "granted" ambiguous - the purge reads the oldest, and a board
       * closing one would look like closing the person's request - and the
       * question the board is answering is whether this person's erasure
       * stands, not how many times they asked.
       *
       * Read inside the transaction and under the lock, because the check that
       * counts is the one taken with the rows held: two recordings arriving
       * together would otherwise both read no open request and both create one.
       */
      const open = await tx.dataSubjectRequest.findFirst({
        where: {
          personId: input.personId,
          kind: input.kind,
          closedAt: null,
          OR: [{ decision: null }, { decision: "GRANTED" }],
        },
        select: { id: true },
      });
      if (open !== null) {
        throw new DataSubjectRequestError(
          "This person already has a request of that kind open.",
          "already-open",
        );
      }

      const row = await tx.dataSubjectRequest.create({
        data: {
          personId: input.personId,
          kind: input.kind,
          requestedOn: input.requestedOn,
          ground: input.ground,
          erasureGround,
          issueId,
          recordedByPersonId: input.actorPersonId,
        },
        select: REQUEST_SELECT,
      });

      /*
       * The kind, the dates and the ground as a code. Never what the person
       * wrote: the log is append-only and exempt from every purge, so their own
       * words copied in here would be the one copy an erasure could not reach.
       */
      await this.audit.record(
        {
          action: "DATA_SUBJECT_REQUEST_RECORDED",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          targetKind: "dataSubjectRequest",
          targetId: row.id,
          context: {
            kind: input.kind,
            requestedOn: input.requestedOn.toISOString().slice(0, 10),
            erasureGround,
            issueReferenced: issueId !== null,
          },
        },
        tx,
      );

      return toDataSubjectRequestView(row, new Date());
    });
  }

  /**
   * Grants or refuses a request.
   *
   * Three locks, in the order every writer in the product takes them - the
   * person's own requests, then hold, then residency - so that what this reads
   * about the person is still true when it commits. A hold placed while the
   * board was deciding has to win, and so does a move-in.
   */
  async decide(
    requestId: string,
    input: {
      decision: DataSubjectRequestDecision;
      ground: string;
      erasureException?: ErasureException | null;
      actorPersonId: string;
    },
  ): Promise<DataSubjectRequestView> {
    const existing = await this.prisma.dataSubjectRequest.findUnique({
      where: { id: requestId },
      select: { id: true, personId: true, kind: true, decision: true },
    });
    if (existing === null) {
      throw new DataSubjectRequestError(
        "There is no such request.",
        "request-not-found",
      );
    }

    const erasureException = input.erasureException ?? null;
    if (existing.kind === "ERASURE") {
      if (erasureException === null) {
        throw new DataSubjectRequestError(
          "A decision on an erasure records the art. 17(3) assessment.",
          "erasure-exception-required",
        );
      }
      if (input.decision === "GRANTED" && erasureException !== "NONE") {
        /*
         * An art. 17(3) exception is what disapplies the right. A grant that
         * also named one would be the record of a decision that contradicts
         * itself, and the record is the whole point.
         */
        throw new DataSubjectRequestError(
          "An exception under art. 17(3) refuses a request rather than granting it.",
          "exception-inconsistent",
        );
      }
    } else if (erasureException !== null) {
      throw new DataSubjectRequestError(
        "The art. 17(3) assessment belongs to an erasure alone.",
        "exception-not-applicable",
      );
    }

    if (input.ground.trim() === "") {
      // art. 12(4) for a refusal, and for a grant the ground the board relied
      // on, which the box on the roadmap asks the record to carry.
      throw new DataSubjectRequestError(
        "A decision states the ground it rests on.",
        "decision-ground-required",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await lockDataSubjectRequests(tx, existing.personId);
      await lockLegalHold(tx, existing.personId);
      await lockResidencyTransitions(tx, existing.personId);

      const row = await tx.dataSubjectRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { ...REQUEST_SELECT, decision: true },
      });
      if (row.decision !== null || row.closedAt !== null) {
        throw new DataSubjectRequestError(
          "This request has already been decided.",
          "already-decided",
        );
      }

      if (row.kind === "ERASURE" && input.decision === "GRANTED") {
        await this.assertErasable(tx, existing.personId);
      }

      const now = new Date();
      const decided = await tx.dataSubjectRequest.update({
        where: { id: requestId },
        data: {
          decision: input.decision,
          erasureException,
          decisionGround: input.ground,
          decidedAt: now,
          decidedByPersonId: input.actorPersonId,
        },
        select: REQUEST_SELECT,
      });

      /*
       * A granted objection or restriction takes effect here, as a dated flag
       * the mailers and the purges read. Erasure writes nothing on the person:
       * the purge finds the request itself, which keeps one place deciding what
       * service data is.
       */
      if (input.decision === "GRANTED" && row.kind === "OBJECTION") {
        await tx.person.update({
          where: { id: existing.personId },
          data: { communicationObjectionAt: now },
        });
      }
      if (input.decision === "GRANTED" && row.kind === "RESTRICTION") {
        await tx.person.update({
          where: { id: existing.personId },
          data: { processingRestrictedAt: now },
        });
      }

      await this.audit.record(
        {
          action: "DATA_SUBJECT_REQUEST_DECIDED",
          actorPersonId: input.actorPersonId,
          targetPersonId: existing.personId,
          targetKind: "dataSubjectRequest",
          targetId: requestId,
          // Codes only. The board's reasons stay on the row, where art. 12(4)
          // needs them readable and correctable.
          context: {
            kind: row.kind,
            decision: input.decision,
            erasureException,
          },
        },
        tx,
      );

      return toDataSubjectRequestView(decided, now);
    });
  }

  /**
   * Closes a request: an objection withdrawn, a restriction lifted, an erasure
   * the person no longer wants.
   *
   * The flag is cleared only when no other granted, open request of that kind
   * remains, so closing one of two does not quietly lift the other.
   */
  async close(
    requestId: string,
    input: { reason?: string | null; actorPersonId: string },
  ): Promise<DataSubjectRequestView> {
    return this.prisma.$transaction(async (tx) => {
      /*
       * Whose requests these are, so the lock has a key. Read first and then
       * read again under the lock: the count `clearFlagIfLast` takes below
       * decides whether a person's art. 18(2) restriction stays in force, and
       * a grant committing beside it would otherwise have its flag cleared.
       */
      const owner = await tx.dataSubjectRequest.findUnique({
        where: { id: requestId },
        select: { personId: true },
      });
      if (owner === null) {
        throw new DataSubjectRequestError(
          "There is no such request.",
          "request-not-found",
        );
      }
      await lockDataSubjectRequests(tx, owner.personId);

      const row = await tx.dataSubjectRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: REQUEST_SELECT,
      });
      if (row.closedAt !== null) {
        throw new DataSubjectRequestError(
          "This request is already closed.",
          "already-closed",
        );
      }

      const now = new Date();
      const closed = await tx.dataSubjectRequest.update({
        where: { id: requestId },
        data: {
          closedAt: now,
          closeReason: input.reason ?? null,
          closedByPersonId: input.actorPersonId,
        },
        select: REQUEST_SELECT,
      });

      await this.clearFlagIfLast(tx, row.personId, row.kind, requestId);

      await this.audit.record(
        {
          action: "DATA_SUBJECT_REQUEST_CLOSED",
          actorPersonId: input.actorPersonId,
          targetPersonId: row.personId,
          targetKind: "dataSubjectRequest",
          targetId: requestId,
          context: { kind: row.kind, executed: row.executedAt !== null },
        },
        tx,
      );

      return toDataSubjectRequestView(closed, now);
    });
  }

  /**
   * Closes a granted, unexecuted erasure request because the person has moved
   * in again.
   *
   * Called by the move-in inside its own transaction, under the residency lock
   * it already holds. Without it such a request would stand for ever: the purge
   * refuses anybody with a current residency, so the request would never be
   * executed and never be closed, and the person's page would keep saying their
   * data was about to be erased.
   *
   * Not a refusal of the person's right. They live here again, so the ground
   * the request rested on has gone; asking again is a new request.
   */
  async closeForMoveIn(
    tx: Prisma.TransactionClient,
    personId: string,
    actorPersonId: string | null,
  ): Promise<void> {
    const standing = await tx.dataSubjectRequest.findFirst({
      where: {
        personId,
        kind: "ERASURE",
        decision: "GRANTED",
        executedAt: null,
        closedAt: null,
      },
      orderBy: [{ requestedOn: "asc" }],
      select: { id: true },
    });
    if (standing === null) {
      return;
    }

    await tx.dataSubjectRequest.update({
      where: { id: standing.id },
      data: {
        closedAt: new Date(),
        closeReason: "moved-in",
        closedByPersonId: actorPersonId,
      },
    });

    await this.audit.record(
      {
        action: "DATA_SUBJECT_REQUEST_CLOSED",
        actorPersonId,
        targetPersonId: personId,
        targetKind: "dataSubjectRequest",
        targetId: standing.id,
        context: { kind: "ERASURE", executed: false, closeReason: "moved-in" },
      },
      tx,
    );
  }

  /**
   * Refuses to record a grant the purge could not carry out.
   *
   * Each of these is a person whose service data the purge would decline to
   * touch, checked here so the board hears why now rather than discovering next
   * morning that nothing happened.
   */
  private async assertErasable(
    tx: Prisma.TransactionClient,
    personId: string,
  ): Promise<void> {
    const now = new Date();
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      select: {
        processingRestrictedAt: true,
        residencies: {
          where: { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] },
          select: { id: true },
        },
        boardPositions: {
          where: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
          select: { id: true },
        },
        systemRoles: { select: { id: true } },
        legalHolds: { where: { releasedAt: null }, select: { id: true } },
      },
    });

    if (person.residencies.length > 0) {
      // The contract still runs, so art. 17(1)(a) is not made out: the data is
      // still necessary for the purpose it was collected for.
      throw new DataSubjectRequestError(
        "This person still lives here.",
        "currently-resident",
      );
    }
    if (person.legalHolds.length > 0) {
      // art. 17(3)(e): a legal claim to establish or defend.
      throw new DataSubjectRequestError(
        "A legal hold stands against this person.",
        "on-legal-hold",
      );
    }
    if (person.boardPositions.length > 0) {
      throw new DataSubjectRequestError(
        "This person still holds a position of trust.",
        "board-position-current",
      );
    }
    if (person.systemRoles.length > 0) {
      throw new DataSubjectRequestError(
        "This person still administers the instance.",
        "system-role-current",
      );
    }
    if (person.processingRestrictedAt !== null) {
      // art. 18(2): they asked the association to keep the data and stop using
      // it, which is the opposite of what a grant here would do.
      throw new DataSubjectRequestError(
        "This person has asked for their data to be restricted.",
        "processing-restricted",
      );
    }
  }

  /** Clears the person's flag when the request being closed was the last one. */
  private async clearFlagIfLast(
    tx: Prisma.TransactionClient,
    personId: string,
    kind: DataSubjectRequestKind,
    closingId: string,
  ): Promise<void> {
    if (kind !== "OBJECTION" && kind !== "RESTRICTION") {
      return;
    }

    const remaining = await tx.dataSubjectRequest.count({
      where: {
        personId,
        kind,
        decision: "GRANTED",
        closedAt: null,
        id: { not: closingId },
      },
    });
    if (remaining > 0) {
      return;
    }

    await tx.person.update({
      where: { id: personId },
      data:
        kind === "OBJECTION"
          ? { communicationObjectionAt: null }
          : { processingRestrictedAt: null },
    });
  }
}
