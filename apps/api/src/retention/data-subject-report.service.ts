import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { toIsoDate } from "../address-book/address-book-view";
import { AuditLogService } from "../audit/audit-log.service";
import { computeBookingPurgeDate } from "../bookings/booking-retention";
import { computeNewsCommentPurgeDate } from "../news/news-comment-retention";
import { computeMotionPurgeDate } from "../motions/motion-retention";
import { formatLocalDay, localDayOf } from "../bookings/stockholm-calendar";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { computeEventSignupPurgeDate } from "../events/event-signup-retention";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { resolveRegisterEvents } from "../registers/membership-periods";
import type {
  DataSubjectReport,
  ReportAuditEntry,
  ReportNewsComment,
  ReportPostalAddress,
} from "./data-subject-report";
import {
  holdingPeriods,
  lienNotesDuringHolding,
  terminationsDuringHolding,
} from "./holding-periods";
import { computePurgeDate } from "./purge-date";
import { retentionDaysAfterMoveOut } from "./retention-policy";

/** The report was asked for about somebody the register does not hold. */
export class DataSubjectReportError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "person-not-found";
}

/**
 * The sections the report is built from, named for the audit entry.
 *
 * Field names rather than the data they carried, which is what an audit entry
 * may hold; and naming them is what makes the entry say how much was disclosed
 * rather than merely that something was.
 */
const SECTIONS = [
  "person",
  "residencies",
  "boardPositions",
  "systemRoles",
  "account",
  "memberRegisterEntries",
  "transfers",
  "terminations",
  "lienNotes",
  "registerReportObligations",
  "publicationConsents",
  "legalHolds",
  "issues",
  "documents",
  "bookings",
  "motions",
  "eventSignups",
  "newsComments",
  "auditEntries",
] as const;

/**
 * The data subject access report (registerutdrag, GDPR art. 15).
 *
 * The most disclosure-heavy operation in the product, and deliberately the
 * narrowest gated: it decrypts the email address, the phone number and the
 * personal identity number of one person and puts them on one document with
 * every record the association holds about them. Nothing else in the system
 * returns all three, and the personal identity number appears on no other
 * payload at all.
 *
 * Three properties follow from that and are not negotiable:
 *
 *   It is gated on `protectedData:reveal`. That capability exists for exactly
 *   this class of act - a deliberate, audited disclosure of data the product
 *   otherwise masks - and it is held by the board and an administrator, not by
 *   a resident or the property manager.
 *
 *   It is audited as DATA_EXPORTED through {@link AuditLogService.withAuditedRead},
 *   so the entry and the read commit together. A report produced without an
 *   entry would be the one disclosure in the product that left no trace, which
 *   is precisely the trace a supervisory authority asks for.
 *
 *   It never leaves the authenticated application. There is no public path to
 *   it and no email delivery: it is rendered on a screen, printed by the board
 *   member who produced it, and handed over. Mailing a document that carries a
 *   personal identity number would put it in two mail systems on its way.
 *
 * ## Completeness
 *
 * Art. 15 asks for the personal data, not for the tables it happens to live
 * in, so the report crosses both tiers. It carries the statutory archive -
 * member register entries, transfers, terminations, lien notes and the duties to
 * report a register event onward - even
 * though those are exempt from erasure, because exemption from purging is not
 * exemption from access: a person is entitled to see what the cooperative
 * keeps about them and to be told that it is kept because the law requires it,
 * which the retention section says.
 *
 * Two of those sections are not keyed on a person at all. A lien note and a
 * termination both name an apartment and never a person, so they reach the
 * report through the tenant-ownerships the member register says this person
 * held. `holding-periods.ts` is that derivation, and it errs in opposite
 * directions for the two: a lien note is left out on a boundary day because it
 * would be a third party's financial position, and a termination is kept
 * because it is normally the event that ended the holding.
 *
 * A reporting obligation is keyed on neither a person nor an apartment but on
 * the register event it is about, so it is reached one step further out again:
 * through the transfers and terminations those rules have already selected,
 * rather than through a derivation of its own. It is on the report for art.
 * 15(1)(c), which gives the data subject the recipients their data will be
 * disclosed to, and this ledger is the association's only record of one. A
 * transfer's obligation goes to the acquirer alone: its due date less fourteen
 * days is the membership decision date, which this report withholds from the
 * seller deliberately.
 *
 * It carries issues and archived documents that reference the person even
 * though this train does not purge either. A report that omitted rows because
 * their retention story was unfinished would be an incomplete answer to an
 * access request, which is the one failure this document cannot have.
 *
 * Four sections state an erasure date per row, because four modules purge on
 * clocks of their own. A booking is purged a year after the booked period ended,
 * an event sign-up a year after the date it was for, a comment a year after it
 * was written, and a motion two years after it was closed - so the date at the
 * foot of the document is not the date that governs any of them, and each row
 * says when it goes. A motion still with the board states no date at all: it has
 * no closing date to count from, and the association is still processing it.
 */
