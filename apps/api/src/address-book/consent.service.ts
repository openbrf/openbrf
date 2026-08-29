import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { ConsentScope } from "../generated/prisma/enums";
import { PersonError } from "./person.service";
import {
  consentStateFor,
  consentViewOf,
  type PublicationConsentView,
} from "./publication-consent";

export interface SetPublicationConsentInput {
  personId: string;
  scope: ConsentScope;
  /** True records a consent, false withdraws the one in force. */
  granted: boolean;
  actorPersonId: string;
  /** What the person said, kept with the grant it describes. */
  note?: string;
}

/** The columns the projection reads, so the two queries below select alike. */
const CONSENT_VIEW_COLUMNS = {
  scope: true,
  grantedAt: true,
  withdrawnAt: true,
  note: true,
} as const;

/**
 * Publication consent (publiceringssamtycke): what a person has agreed to
 * appear as on something the association publishes.
 *
 * The board records this, not the person, for the same reason the board
 * records protected personal data: the person tells the board - in a meeting,
 * on a form, at the door - and the register is where the board writes down what
 * it was told. Consent is the legal basis for putting personal data on a
 * published page (GDPR art. 6.1 a), so what is stored is a dated fact rather
 * than a setting: a page published while a consent stood was published lawfully
 * even after the consent is withdrawn, and only the dates can say so.
 *
 * Withdrawal therefore never deletes anything. It closes the standing consent
 * with a date and leaves the row where it is.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every scope and where it stands for one person. */
  async forPerson(personId: string): Promise<PublicationConsentView[]> {
    const rows = await this.prisma.publicationConsent.findMany({
      where: { personId },
      orderBy: [{ grantedAt: "desc" }],
      select: CONSENT_VIEW_COLUMNS,
    });
    return consentStateFor(rows);
  }

  /**
   * Records or withdraws the consent for one scope.
   *
   * Shaped like setting the protected personal data flag, including its rule:
   * a change that changes nothing writes nothing. Recording a consent that
   * already stands, or withdrawing one that does not, is answered with the
   * state as it is - padding the audit log with entries that correspond to no
   * act would make the entries that do harder to find, and would put dates in
   * the record that nobody chose.
   *
   * The whole decision happens in one transaction: the row it reads to find
   * out what stands is the row it then closes, and the audit entry commits with
   * whichever of the two writes happened.
   */
  async setConsent(
    input: SetPublicationConsentInput,
    now: Date = new Date(),
  ): Promise<PublicationConsentView> {
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true },
      });
      if (person === null) {
        throw new PersonError("No such person.", "person-not-found");
      }

      const latest = await tx.publicationConsent.findFirst({
        where: { personId: input.personId, scope: input.scope },
        orderBy: [{ grantedAt: "desc" }],
        select: CONSENT_VIEW_COLUMNS,
      });
      const standing =
        latest !== null && latest.withdrawnAt === null ? latest : null;

      if (input.granted) {
        if (standing !== null) {
          return consentViewOf(input.scope, standing);
        }

        /*
         * A new row rather than reopening the closed one. Two grants are two
         * facts with two dates, and rewriting the older row would erase the
         * period between them - which is exactly the period a page published
         * back then has to be judged by.
         */
        const created = await tx.publicationConsent.create({
          data: {
            personId: input.personId,
            scope: input.scope,
            grantedAt: now,
            recordedByPersonId: input.actorPersonId,
            note: input.note ?? null,
          },
          select: CONSENT_VIEW_COLUMNS,
        });

        await this.audit.record(
          {
            action: "CONSENT_RECORDED",
            actorPersonId: input.actorPersonId,
            targetPersonId: input.personId,
            context: {
              scope: input.scope,
              ...(input.note === undefined ? {} : { note: input.note }),
            },
          },
          tx,
        );

        this.logger.log(
          `Recorded publication consent ${input.scope} for person ${input.personId}`,
        );
        return consentViewOf(input.scope, created);
      }

      if (standing === null) {
        return consentViewOf(input.scope, latest);
      }

      /*
       * Every open row for the scope, not only the one read above.
       *
       * Two grants that arrive at once both read no standing consent and both
       * insert, because the invariant "at most one open row per person and
       * scope" is a partial unique index, which Prisma's schema cannot
       * express. Closing them all keeps the invariant that matters: a
       * duplicate can never leave a consent standing behind a withdrawal, and
       * the person view can never report that a page is lawful to publish
       * after the person asked for it to be taken down.
       *
       * The condition on withdrawnAt also makes this safe against two
       * withdrawals at once: the one that loses matches no rows rather than
       * overwriting the date the winner recorded on an append-only fact.
       */
      const closed = await tx.publicationConsent.updateMany({
        where: {
          personId: input.personId,
          scope: input.scope,
          withdrawnAt: null,
        },
        data: { withdrawnAt: now },
      });

      if (closed.count === 0) {
        // Another withdrawal committed between the read and the write. It
        // recorded the act and the date; this call changed nothing, so by the
        // rule above it writes nothing and answers with the state as it is.
        const current = await tx.publicationConsent.findFirst({
          where: { personId: input.personId, scope: input.scope },
          orderBy: [{ grantedAt: "desc" }],
          select: CONSENT_VIEW_COLUMNS,
        });
        return consentViewOf(input.scope, current);
      }

      await this.audit.record(
        {
          action: "CONSENT_WITHDRAWN",
          actorPersonId: input.actorPersonId,
          targetPersonId: input.personId,
          context: {
            scope: input.scope,
            // The period the consent covered, which is what a later question
            // about an already published page is asked against.
            grantedAt: standing.grantedAt.toISOString(),
            ...(input.note === undefined ? {} : { note: input.note }),
          },
        },
        tx,
      );

      this.logger.log(
        `Withdrew publication consent ${input.scope} for person ${input.personId}`,
      );
      return consentViewOf(input.scope, {
        scope: standing.scope,
        grantedAt: standing.grantedAt,
        withdrawnAt: now,
        note: standing.note,
      });
    });
  }
}
