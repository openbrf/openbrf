import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";

/**
 * A legal hold could not be placed or released.
 *
 * `already-held` and `not-held` are conflicts rather than bad requests: the
 * request was well formed and describes a state the person is not in, which is
 * what a second board member clicking the same button a moment later meets.
 */
export class LegalHoldError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: "person-not-found" | "already-held" | "not-held",
  ) {
    super(message);
    this.status =
      reason === "person-not-found"
        ? HttpStatus.NOT_FOUND
        : HttpStatus.CONFLICT;
  }
}

/** One hold, as a screen and a report read it. */
export interface LegalHoldView {
  holdId: string;
  reason: string;
  /** ISO instant. A hold is placed at a moment, not on a calendar day. */
  placedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  placedByPersonId: string | null;
  releasedByPersonId: string | null;
}

/**
 * Legal hold (rattsligt bevarandekrav): the one lawful way to keep service
 * data past its purge date.
 *
 * The retention policy is what the association decided in general. A hold is
 * why one person is an exception to it - a dispute, an insurance claim, an
 * authority's request - and GDPR art. 17.3 is what makes the exception lawful.
 * Two of its grounds reach these: e, where data is needed to establish or
 * defend a legal claim, and b, where a legal obligation requires the data to be
 * kept, which is what a binding request from an authority creates. Either way
 * the ground outranks the right to erasure for as long as it lasts.
 *
 * So a hold suspends the purge rather than extending the policy. Extending the
 * policy would move every pending purge date in the association, for everybody,
 * because one person is in dispute - and it would leave no record of why. The
 * hold keeps the reason attached to the person it is about, which is what makes
 * it reviewable, and what lets the board see at a glance who is being kept and
 * for what.
 *
 * Placing and releasing are audited (LEGAL_HOLD_PLACED, LEGAL_HOLD_RELEASED)
 * in the same transaction as the change, like every other act on the register.
 */