@Injectable()
export class DataSubjectReportService {
  private readonly logger = new Logger(DataSubjectReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  async generate(input: {
    personId: string;
    actorPersonId: string;
    now?: Date;
  }): Promise<DataSubjectReport> {
    const now = input.now ?? new Date();
    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);

    const report = await this.audit.withAuditedRead<DataSubjectReport>(
      {
        action: "DATA_EXPORTED",
        actorPersonId: input.actorPersonId,
        targetPersonId: input.personId,
        // What was assembled, never what it held.
        context: { report: "dataSubjectAccess", sections: [...SECTIONS] },
      },
      async (tx) => this.build(tx, input.personId, now, retentionDays),
    );

    // The person and the act, and nothing the report was carrying.
    this.logger.log(
      `Data subject access report produced for person ${input.personId}`,
    );
    return report;
  }

  private async build(
    tx: Prisma.TransactionClient,
    personId: string,
    now: Date,
    retentionDays: number,
  ): Promise<DataSubjectReport> {
    const person = await tx.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        alternativePostalAddress: true,
        emailCipher: true,
        phoneCipher: true,
        personalIdentityNumberCipher: true,
        protectedPersonalData: true,
        preferredLocale: true,
        createdAt: true,
        residencies: {
          orderBy: [{ movedInOn: "desc" }],
          select: {
            id: true,
            role: true,
            movedInOn: true,
            movedOutOn: true,
            apartment: {
              select: {
                number: true,
                address: { select: { street: true, number: true } },
              },
            },
          },
        },
        boardPositions: {
          orderBy: [{ electedOn: "desc" }],
          select: { position: true, electedOn: true, endedOn: true },
        },
        systemRoles: { select: { role: true } },
        userAccount: {
          select: { email: true, twoFactorEnabled: true, createdAt: true },
        },
        memberRegisterEntries: {
          orderBy: [{ eventOn: "asc" }],
          select: {
            id: true,
            eventType: true,
            eventOn: true,
            /*
             * Read twice over: once as the register section below, and once as
             * the archive that says which tenant-ownership this person held and
             * when, which is what decides whose lien notes these are. The four
             * fields after this one are the second reading's - a correction
             * chain cannot be resolved without them.
             */
            personId: true,
            apartmentId: true,
            correctsEntryId: true,
            createdAt: true,
            recordedFirstName: true,
            recordedLastName: true,
            recordedPostalStreet: true,
            recordedPostalCode: true,
            recordedPostalCity: true,
            note: true,
            apartment: {
              select: {
                number: true,
                address: { select: { street: true, number: true } },
              },
            },
          },
        },
        publicationConsents: {
          orderBy: [{ grantedAt: "desc" }],
          select: {
            scope: true,
            grantedAt: true,
            withdrawnAt: true,
            note: true,
          },
        },
        legalHolds: {
          orderBy: [{ placedAt: "desc" }],
          select: {
            id: true,
            reason: true,
            placedAt: true,
            releasedAt: true,
            releaseReason: true,
          },
        },
      },
    });

    if (person === null) {
      throw new DataSubjectReportError("No such person.");
    }

    const association = await tx.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });

    const transfers = await tx.transfer.findMany({
      where: { OR: [{ fromPersonId: personId }, { toPersonId: personId }] },
      orderBy: [{ transferredOn: "asc" }],
      select: {
        id: true,
        toPersonId: true,
        transferredOn: true,
        membershipDecidedOn: true,
        price: true,
        agreementReference: true,
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
      },
    });

    /*
     * Lien notes reach a person only through the tenant-ownership they held, so
     * the archive is read for the holdings first and the notes are bounded by
     * them. Both steps are pure and covered in holding-periods.spec.ts, which
     * is where the transfer-day cases are argued: a pledge redeemed as a sale
     * completes belongs to the seller's report, not the buyer's.
     */
    const holdings = holdingPeriods(
      resolveRegisterEvents(person.memberRegisterEntries),
    );
    const heldApartmentIds = [
      ...new Set(holdings.map((holding) => holding.apartmentId)),
    ];
    /*
     * Terminations reach a person the same way and are bounded by the same
     * holdings, on their own boundary rule: a termination on the day a holding
     * ended is normally what ended it, so both boundaries are closed where the
     * lien rule leaves both open. Argued in holding-periods.ts and covered in
     * holding-periods.spec.ts.
     */
    const terminations =
      heldApartmentIds.length === 0
        ? []
        : terminationsDuringHolding(
            await tx.termination.findMany({
              where: { apartmentId: { in: heldApartmentIds } },
              orderBy: [{ tookEffectOn: "asc" }],
              select: {
                id: true,
                apartmentId: true,
                kind: true,
                tookEffectOn: true,
                reference: true,
                apartment: {
                  select: {
                    number: true,
                    address: { select: { street: true, number: true } },
                  },
                },
              },
            }),
            holdings,
          );

    const lienNotes =
      heldApartmentIds.length === 0
        ? []
        : lienNotesDuringHolding(
            await tx.lienNote.findMany({
              where: { apartmentId: { in: heldApartmentIds } },
              orderBy: [{ notedOn: "asc" }],
              select: {
                id: true,
                apartmentId: true,
                creditor: true,
                amount: true,
                notedOn: true,
                releasedOn: true,
                apartment: {
                  select: {
                    number: true,
                    address: { select: { street: true, number: true } },
                  },
                },
              },
            }),
            holdings,
          );

    /*
     * The duties to report a register event onward, reached through the events
     * this report already carries rather than through a rule of their own.
     *
     * A termination's obligation follows every termination selected above, so it
     * inherits that boundary rule whole. A transfer's follows the transfers this
     * person acquired, and never those they sold on: the due date less fourteen
     * days is the day the association decided on the acquirer's membership, and
     * the transfer section withholds that value from the seller on purpose, so
     * listing the deadline would hand it back by subtraction.
     */
    const reportedTerminationIds = terminations.map(
      (termination) => termination.id,
    );
    const acquiredTransferIds = transfers
      .filter((transfer) => transfer.toPersonId === personId)
      .map((transfer) => transfer.id);
    const registerReportObligations =
      reportedTerminationIds.length === 0 && acquiredTransferIds.length === 0
        ? []
        : await tx.registerReportObligation.findMany({
            where: {
              OR: [
                { terminationId: { in: reportedTerminationIds } },
                { transferId: { in: acquiredTransferIds } },
              ],
            },
            orderBy: [{ dueOn: "asc" }],
            select: {
              id: true,
              kind: true,
              triggeredOn: true,
              dueOn: true,
              apartment: {
                select: {
                  number: true,
                  address: { select: { street: true, number: true } },
                },
              },
            },
          });

    const issues = await tx.issue.findMany({
      where: { reporterPersonId: personId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        status: true,
        location: true,
        description: true,
        createdAt: true,
        type: { select: { name: true } },
        _count: { select: { photos: true } },
      },
    });

    const documents = await tx.document.findMany({
      where: { uploadedByPersonId: personId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        category: true,
        audience: true,
        createdAt: true,
      },
    });

    /*
     * Bookings this person made. `bookedByPersonId` is a plain column and not a
     * relation - a purge must not have to negotiate with the booking calendar -
     * so this is a query of its own rather than a nested read off the person.
     */
    const bookings = await tx.booking.findMany({
      where: { bookedByPersonId: personId },
      orderBy: [{ startsAt: "desc" }],
      select: {
        id: true,
        status: true,
        startsAt: true,
        endsAt: true,
        resource: { select: { name: true } },
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
      },
    });

    /*
     * Motions this person put to the general meeting. `submittedByPersonId` is a
     * plain column and not a relation, for the reason the bookings query above
     * gives, so this is a query of its own.
     */
    const motions = await tx.motion.findMany({
      where: { submittedByPersonId: personId },
      orderBy: [{ submittedAt: "desc" }],
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        submittedAt: true,
        closedAt: true,
      },
    });

    /*
     * Sign-ups this person made to the association's own dates, the ones they
     * stood down from included. `personId` is a plain column and not a relation,
     * for the reason `bookedByPersonId` is, so this is a query of its own; the
     * occurrence IS one, which is how the date and the series it belongs to reach
     * the document without being copied onto the sign-up.
     */
    const eventSignups = await tx.eventSignup.findMany({
      where: { personId },
      orderBy: [{ signedUpAt: "desc" }],
      select: {
        id: true,
        signedUpAt: true,
        withdrawnAt: true,
        occurrence: {
          select: {
            startsAt: true,
            endsAt: true,
            cancelledAt: true,
            event: { select: { title: true } },
          },
        },
      },
    });

    /*
     * Comments this person wrote under the association's news. `authorPersonId`
     * is a plain column and not a relation, for the reason the booking above
     * gives, so this is a query of its own; the news item is joined for its
     * title and its address, which is how the person would find what they were
     * answering.
     */
    const newsComments = await tx.newsComment.findMany({
      where: { authorPersonId: personId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        body: true,
        hiddenAt: true,
        createdAt: true,
        news: { select: { title: true, slug: true } },
      },
    });

    /*
     * Every entry naming this person, either way round. The log's two person
     * columns are plain columns rather than relations - the audit log has to
     * outlive the people it names - so this is one query with an OR rather
     * than a nested read.
     */
    const auditEntries = await tx.auditLogEntry.findMany({
      where: {
        OR: [{ targetPersonId: personId }, { actorPersonId: personId }],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        action: true,
        createdAt: true,
        actorPersonId: true,
        targetPersonId: true,
        targetKind: true,
        targetId: true,
        context: true,
      },
    });

    const lastMovedOutOn = latestMoveOut(person.residencies);

    return {
      generatedOn: toIsoDate(now) ?? now.toISOString(),
      housingCooperative: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
      },
      person: {
        personId: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        postalAddress: {
          street: person.postalStreet,
          postalCode: person.postalCode,
          city: person.postalCity,
        },
        alternativePostalAddress: person.alternativePostalAddress,
        email:
          person.emailCipher === null
            ? null
            : await this.encryption.decrypt("person.email", person.emailCipher),
        phone:
          person.phoneCipher === null
            ? null
            : await this.encryption.decrypt("person.phone", person.phoneCipher),
        personalIdentityNumber:
          person.personalIdentityNumberCipher === null
            ? null
            : await this.encryption.decrypt(
                "person.personalIdentityNumber",
                person.personalIdentityNumberCipher,
              ),
        protectedPersonalData: person.protectedPersonalData,
        preferredLocale: person.preferredLocale,
        recordedAt: person.createdAt.toISOString(),
      },
      residencies: person.residencies.map((residency) => ({
        residencyId: residency.id,
        apartmentNumber: residency.apartment.number,
        addressLabel: `${residency.apartment.address.street} ${residency.apartment.address.number}`,
        role: residency.role,
        movedInOn: toIsoDate(residency.movedInOn),
        movedOutOn: toIsoDate(residency.movedOutOn),
        purgeOn: toIsoDate(
          computePurgeDate(residency.movedOutOn, retentionDays),
        ),
      })),
      boardPositions: person.boardPositions.map((position) => ({
        position: position.position,
        electedOn: toIsoDate(position.electedOn),
        endedOn: toIsoDate(position.endedOn),
      })),
      systemRoles: person.systemRoles.map((role) => role.role),
      account:
        person.userAccount === null
          ? null
          : {
              email: person.userAccount.email,
              twoFactorEnabled: person.userAccount.twoFactorEnabled === true,
              createdAt: person.userAccount.createdAt.toISOString(),
            },
      memberRegisterEntries: person.memberRegisterEntries.map((entry) => ({
        entryId: entry.id,
        eventType: entry.eventType,
        eventOn: toIsoDate(entry.eventOn) ?? "",
        apartment:
          entry.apartment === null
            ? null
            : `${entry.apartment.address.street} ${entry.apartment.address.number} ${entry.apartment.number}`,
        recordedName:
          `${entry.recordedFirstName} ${entry.recordedLastName}`.trim(),
        recordedPostalAddress: {
          street: entry.recordedPostalStreet,
          postalCode: entry.recordedPostalCode,
          city: entry.recordedPostalCity,
        } satisfies ReportPostalAddress,
        note: entry.note,
      })),
      transfers: transfers.map((transfer) => ({
        transferId: transfer.id,
        apartment: `${transfer.apartment.address.street} ${transfer.apartment.address.number} ${transfer.apartment.number}`,
        direction:
          transfer.toPersonId === personId ? "acquired" : "relinquished",
        transferredOn: toIsoDate(transfer.transferredOn) ?? "",
        // Decimal through its own toString: a price rendered through a float
        // would round in a document that states what an apartment sold for.
        price: transfer.price === null ? null : transfer.price.toString(),
        agreementReference: transfer.agreementReference,
        // The acquirer's date, and only theirs. This section carries both
        // directions - a person's own report lists the transfer they sold on as
        // well as the one they bought - and the membership decision is the day
        // the association decided whether to admit the person taking over. On a
        // relinquished transfer that is a personal-data event about somebody
        // else, so a report that stated it would answer this person's art. 15
        // request with a fact about the other party.
        membershipDecidedOn:
          transfer.toPersonId === personId
            ? toIsoDate(transfer.membershipDecidedOn)
            : null,
      })),
      terminations: terminations.map((termination) => ({
        terminationId: termination.id,
        apartment: `${termination.apartment.address.street} ${termination.apartment.address.number} ${termination.apartment.number}`,
        kind: termination.kind,
        tookEffectOn: toIsoDate(termination.tookEffectOn) ?? "",
        reference: termination.reference,
      })),
      lienNotes: lienNotes.map((note) => ({
        lienNoteId: note.id,
        apartment: `${note.apartment.address.street} ${note.apartment.address.number} ${note.apartment.number}`,
        creditor: note.creditor,
        // Decimal through its own toString, for the reason the transfer price
        // gives: a float would round a sum on a statutory record.
        amount: note.amount === null ? null : note.amount.toString(),
        notedOn: toIsoDate(note.notedOn) ?? "",
        releasedOn: toIsoDate(note.releasedOn),
      })),
      registerReportObligations: registerReportObligations.map(
        (obligation) => ({
          obligationId: obligation.id,
          kind: obligation.kind,
          apartment: `${obligation.apartment.address.street} ${obligation.apartment.address.number} ${obligation.apartment.number}`,
          triggeredOn: toIsoDate(obligation.triggeredOn) ?? "",
          dueOn: toIsoDate(obligation.dueOn) ?? "",
        }),
      ),
      publicationConsents: person.publicationConsents.map((consent) => ({
        scope: consent.scope,
        grantedOn: consent.grantedAt.toISOString(),
        withdrawnOn: consent.withdrawnAt?.toISOString() ?? null,
        note: consent.note,
      })),
      legalHolds: person.legalHolds.map((hold) => ({
        holdId: hold.id,
        reason: hold.reason,
        placedAt: hold.placedAt.toISOString(),
        releasedAt: hold.releasedAt?.toISOString() ?? null,
        releaseReason: hold.releaseReason,
      })),
      issues: issues.map((issue) => ({
        issueId: issue.id,
        typeName: issue.type.name,
        status: issue.status,
        location: issue.location,
        description: issue.description,
        reportedAt: issue.createdAt.toISOString(),
        photographs: issue._count.photos,
      })),
      documents: documents.map((document) => ({
        documentId: document.id,
        title: document.title,
        category: document.category,
        audience: document.audience,
        filedAt: document.createdAt.toISOString(),
      })),
      bookings: bookings.map((booking) => ({
        bookingId: booking.id,
        resourceName: booking.resource.name,
        status: booking.status,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        apartment:
          booking.apartment === null
            ? null
            : `${booking.apartment.address.street} ${booking.apartment.address.number} ${booking.apartment.number}`,
        /*
         * Derived here rather than stored, exactly as a residency's is: a
         * shorter retention window moves every pending date by that act alone,
         * and this document has to state the date that will actually apply.
         *
         * Stated as the earliest date the purge can reach the row rather than
         * as the date it goes on, because a legal hold suspends the purge for
         * the whole person and this document is read by the person a hold may
         * be standing against. `retention.onLegalHold` below says whether one
         * does; a hold defers this date and never advances it, so the earliest
         * holds true whether or not one stands.
         */
        erasableFrom: toIsoDate(computeBookingPurgeDate(booking.endsAt)),
      })),
      motions: motions.map((motion) => ({
        motionId: motion.id,
        title: motion.title,
        body: motion.body,
        status: motion.status,
        submittedAt: motion.submittedAt.toISOString(),
        closedAt: motion.closedAt?.toISOString() ?? null,
        /*
         * Derived here rather than stored, as a residency's and a booking's are.
         * Null while the motion is open, which is not a gap in the answer: an
         * open motion has no closing date to count from, and the association is
         * still processing it, so no purge date exists to state.
         */
        erasableFrom: toIsoDate(computeMotionPurgeDate(motion.closedAt)),
      })),
      eventSignups: eventSignups.map((signup) => ({
        signupId: signup.id,
        eventTitle: signup.occurrence.event.title,
        startsAt: signup.occurrence.startsAt.toISOString(),
        endsAt: signup.occurrence.endsAt.toISOString(),
        /*
         * The local date on the association's own clock, and not a slice of the
         * instant. A midsummer party starting at half past midnight is on the
         * 21st of June in Stockholm and on the 20th in UTC, and this document
         * states the date the notice in the stairwell did.
         */
        on: formatLocalDay(localDayOf(signup.occurrence.startsAt)),
        signedUpAt: signup.signedUpAt.toISOString(),
        withdrawnOn: signup.withdrawnAt?.toISOString() ?? null,
        calledOff: signup.occurrence.cancelledAt !== null,
        // Derived here rather than stored, exactly as the booking's is, and
        // anchored on the end of the date rather than on the withdrawal: the row
        // is about a date, and it is the date that decides when the association
        // has no further use for it.
        erasableFrom: toIsoDate(
          computeEventSignupPurgeDate(signup.occurrence.endsAt),
        ),
      })),
      newsComments: newsComments.map((comment): ReportNewsComment => ({
        commentId: comment.id,
        newsTitle: comment.news.title,
        newsSlug: comment.news.slug,
        // In full, and whether or not it is hidden. What somebody wrote is
        // the personal data this section is about, and a moderated comment is
        // still their words.
        body: comment.body,
        hidden: comment.hiddenAt !== null,
        writtenAt: comment.createdAt.toISOString(),
        /*
         * Derived here rather than stored, exactly as the booking's is: a
         * shorter retention window moves every pending date by that act
         * alone, and this document has to state the date that will actually
         * apply.
         *
         * The earliest date the purge can reach the row rather than the date
         * it goes on, because a legal hold suspends the purge for the whole
         * person and this document is read by the person a hold may be
         * standing against.
         */
        erasableFrom: toIsoDate(computeNewsCommentPurgeDate(comment.createdAt)),
      })),
      auditEntries: auditEntries.map((entry): ReportAuditEntry => ({
        entryId: entry.id,
        role: entry.targetPersonId === personId ? "subject" : "actor",
        action: entry.action,
        at: entry.createdAt.toISOString(),
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        context: asContext(entry.context),
      })),
      retention: {
        daysAfterMoveOut: retentionDays,
        purgeOn: toIsoDate(computePurgeDate(lastMovedOutOn, retentionDays)),
        onLegalHold: person.legalHolds.some((hold) => hold.releasedAt === null),
      },
    };
  }
}

/**
 * The latest move-out across every residency, or null while any is current.
 *
 * The purge date the report states is the one that governs the person, not the
 * one that governs a residency: somebody who moved out of one apartment and
 * still lives in another has no purge date at all, and stating the first
 * residency's would promise an erasure that is not going to happen.
 */
function latestMoveOut(
  residencies: readonly { movedOutOn: Date | null }[],
): Date | null {
  if (residencies.length === 0) {
    return null;
  }
  let latest: Date | null = null;
  for (const residency of residencies) {
    if (residency.movedOutOn === null) {
      return null;
    }
    if (latest === null || residency.movedOutOn.getTime() > latest.getTime()) {
      latest = residency.movedOutOn;
    }
  }
  return latest;
}

/**
 * The audit entry's context as an object, or null.
 *
 * Prisma types a JSON column as its own JsonValue, which is an array or a
 * scalar as readily as an object. Everything this application writes is an
 * object, so anything else is data from outside the application's own writers
 * and is reported as absent rather than rendered as a value nobody can read.
 */
function asContext(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