@Injectable()
export class LegalHoldService {
  private readonly logger = new Logger(LegalHoldService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The hold that stands today, or null.
   *
   * At most one: {@link place} refuses a second while the first is open, so
   * "on hold" is a state rather than a count. Released holds stay on file and
   * are read by {@link history}.
   */
  async current(personId: string): Promise<LegalHoldView | null> {
    const hold = await this.prisma.legalHold.findFirst({
      where: { personId, releasedAt: null },
      orderBy: [{ placedAt: "desc" }],
    });
    return hold === null ? null : toView(hold);
  }

  /** Every hold ever placed on this person, newest first. */
  async history(personId: string): Promise<LegalHoldView[]> {
    const holds = await this.prisma.legalHold.findMany({
      where: { personId },
      orderBy: [{ placedAt: "desc" }],
    });
    return holds.map(toView);
  }

  /**
   * Places a hold, so the purge stops reaching this person's service data.
   *
   * A second hold on top of an open one is refused rather than accepted: two
   * open holds would make "released" ambiguous - releasing one would look like
   * releasing the person - and the board's question is whether the person is
   * held, not how many reasons there are. A further ground goes in the release
   * reason of the first and the reason of the next.
   *
   * The refusal narrows the window rather than closing it, since two callers
   * can both read no open hold before either inserts. {@link release} is where
   * that is made harmless: it closes every open hold rather than the one it
   * read, so a duplicate can never survive a release.
   */
  async place(input: {
    personId: string;
    reason: string;
    actorPersonId: string;
  }): Promise<LegalHoldView> {
    await this.requirePerson(input.personId);

    const view = await this.prisma.$transaction(async (tx) => {
      const open = await tx.legalHold.findFirst({
        where: { personId: input.personId, releasedAt: null },
        select: { id: true },
      });
      if (open !== null) {
        throw new LegalHoldError(
          "This person is already under a legal hold.",
          "already-held",
        );
      }

      const hold = await tx.legalHold.create({
        data: {
          personId: input.personId,
          reason: input.reason,
          placedByPersonId: input.actorPersonId,
        },
      });

      /*
       * The hold id, not the board's words. The reason is on the row this
       * entry names, and the audit log is append-only and outside every purge
       * scope - see the retention rule on AuditLogService. A hold is also the
       * one thing that must be readable in its current form: a reason
       * corrected after the fact would leave the log asserting the first
       * version for good.
       */
      await this.audit.record(
        {
          action: "LEGAL_HOLD_PLACED",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          targetKind: "legalHold",
          targetId: hold.id,
        },
        tx,
      );

      return toView(hold);
    });

    // No person id: an operational log has looser access and retention than
    // the audit log, and "this person is in a dispute" is an inference worth
    // more protection than the act itself. The audit entry above carries the
    // target.
    this.logger.log("Legal hold placed");
    return view;
  }

  /**
   * Releases the standing hold, so the purge reaches this person again.
   *
   * The row is closed with a date rather than deleted. That a hold stood
   * between two dates is the whole explanation for why the purge did not run
   * for that person in that period, and deleting it would leave the gap
   * unexplained - which is the state a supervisory authority reads as data
   * kept for no reason.
   *
   * Note what release does not do: it does not purge. The person becomes
   * eligible again, and the nightly job acts on that in its own time, which
   * keeps one board member's click from erasing a record on the spot.
   */
  async release(input: {
    personId: string;
    reason?: string;
    actorPersonId: string;
  }): Promise<LegalHoldView> {
    await this.requirePerson(input.personId);

    const view = await this.prisma.$transaction(async (tx) => {
      const open = await tx.legalHold.findFirst({
        where: { personId: input.personId, releasedAt: null },
        orderBy: [{ placedAt: "desc" }],
        select: { id: true },
      });
      if (open === null) {
        throw new LegalHoldError(
          "This person is not under a legal hold.",
          "not-held",
        );
      }

      /*
       * Every open hold for this person, not only the one read above.
       *
       * Two placements that arrive at once both read no open hold and both
       * insert: the invariant "at most one open hold per person" is a partial
       * unique index, which Prisma's schema cannot express - the same reason
       * publication consent closes every open row for a scope rather than the
       * one it read. Releasing only the newest would leave the older one
       * standing, so the person would still be held after the board released
       * them and the purge would never reach their service data. That is the
       * failure worth designing against: a retention promise silently not kept.
       *
       * The condition on releasedAt also makes this safe against two releases
       * at once: the one that loses matches no rows rather than writing a
       * second release date over an already released hold.
       */
      const released = await tx.legalHold.updateMany({
        where: { personId: input.personId, releasedAt: null },
        data: {
          releasedAt: new Date(),
          releaseReason: input.reason ?? null,
          releasedByPersonId: input.actorPersonId,
        },
      });
      if (released.count === 0) {
        throw new LegalHoldError(
          "This person is not under a legal hold.",
          "not-held",
        );
      }

      await this.audit.record(
        {
          action: "LEGAL_HOLD_RELEASED",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          targetKind: "legalHold",
          targetId: open.id,
          // A count rather than the board's words. More than one means two
          // placements raced, which is the only way a second open hold exists;
          // without this the entry could not say that it had happened.
          context: { holdsReleased: released.count },
        },
        tx,
      );

      return toView(
        await tx.legalHold.findUniqueOrThrow({ where: { id: open.id } }),
      );
    });

    this.logger.log("Legal hold released");
    return view;
  }

  private async requirePerson(personId: string): Promise<void> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { id: true },
    });
    if (person === null) {
      throw new LegalHoldError("No such person.", "person-not-found");
    }
  }
}

function toView(hold: {
  id: string;
  reason: string;
  placedAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
  placedByPersonId: string | null;
  releasedByPersonId: string | null;
}): LegalHoldView {
  return {
    holdId: hold.id,
    reason: hold.reason,
    placedAt: hold.placedAt.toISOString(),
    releasedAt: hold.releasedAt?.toISOString() ?? null,
    releaseReason: hold.releaseReason,
    placedByPersonId: hold.placedByPersonId,
    releasedByPersonId: hold.releasedByPersonId,
  };
}
