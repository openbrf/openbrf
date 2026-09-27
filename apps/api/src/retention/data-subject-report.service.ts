import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  compareLocalDays,
  formatDateColumn,
  formatDayOfInstant,
  formatLocalDay,
  localDayOf,
  localDayOfColumn,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { computeBookingPurgeDate } from "../bookings/booking-retention";
import { computeChatMessagePurgeDate } from "../chat/chat-retention";
import { computeNewsCommentPurgeDate } from "../news/news-comment-retention";
import { computeKeyOrderPurgeDate } from "../key-orders/key-order-retention";
import { computeMotionPurgeDate } from "../motions/motion-retention";
import { computeSubletPurgeDate } from "../sublets/sublet-retention";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { chargesDuringResidency } from "../charges/apartment-charges";
import { computeMemberChargePurgeDate } from "../charges/member-charge-retention";
import { computeFeePurgeDate } from "../fees/fee-retention";
import { computeEventSignupPurgeDate } from "../events/event-signup-retention";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { resolveRegisterEvents } from "../registers/membership-periods";
import { computeBoardMailboxPurgeDate } from "../board-mailbox/board-mailbox-retention";
import {
  PORTABLE_SECTIONS,
  REPORTED_SECTIONS,
} from "../data-protection/section-processing";
import type {
  DataSubjectReport,
  ReportAuditEntry,
  ReportConnectedAppScope,
  ReportDataSubjectRequest,
  ReportFee,
  ReportFeeNotice,
  ReportBoardMailboxThread,
  ReportChat,
  ReportChatMessage,
  ReportChatReport,
  ReportMeetingAttendance,
  ReportMemberCharge,
  ReportPersonalDataBreach,
  ReportNewsComment,
  ReportPostalAddress,
  ReportProxyAuthorisation,
} from "./data-subject-report";
import {
  holdingPeriods,
  lienNotesDuringHolding,
  terminationsDuringHolding,
} from "./holding-periods";
import { dueOn } from "../data-protection/data-subject-request";
import { connectedAppHost } from "../data-protection/processors";
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
 *
 * Read from the map that ties each section to the record of processing
 * activities, so a section added to the report cannot compile without being
 * named here too.
 */
const SECTIONS = REPORTED_SECTIONS;

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
 * Every section whose module purges on a clock of its own states an erasure
 * date per row. A booking is purged a year after the booked period ended, an
 * event sign-up a year after the date it was for, a comment a year after it was
 * written and a motion two years after it was closed, and each of the others on
 * a window of its own - so the date at the foot of the document is not the date
 * that governs any of them, and each row says when it goes. A motion still with
 * the board states no date at all: it has no closing date to count from, and
 * the association is still processing it.
 *
 * The two general meeting sections state none, and that is an answer rather
 * than an omission: attendance at a general meeting and the proxy authorisation
 * a vote was exercised under are part of the meeting's record, whose lasting
 * form is the protokoll that EFL 6 kap. 39 § has the voting register taken into
 * and 40 § has kept safely. So they sit with the statutory register sections
 * above - kept because the law requires the record - rather than with the
 * sections that go on a clock of their own.
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
        channel: "WEB",
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

  /**
   * The same assembly, for a person exporting their own data (GDPR art. 20).
   *
   * The report itself, narrowed afterwards by the projection in
   * `data-protection/data-portability.ts`. One gathering rather than two: a
   * second query layer beside this one would be the place the two drifted
   * apart, and a section added here and forgotten there would be data a person
   * could read but not take.
   *
   * Its own audit action, so the log can tell a person taking their own data
   * from a board producing the access report about them. Actor and subject are
   * the same person, which is the other half of that distinction.
   */
  async portable(personId: string): Promise<DataSubjectReport> {
    const now = new Date();
    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);

    const report = await this.audit.withAuditedRead<DataSubjectReport>(
      {
        action: "DATA_PORTABILITY_EXPORTED",
        channel: "WEB",
        actorPersonId: personId,
        targetPersonId: personId,
        // What the file carried, named the way the access report names its
        // own: how much was disclosed, never what it held.
        context: {
          export: "dataPortability",
          sections: [...PORTABLE_SECTIONS],
        },
      },
      async (tx) => this.build(tx, personId, now, retentionDays),
    );

    this.logger.log(`Data portability export produced for person ${personId}`);
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
                // The identifier is the charges section's, not this one's: a
                // charge put on an apartment names no person, so which of them
                // are this person's is answered by where they were living.
                id: true,
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
          // The id as well as the account's own fields: a consent to a
          // connected app names the account rather than the person, so the
          // grants below are reached one step further out.
          select: {
            id: true,
            email: true,
            twoFactorEnabled: true,
            createdAt: true,
          },
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

    /*
     * The apps this person allowed to act for them.
     *
     * Reached through the account rather than through the person: a consent
     * names the account it was given from, because that is what the app was
     * authorised against. Somebody with no account has authorised nothing, and
     * the query is not asked at all rather than asked with an id that cannot
     * match.
     */
    const account = person.userAccount;
    const connectedAppConsents =
      account === null
        ? []
        : await tx.oauthConsent.findMany({
            where: { userId: account.id },
            orderBy: [{ createdAt: "desc" }],
            select: {
              clientId: true,
              scopes: true,
              createdAt: true,
              client: {
                select: { name: true, clientDiscoveryId: true, uri: true },
              },
            },
          });
    const tokenIssuedAt =
      account === null || connectedAppConsents.length === 0
        ? new Map<string, Date>()
        : await latestTokenIssuedPerClient(tx, account.id);

    const transfers = await tx.transfer.findMany({
      where: { OR: [{ fromPersonId: personId }, { toPersonId: personId }] },
      orderBy: [{ transferredOn: "asc" }],
      select: {
        id: true,
        kind: true,
        toPersonId: true,
        transferredOn: true,
        membershipDecidedOn: true,
        reportBasis: true,
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
     * The transfers on this report that went back, in both directions.
     *
     * Keyed on the transfers above rather than on a person column - the table
     * has none - which is the same reach the obligations below use. Both
     * directions, unlike the membership decision and the case: a reversal is an
     * event about the transfer itself and both parties were party to it going
     * back, and it states no fact about the other person that the transfer
     * section does not already carry.
     */
    const transferIds = transfers.map((transfer) => transfer.id);
    const transferReversals =
      transferIds.length === 0
        ? []
        : await tx.transferReversal.findMany({
            where: { transferId: { in: transferIds } },
            orderBy: [{ reversedOn: "asc" }],
            select: {
              id: true,
              transferId: true,
              kind: true,
              reversedOn: true,
              reference: true,
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
    const reportedReversalIds = transferReversals.map(
      (reversal) => reversal.id,
    );
    const registerReportObligations =
      reportedTerminationIds.length === 0 &&
      acquiredTransferIds.length === 0 &&
      reportedReversalIds.length === 0
        ? []
        : await tx.registerReportObligation.findMany({
            where: {
              OR: [
                { terminationId: { in: reportedTerminationIds } },
                { transferId: { in: acquiredTransferIds } },
                { reversalId: { in: reportedReversalIds } },
              ],
            },
            /*
             * Nulls last, so the one duty the statute sets no deadline for reads
             * after the dated ones rather than ahead of them: PostgreSQL sorts
             * nulls last on ASC by default, and stating it here keeps the report
             * ordered the way the queue is whatever the default becomes.
             */
            orderBy: [{ dueOn: { sort: "asc", nulls: "last" } }],
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
     * Entries this person filed into an apartment binder. Metadata only, like
     * the archive's documents above: the title and the kind say what they
     * filed, and the file itself is fetched from the media route by whoever
     * may have it.
     */
    const apartmentDocuments = await tx.apartmentDocument.findMany({
      where: { filedByPersonId: personId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        title: true,
        datedOn: true,
        createdAt: true,
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
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
     * Motions this person put to the general meeting. `submittedByPersonId` is
     * a plain column and not a relation, for the reason the bookings query
     * above gives, so this is a query of its own.
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
     * Subletting applications this person made. `appliedByPersonId` is a plain
     * column and not a relation, for the reason the bookings query above gives,
     * so this is a query of its own; the apartment IS one, which is how the
     * address reaches the document without being copied onto the application.
     */
    const subletApplications = await tx.subletApplication.findMany({
      where: { appliedByPersonId: personId },
      orderBy: [{ submittedAt: "desc" }],
      select: {
        id: true,
        periodFrom: true,
        periodTo: true,
        reason: true,
        status: true,
        submittedAt: true,
        closedAt: true,
        decisionNote: true,
        tribunalPermittedOn: true,
        tribunalPermittedUntil: true,
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
      },
    });

    /*
     * Keys and tags this person ordered. `orderedByPersonId` is a plain column
     * and not a relation, for the reason the bookings query above gives.
     */
    const keyOrders = await tx.keyOrder.findMany({
      where: { orderedByPersonId: personId },
      orderBy: [{ submittedAt: "desc" }],
      select: {
        id: true,
        kind: true,
        quantity: true,
        note: true,
        status: true,
        submittedAt: true,
        closedAt: true,
        boardNote: true,
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
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
     * Charges the association put on this person, and the ones it put on an
     * apartment while they were living in it.
     *
     * Two readings of one table because a charge names one or the other and
     * never both. `personId` is a plain column and not a relation, for the
     * reason `bookedByPersonId` is, so the first is a query of its own; the
     * second reaches the rows through the apartments this person's residencies
     * name and is then bounded by the dates of those residencies, because an
     * apartment-keyed charge from before they moved in is the previous
     * household's.
     *
     * The apartment IS a relation on the charge, so its designation is read
     * along rather than copied onto the row.
     */
    const residencyPeriods = person.residencies.map((residency) => ({
      apartmentId: residency.apartment.id,
      from: residency.movedInOn,
      until: residency.movedOutOn,
    }));
    const residentApartmentIds = [
      ...new Set(residencyPeriods.map((period) => period.apartmentId)),
    ];
    const chargeFields = {
      id: true,
      personId: true,
      apartmentId: true,
      chargedOn: true,
      amount: true,
      reason: true,
      vatTreatment: true,
      vatRatePercent: true,
      handedToManagerOn: true,
      // The month its books began in, which its erasure date is counted from.
      financialYearStartMonth: true,
      apartment: {
        select: {
          number: true,
          address: { select: { street: true, number: true } },
        },
      },
    } as const;

    const ownCharges = await tx.memberCharge.findMany({
      where: { personId },
      orderBy: [{ chargedOn: "desc" }],
      select: chargeFields,
    });
    const apartmentCharges =
      residentApartmentIds.length === 0
        ? []
        : chargesDuringResidency(
            await tx.memberCharge.findMany({
              where: { apartmentId: { in: residentApartmentIds } },
              orderBy: [{ chargedOn: "desc" }],
              select: chargeFields,
            }),
            residencyPeriods,
          );

    /*
     * The fee rates that stood against the flats this person lived in, and the
     * notices issued from them.
     *
     * Reached through the residency, exactly as an apartment-keyed charge is: a
     * fee names an apartment and never a person, so the overlap between the
     * row's own period and the residency is the whole of the inference. Both
     * boundaries are closed, on `charges/apartment-charges.ts`'s argument.
     *
     * A rate still in force has no end date, so its overlap is open at that end
     * and it is on the report of anybody living there now.
     */
    const feesDuringResidency =
      residentApartmentIds.length === 0
        ? []
        : (
            await tx.fee.findMany({
              where: { apartmentId: { in: residentApartmentIds } },
              orderBy: [{ appliesFrom: "desc" }],
              select: {
                id: true,
                apartmentId: true,
                kind: true,
                appliesFrom: true,
                appliesUntil: true,
                monthlyAmount: true,
                vatTreatment: true,
                vatRatePercent: true,
                financialYearStartMonth: true,
                apartment: {
                  select: {
                    number: true,
                    address: { select: { street: true, number: true } },
                  },
                },
              },
            })
          ).filter((fee) =>
            overlapsResidency(
              residencyPeriods,
              fee.apartmentId,
              fee.appliesFrom,
              fee.appliesUntil,
            ),
          );

    const feeNoticesDuringResidency =
      residentApartmentIds.length === 0
        ? []
        : (
            await tx.feeNotice.findMany({
              where: { apartmentId: { in: residentApartmentIds } },
              orderBy: [{ notification: { periodTo: "desc" } }],
              select: {
                id: true,
                apartmentId: true,
                amount: true,
                paymentReference: true,
                notification: {
                  select: {
                    periodFrom: true,
                    periodTo: true,
                    dueOn: true,
                    issuedAt: true,
                    financialYearStartMonth: true,
                  },
                },
                apartment: {
                  select: {
                    number: true,
                    address: { select: { street: true, number: true } },
                  },
                },
              },
            })
          ).filter((notice) =>
            overlapsResidency(
              residencyPeriods,
              notice.apartmentId,
              notice.notification.periodFrom,
              notice.notification.periodTo,
            ),
          );

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
     * What this person wrote in the chat, grouped by the room it was written in.
     *
     * Their own messages only. The other members of a room wrote about
     * themselves and about the association's business, and a report carrying the
     * whole room would hand one board member everything the other seven said.
     *
     * The room is joined for its kind and its name, because the board chat has
     * no name - its name is its kind - and a report saying "chat" without saying
     * which would name nothing.
     */
    const chatMessages = await tx.chatMessage.findMany({
      where: { authorPersonId: personId },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        chatId: true,
        body: true,
        struckAt: true,
        createdAt: true,
        chat: { select: { kind: true, name: true } },
      },
    });

    /*
     * The groups they are in, which is a fact about them whether or not they
     * have written anything in one.
     *
     * Read separately from the messages because the two answer different
     * questions: a room somebody was put into last week and has said nothing in
     * is still a private room they can read, and a report that only listed the
     * rooms they had written in would leave that off.
     */
    const chatMemberships = await tx.chatGroupMember.findMany({
      where: { personId },
      orderBy: [{ joinedAt: "asc" }],
      select: {
        chatId: true,
        joinedAt: true,
        chat: { select: { kind: true, name: true } },
      },
    });

    /*
     * How far they have read each room, including rooms they never wrote in.
     *
     * Every marker they hold rather than only the ones behind their own
     * messages. A marker is a fact the association stores about this person -
     * that they opened this room, and how far down it they had got - and it is
     * stored whether or not they ever answered. Somebody who reads the board
     * chat every week and writes in it twice a year holds markers with nothing
     * of theirs behind them, and art. 15 is a right to what is held rather than
     * to what is interesting: withholding those would make the access report,
     * and the art. 20 export that projects from it, incomplete about data this
     * instance is keeping.
     *
     * A room reached only this way is on the report with an empty list of
     * messages, which is the true statement - the person read it and wrote
     * nothing - rather than an absence that says neither.
     */
    const chatReadRows = await tx.chatRead.findMany({
      where: { personId },
      select: { chatId: true, readAt: true },
    });

    /*
     * The rooms those markers name, read by identifier.
     *
     * A marker whose room has since gone is dropped rather than reported as a
     * room with no name. A marker is deleted with its room, but the chat purge
     * erases an empty group on its own clock and this report reads markers and
     * rooms in two statements, so a room erased between them leaves a marker
     * read a moment earlier - and what that names is a room that was erased
     * rather than a room this person can be told about.
     */
    const chatRooms =
      chatReadRows.length === 0
        ? []
        : await tx.chat.findMany({
            where: {
              id: { in: [...new Set(chatReadRows.map((read) => read.chatId))] },
            },
            select: { id: true, kind: true, name: true },
          });
    const roomsById = new Map(chatRooms.map((room) => [room.id, room]));

    const chatReads = chatReadRows.flatMap((read) => {
      const room = roomsById.get(read.chatId);
      return room === undefined
        ? []
        : [{ chatId: read.chatId, readAt: read.readAt, chat: room }];
    });

    /*
     * The messages this person reported to the board, and the ones they answered
     * as a board member.
     *
     * Both parts, because both are facts about this person: reporting a message
     * is an act of theirs that the association holds a record of, and answering
     * one is an act the board is answerable for. What the row never carries onto
     * this document is the message itself - it was written by somebody else, and
     * their words are their own data rather than this person's.
     */
    const chatReports = await tx.chatMessageReport.findMany({
      where: {
        OR: [{ reporterPersonId: personId }, { resolvedByPersonId: personId }],
      },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        reporterPersonId: true,
        note: true,
        createdAt: true,
        resolvedAt: true,
        upheld: true,
        message: { select: { chat: { select: { name: true } } } },
      },
    });

    /* The person's own address, printed on the document and nothing else. */
    const personEmail =
      person.emailCipher === null
        ? null
        : await this.encryption.decrypt("person.email", person.emailCipher);

    /*
     * Correspondence in the board's shared mailbox this person was established
     * to be the correspondent of.
     *
     * Reached through the link the thread carries and not through the address on
     * it. The address was what this asked once, by indexing the person's
     * registered address under the mailbox table's label and matching threads on
     * it, and that question has no safe answer: `Person.emailIndex` carries no
     * unique constraint and a thread records no period over which an address
     * belonged to anybody, so it answered "whoever holds this address now". A
     * household that gave the association one address had each resident's report
     * carry the other's letters to the board, and an address recorded later for
     * somebody else - a styrelsen@ seat changing hands - put the previous
     * holder's correspondence into the new holder's report. This document is the
     * one the association produces to show it handles personal data properly,
     * and a disclosure inside it is the worst place for one.
     *
     * So the identification is the board mailbox's to make, at the moment the
     * letter arrives and only where the register then held that address for
     * exactly one person. A thread nobody was established to be carries no link
     * and is in no report - including every thread collected before the column
     * existed, which is the honest answer rather than a guess made years later.
     * The model comment on BoardMailboxThread sets out why the legal hold still
     * asks the address instead, and `ReportBoardMailboxThread` says what the
     * document prints.
     */
    const boardMailboxThreads = await tx.boardMailboxThread.findMany({
      where: { correspondentPersonId: personId },
      orderBy: [{ lastMessageAt: "desc" }],
      select: {
        id: true,
        subject: true,
        status: true,
        // The address the thread itself holds, rather than the one on the
        // person. It is what the association is keeping on this row, and it can
        // be spelled differently from the registered one - the index that
        // established the link normalises - or be all that is left of the
        // person's contact details once a purge has run.
        correspondentEmailCipher: true,
        createdAt: true,
        lastMessageAt: true,
        messages: {
          orderBy: { occurredAt: "asc" },
          select: {
            direction: true,
            body: true,
            bodyFromHtml: true,
            bodyTruncated: true,
            occurredAt: true,
            _count: { select: { attachments: true } },
          },
        },
      },
    });

    /*
     * Every line on which this person was recorded as present at a general
     * meeting, the ones the board struck off again included. `personId` is a
     * plain column and not a relation, for the reason `bookedByPersonId` is, so
     * this is a query of its own; the meeting IS one, which is how the day and
     * the kind reach the document without being copied onto the line.
     *
     * One person can be on one meeting's list twice - as a member and as an
     * proxy holder, which is the ordinary case for somebody arriving with a
     * neighbour's proxy authorisation - so this section has a row per capacity
     * rather than per meeting.
     */
    const meetingAttendances = await tx.meetingAttendance.findMany({
      where: { personId },
      orderBy: [{ meeting: { heldOn: "desc" } }, { capacity: "asc" }],
      select: {
        id: true,
        capacity: true,
        mode: true,
        onBehalfOfPersonId: true,
        withdrawnAt: true,
        meeting: { select: { heldOn: true, kind: true } },
      },
    });

    /*
     * Every proxy authorisation (fullmakt) naming this person, either way
     * round. The authorisation names the member whose vote is to be exercised
     * and the proxy holder authorised to exercise it, and both of those are
     * facts
     * about the person concerned, so this is one query with an OR - the shape
     * the audit log query below uses over its own two person columns, and for
     * the same reason.
     *
     * A row can match both sides at once only if somebody appointed themselves,
     * which the table refuses outright, so the role each row carries is decided
     * by which column matched and there is no third case.
     */
    const proxyAuthorisations = await tx.proxyAuthorisation.findMany({
      where: {
        OR: [{ memberPersonId: personId }, { proxyHolderPersonId: personId }],
      },
      orderBy: [{ meeting: { heldOn: "desc" } }, { createdAt: "desc" }],
      select: {
        id: true,
        memberPersonId: true,
        proxyHolderPersonId: true,
        ground: true,
        authorisedOn: true,
        withdrawnAt: true,
        meeting: { select: { heldOn: true, kind: true } },
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
        channel: true,
        createdAt: true,
        actorPersonId: true,
        targetPersonId: true,
        targetKind: true,
        targetId: true,
        context: true,
      },
    });

    /*
     * What this person asked about their own data, and what the board decided.
     * Theirs by definition: art. 15 gives them what the association holds about
     * them, and a decision about their erasure is that.
     */
    const dataSubjectRequests = await tx.dataSubjectRequest.findMany({
      where: { personId },
      orderBy: [{ requestedOn: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        requestedOn: true,
        ground: true,
        erasureGround: true,
        erasureException: true,
        issueId: true,
        decision: true,
        decisionGround: true,
        decidedAt: true,
        executedAt: true,
        closedAt: true,
        closeReason: true,
      },
    });

    /*
     * Breaches that reached this person's data. Read through the subject rows,
     * which is the only link there is: a person a breach reached is recorded on
     * it individually, because art. 34 is owed to each of them.
     *
     * The board's grounds for its own decisions are deliberately not here. Why
     * the association did or did not notify IMY is a fact about its compliance,
     * not about this person's data, and art. 15 gives them the second.
     */
    const breachSubjects = await tx.personalDataBreachSubject.findMany({
      where: { personId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        informedAt: true,
        breach: {
          select: {
            id: true,
            title: true,
            discoveredAt: true,
            risk: true,
            imyNotifiedAt: true,
          },
        },
      },
    });

    const lastMovedOutOn = latestMoveOut(person.residencies);

    return {
      /*
       * The association's own calendar day, not the UTC one. This stamps the
       * art. 15 report handed to the person who asked for it, a document whose
       * every other date is stated on that calendar, and a report produced at
       * half past midnight on the 6th of March would otherwise state the 5th.
       */
      generatedOn: formatLocalDay(localDayOf(now)),
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
        email: personEmail,
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
        movedInOn: formatDateColumn(residency.movedInOn),
        movedOutOn: formatDateColumn(residency.movedOutOn),
        purgeOn: formatDateColumn(
          computePurgeDate(residency.movedOutOn, retentionDays),
        ),
      })),
      boardPositions: person.boardPositions.map((position) => ({
        position: position.position,
        electedOn: formatDateColumn(position.electedOn),
        endedOn: formatDateColumn(position.endedOn),
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
      connectedApps: connectedAppConsents.map((consent) => ({
        clientName: consent.client.name,
        clientHost: connectedAppHost(consent.client),
        /*
         * Narrowed to the scopes the provider issues. A client may only ask for
         * one the provider advertises, so this drops nothing a grant can hold;
         * what it buys is a closed set the document can state in words rather
         * than a bare string printed as the protocol spells it.
         */
        scopes: consent.scopes.filter(isConnectedAppScope),
        connectedAt: consent.createdAt.toISOString(),
        /*
         * When a token was last issued for this grant, and never a token. The
         * date says the app came back for access around then; what it did with
         * it is in the entries section, which is the only place this document
         * answers that.
         */
        lastUsedAt: tokenIssuedAt.get(consent.clientId)?.toISOString() ?? null,
      })),
      memberRegisterEntries: person.memberRegisterEntries.map((entry) => ({
        entryId: entry.id,
        eventType: entry.eventType,
        eventOn: formatDateColumn(entry.eventOn) ?? "",
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
        kind: transfer.kind,
        transferredOn: formatDateColumn(transfer.transferredOn) ?? "",
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
            ? formatDateColumn(transfer.membershipDecidedOn)
            : null,
        // Withheld from the seller for the same reason and on the same test.
        // The value says that the acquirer was already a member, or fell
        // outside the membership requirement, or is a lienholding juridical
        // person - each a fact about them and not about the person selling.
        reportBasis:
          transfer.toPersonId === personId ? transfer.reportBasis : null,
      })),
      transferReversals: transferReversals.map((reversal) => ({
        reversalId: reversal.id,
        transferId: reversal.transferId,
        apartment: `${reversal.apartment.address.street} ${reversal.apartment.address.number} ${reversal.apartment.number}`,
        kind: reversal.kind,
        reversedOn: formatDateColumn(reversal.reversedOn) ?? "",
        reference: reversal.reference,
      })),
      terminations: terminations.map((termination) => ({
        terminationId: termination.id,
        apartment: `${termination.apartment.address.street} ${termination.apartment.address.number} ${termination.apartment.number}`,
        kind: termination.kind,
        tookEffectOn: formatDateColumn(termination.tookEffectOn) ?? "",
        reference: termination.reference,
      })),
      lienNotes: lienNotes.map((note) => ({
        lienNoteId: note.id,
        apartment: `${note.apartment.address.street} ${note.apartment.address.number} ${note.apartment.number}`,
        creditor: note.creditor,
        // Decimal through its own toString, for the reason the transfer price
        // gives: a float would round a sum on a statutory record.
        amount: note.amount === null ? null : note.amount.toString(),
        notedOn: formatDateColumn(note.notedOn) ?? "",
        releasedOn: formatDateColumn(note.releasedOn),
      })),
      registerReportObligations: registerReportObligations.map(
        (obligation) => ({
          obligationId: obligation.id,
          kind: obligation.kind,
          apartment: `${obligation.apartment.address.street} ${obligation.apartment.address.number} ${obligation.apartment.number}`,
          triggeredOn: formatDateColumn(obligation.triggeredOn) ?? "",
          dueOn: formatDateColumn(obligation.dueOn),
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
      apartmentDocuments: apartmentDocuments.map((entry) => ({
        apartmentDocumentId: entry.id,
        apartment: `${entry.apartment.address.street} ${entry.apartment.address.number} ${entry.apartment.number}`,
        kind: entry.kind,
        title: entry.title,
        datedOn:
          entry.datedOn === null
            ? null
            : formatLocalDay(localDayOfColumn(entry.datedOn)),
        filedAt: entry.createdAt.toISOString(),
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
         *
         * The purge date is an instant and not a date column - the window is
         * counted in milliseconds from `endsAt`, deliberately - so the day it
         * falls on is read on the association's calendar. A booking ending at
         * half past eleven on a March evening yields a purge instant of 22:30
         * UTC a year later, which is the following day here.
         */
        erasableFrom: formatDayOfInstant(
          computeBookingPurgeDate(booking.endsAt),
        ),
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
         *
         * An instant and not a date column, read on the association's calendar
         * exactly as the booking's is.
         */
        erasableFrom: formatDayOfInstant(
          computeMotionPurgeDate(motion.closedAt),
        ),
      })),
      subletApplications: subletApplications.map((application) => ({
        applicationId: application.id,
        apartment:
          application.apartment === null
            ? null
            : `${application.apartment.address.street} ${application.apartment.address.number} ${application.apartment.number}`,
        // formatDateColumn and not `formatLocalDay(localDayOf(...))`, exactly
        // as every other `@db.Date` column on this document is rendered: the
        // column is read back as midnight UTC, and its UTC fields are the date
        // it holds.
        periodFrom: formatDateColumn(application.periodFrom) ?? "",
        periodTo: formatDateColumn(application.periodTo) ?? "",
        reason: application.reason,
        status: application.status,
        submittedAt: application.submittedAt.toISOString(),
        closedAt: application.closedAt?.toISOString() ?? null,
        decisionNote: application.decisionNote,
        tribunalPermittedOn: formatDateColumn(application.tribunalPermittedOn),
        tribunalPermittedUntil: formatDateColumn(
          application.tribunalPermittedUntil,
        ),
        /*
         * Derived here rather than stored, as a residency's and a booking's are,
         * and from the later of two anchors: the day it closed and the day the
         * period applied for ended. Null while it is open, which is not a gap in
         * the answer - there is no closing date to count from, and the
         * association is still processing it.
         *
         * An instant and not a date column, read on the association's calendar
         * exactly as the booking's is, whichever of the two anchors won.
         */
        erasableFrom: formatDayOfInstant(
          computeSubletPurgeDate(application.closedAt, application.periodTo),
        ),
      })),
      keyOrders: keyOrders.map((order) => ({
        orderId: order.id,
        apartment:
          order.apartment === null
            ? null
            : `${order.apartment.address.street} ${order.apartment.address.number} ${order.apartment.number}`,
        kind: order.kind,
        quantity: order.quantity,
        note: order.note,
        status: order.status,
        submittedAt: order.submittedAt.toISOString(),
        closedAt: order.closedAt?.toISOString() ?? null,
        boardNote: order.boardNote,
        // Derived here rather than stored, and anchored on the closing date the
        // way a motion's is. Null while the order is open. An instant and not a
        // date column, read on the association's calendar.
        erasableFrom: formatDayOfInstant(
          computeKeyOrderPurgeDate(order.closedAt),
        ),
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
        // has no further use for it. An instant and not a date column, read on
        // the association's calendar.
        erasableFrom: formatDayOfInstant(
          computeEventSignupPurgeDate(signup.occurrence.endsAt),
        ),
      })),
      memberCharges: [...ownCharges, ...apartmentCharges].map(
        (charge): ReportMemberCharge => ({
          chargeId: charge.id,
          basis: charge.personId === null ? "apartment" : "person",
          chargedOn: formatDateColumn(charge.chargedOn) ?? "",
          // toFixed and not toString: a DECIMAL(14, 2) holding 450 renders as
          // "450" through the latter, and this document states ore.
          amount: charge.amount.toFixed(2),
          vatTreatment: charge.vatTreatment,
          vatRatePercent: charge.vatRatePercent,
          reason: charge.reason,
          apartment:
            charge.apartment === null
              ? null
              : `${charge.apartment.address.street} ${charge.apartment.address.number} ${charge.apartment.number}`,
          handedToManagerOn: formatDateColumn(charge.handedToManagerOn),
          /*
           * Derived here rather than stored, exactly as the booking's is, and
           * anchored on the charge's financial year rather than on a move-out:
           * the row belongs to a financial year, and it is that year that
           * decides when the association has no further use for it. The month
           * that year begins in is the one stamped on the charge when it was
           * recorded, which is what the purge reads too - so this states the
           * day the purge will act on, and a later change to the setting cannot
           * move a date this document has already given.
           */
          erasableFrom:
            formatDateColumn(
              computeMemberChargePurgeDate(
                charge.chargedOn,
                charge.financialYearStartMonth,
              ),
            ) ?? "",
        }),
      ),
      fees: feesDuringResidency.map((fee): ReportFee => ({
        feeId: fee.id,
        apartment: `${fee.apartment.address.street} ${fee.apartment.address.number} ${fee.apartment.number}`,
        kind: fee.kind,
        appliesFrom: formatDateColumn(fee.appliesFrom) ?? "",
        appliesUntil: formatDateColumn(fee.appliesUntil),
        // toFixed and not toString: a DECIMAL(14, 2) holding 450 renders as
        // "450" through the latter, and this document states ore.
        monthlyAmount: fee.monthlyAmount.toFixed(2),
        vatTreatment: fee.vatTreatment,
        vatRatePercent: fee.vatRatePercent,
        /*
         * Null while the rate is in force, because there is no date: a rate
         * still applying is a fact that is still true, no preservation period
         * has run out on it, and the clock starts on the day it stops
         * applying.
         */
        erasableFrom:
          fee.appliesUntil === null
            ? null
            : formatDateColumn(
                computeFeePurgeDate(
                  fee.appliesUntil,
                  fee.financialYearStartMonth,
                ),
              ),
      })),
      feeNotices: feeNoticesDuringResidency.map((notice): ReportFeeNotice => ({
        noticeId: notice.id,
        apartment: `${notice.apartment.address.street} ${notice.apartment.address.number} ${notice.apartment.number}`,
        periodFrom: formatDateColumn(notice.notification.periodFrom) ?? "",
        periodTo: formatDateColumn(notice.notification.periodTo) ?? "",
        dueOn: formatDateColumn(notice.notification.dueOn) ?? "",
        issuedOn: formatLocalDay(localDayOf(notice.notification.issuedAt)),
        amount: notice.amount.toFixed(2),
        paymentReference: notice.paymentReference,
        /*
         * Derived here rather than stored, and anchored on the end of the
         * period the notice billed: the row belongs to a financial year, and
         * it is that year that decides when the association has no further use
         * for it.
         */
        erasableFrom:
          formatDateColumn(
            computeFeePurgeDate(
              notice.notification.periodTo,
              notice.notification.financialYearStartMonth,
            ),
          ) ?? "",
      })),
      boardMailboxThreads: await Promise.all(
        boardMailboxThreads.map(
          async (thread): Promise<ReportBoardMailboxThread> => ({
            threadId: thread.id,
            // Read off the thread and not off the person. Printing the
            // registered spelling back would state a value the association does
            // not hold on the row being reported, and the row's own address is
            // what it has to answer for: the address an envelope asserted, which
            // is still not a claim about who wrote.
            correspondentEmail: await this.encryption.decrypt(
              "boardMailboxThread.correspondentEmail",
              thread.correspondentEmailCipher,
            ),
            subject: thread.subject,
            status: thread.status,
            // In full, both directions. What was written to the association and
            // what it answered are both personal data about the person this
            // document is for, and a report that gave the question without the
            // answer would be the half that is easier to produce rather than the
            // half that was asked for.
            messages: thread.messages.map((message) => ({
              direction: message.direction,
              body: message.body,
              bodyFromHtml: message.bodyFromHtml,
              bodyTruncated: message.bodyTruncated,
              attachments: message._count.attachments,
              occurredAt: message.occurredAt.toISOString(),
            })),
            startedAt: thread.createdAt.toISOString(),
            lastMessageAt: thread.lastMessageAt.toISOString(),
            /*
             * Derived here rather than stored, exactly as the booking's and the
             * comment's are: a shorter retention window moves every pending date
             * by that act alone, and this document has to state the date that will
             * actually apply.
             *
             * The earliest date the purge can reach the thread rather than the
             * date it goes on, because a legal hold suspends the purge.
             */
            erasableFrom: computeBoardMailboxPurgeDate(
              thread.lastMessageAt,
            ).toISOString(),
          }),
        ),
      ),
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
         *
         * An instant and not a date column, read on the association's calendar
         * exactly as the booking's is.
         */
        erasableFrom: formatDayOfInstant(
          computeNewsCommentPurgeDate(comment.createdAt),
        ),
      })),
      chats: groupChatMessages(chatMessages, chatMemberships, chatReads),
      chatReports: chatReports.map((report): ReportChatReport => {
        const reported = report.reporterPersonId === personId;
        return {
          reportId: report.id,
          part: reported ? "REPORTED" : "ANSWERED",
          groupName: report.message.chat.name,
          reportedAt: report.createdAt.toISOString(),
          /*
           * The reporter's own words, and only to them. A board member reading
           * their own report is being told which reports they answered, not
           * what a neighbour wrote about another one.
           */
          note: reported ? report.note : null,
          answeredAt: report.resolvedAt?.toISOString() ?? null,
          /*
           * What the board decided, or null while the report is open. Stated
           * because it is the answer this person is owed: somebody who reported
           * a message is entitled to know whether anything came of it.
           */
          struck: report.upheld,
        };
      }),
      meetingAttendances: meetingAttendances.map(
        (attendance): ReportMeetingAttendance => ({
          attendanceId: attendance.id,
          meetingHeldOn:
            formatDateColumn(attendance.meeting.heldOn) ??
            attendance.meeting.heldOn.toISOString(),
          meetingKind: attendance.meeting.kind,
          capacity: attendance.capacity,
          mode: attendance.mode,
          // An identifier and never a name: the member or proxy holder an
          // assistant came with is a third party on a document the association
          // hands over.
          onBehalfOfPersonId: attendance.onBehalfOfPersonId,
          withdrawnAt: attendance.withdrawnAt?.toISOString() ?? null,
          // No erasure date, and the section's own comment says why: nothing
          // purges a line of the meeting's record.
        }),
      ),
      proxyAuthorisations: proxyAuthorisations.map(
        (authorisation): ReportProxyAuthorisation => {
          /*
           * Which side of the authorisation this person is on. The member column
           * is tested first because the table refuses an authorisation naming one
           * person on both sides, so a match there settles it.
           */
          const asMember = authorisation.memberPersonId === personId;
          return {
            authorisationId: authorisation.id,
            meetingHeldOn:
              formatDateColumn(authorisation.meeting.heldOn) ??
              authorisation.meeting.heldOn.toISOString(),
            meetingKind: authorisation.meeting.kind,
            role: asMember ? "member" : "proxyHolder",
            counterpartPersonId: asMember
              ? authorisation.proxyHolderPersonId
              : authorisation.memberPersonId,
            ground: authorisation.ground,
            authorisedOn:
              formatDateColumn(authorisation.authorisedOn) ??
              authorisation.authorisedOn.toISOString(),
            withdrawnAt: authorisation.withdrawnAt?.toISOString() ?? null,
          };
        },
      ),
      auditEntries: auditEntries.map((entry): ReportAuditEntry => ({
        entryId: entry.id,
        role: entry.targetPersonId === personId ? "subject" : "actor",
        action: entry.action,
        at: entry.createdAt.toISOString(),
        channel: entry.channel,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        context: subjectScopedContext(asContext(entry.context), personId),
      })),
      dataSubjectRequests: dataSubjectRequests.map(
        (request): ReportDataSubjectRequest => ({
          requestId: request.id,
          kind: request.kind,
          requestedOn: formatDateColumn(request.requestedOn),
          dueOn: formatDateColumn(dueOn(request.requestedOn)),
          ground: request.ground,
          erasureGround: request.erasureGround,
          erasureException: request.erasureException,
          decision: request.decision,
          decisionGround: request.decisionGround,
          /*
           * These three are plain `DateTime` and the two above them are
           * `@db.Date`, which is the whole of the difference: `requestedOn` is a
           * day the board wrote down and is read as the UTC midnight it was
           * stored at, while a decision, an execution and a closing happened at
           * a moment and are stated as the day that moment fell on here. A
           * request closed at half past midnight would otherwise be reported as
           * closed the day before, on the document that answers when the
           * association met its art. 12(3) deadline.
           */
          decidedAt: formatDayOfInstant(request.decidedAt),
          executedAt: formatDayOfInstant(request.executedAt),
          closedAt: formatDayOfInstant(request.closedAt),
          closeReason: request.closeReason,
          issueId: request.issueId,
        }),
      ),
      personalDataBreaches: breachSubjects.map(
        (subject): ReportPersonalDataBreach => ({
          breachId: subject.breach.id,
          title: subject.breach.title,
          discoveredAt: subject.breach.discoveredAt.toISOString(),
          risk: subject.breach.risk,
          imyNotifiedAt: subject.breach.imyNotifiedAt?.toISOString() ?? null,
          informedAt: subject.informedAt?.toISOString() ?? null,
        }),
      ),
      retention: {
        daysAfterMoveOut: retentionDays,
        purgeOn: formatDateColumn(
          computePurgeDate(lastMovedOutOn, retentionDays),
        ),
        onLegalHold: person.legalHolds.some((hold) => hold.releasedAt === null),
      },
    };
  }
}

/** The scopes the provider issues, which is what a consent row can hold. */
const CONNECTED_APP_SCOPES: readonly ReportConnectedAppScope[] = [
  "mcp:read",
  "mcp:write",
  "offline_access",
];

function isConnectedAppScope(value: string): value is ReportConnectedAppScope {
  return (CONNECTED_APP_SCOPES as readonly string[]).includes(value);
}

/**
 * The newest token row held per client for one account, by the day it was
 * issued.
 *
 * Both tables, because the two run out on different clocks: an access row lasts
 * minutes and a refresh row a week, so the access rows alone would answer "not
 * lately" for an app that was refreshing its access yesterday. The newest of
 * the two is the last moment the association handed this app anything.
 *
 * Tokens that were taken back are left out. A disconnect deletes the access
 * rows and marks the refresh rows revoked, and the revoked ones are kept for a
 * week so a replay of them is still recognised - so somebody who disconnected
 * an app and connected it again would otherwise have the grant they hold now
 * dated by the one they gave up, on a day before they gave this one.
 *
 * Two grouped queries rather than one per grant: somebody with several apps
 * would otherwise cost a query each on the most disclosure-heavy read in the
 * product. Nothing but the timestamp is selected - a token row's own column
 * holds a digest of a live credential, which no report may carry.
 */
async function latestTokenIssuedPerClient(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<Map<string, Date>> {
  const [access, refresh] = await Promise.all([
    tx.oauthAccessToken.groupBy({
      by: ["clientId"],
      where: { userId, revoked: null },
      _max: { createdAt: true },
    }),
    tx.oauthRefreshToken.groupBy({
      by: ["clientId"],
      where: { userId, revoked: null },
      _max: { createdAt: true },
    }),
  ]);

  const latest = new Map<string, Date>();
  for (const row of [...access, ...refresh]) {
    const issuedAt = row._max.createdAt;
    if (issuedAt === null) {
      continue;
    }
    const held = latest.get(row.clientId);
    if (held === undefined || issuedAt.getTime() > held.getTime()) {
      latest.set(row.clientId, issuedAt);
    }
  }
  return latest;
}

/**
 * The latest move-out across every residency, or null while any is current.
 *
 * The purge date the report states is the one that governs the person, not the
 * one that governs a residency: somebody who moved out of one apartment and
 * still lives in another has no purge date at all, and stating the first
 * residency's would promise an erasure that is not going to happen.
 */
/**
 * Whether a dated period on an apartment overlaps one of this person's
 * residencies there.
 *
 * The range form of the rule `charges/apartment-charges.ts` states for a single
 * day, and it is here rather than beside that one because a fee must not depend
 * on the charges module: the two are separate concepts with separate tables, and
 * this document is the one place that reads both.
 *
 * Both boundaries are closed, on that module's own argument: a residency that
 * ended on the day a period opened did overlap it, and so did one that began on
 * the day it closed. An open end - a rate still in force, which carries no
 * closing date - overlaps every residency that has not ended before it began.
 *
 * Read as calendar days rather than as instants, because these are date columns
 * and a date column read back is midnight UTC.
 */
function overlapsResidency(
  residencies: readonly {
    apartmentId: string;
    from: Date;
    until: Date | null;
  }[],
  apartmentId: string,
  from: Date,
  until: Date | null,
): boolean {
  const start = localDayOfColumn(from);
  const end = until === null ? null : localDayOfColumn(until);

  return residencies.some((residency) => {
    if (residency.apartmentId !== apartmentId) {
      return false;
    }
    const residencyStart = localDayOfColumn(residency.from);
    const residencyEnd =
      residency.until === null ? null : localDayOfColumn(residency.until);

    const startsBeforeResidencyEnds =
      residencyEnd === null || compareLocalDays(start, residencyEnd) <= 0;
    const endsAfterResidencyStarts =
      end === null || compareLocalDays(end, residencyStart) >= 0;

    return startsBeforeResidencyEnds && endsAfterResidencyStarts;
  });
}

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

/**
 * The context keys that carry other people's identifiers.
 *
 * An audit entry names everybody an act covered, because that is what makes the
 * act accountable: "who has seen these identity numbers" is answered by reading
 * `personIds` off a PROTECTED_DATA_REVEALED entry. Several acts cover more than
 * one person at a time - the apartment register's full extract, the initial
 * supply to the cooperative housing register - and the entry lists all of them.
 */
const CONTEXT_PERSON_LISTS = ["personIds", "protectedPersonIds"] as const;

/**
 * This person's chat rooms, with what they wrote in each.
 *
 * A free function because it holds no state and because the grouping is the one
 * decision this section makes: the read marker belongs to the room rather than
 * to a message, so the rooms have to exist on the report before the marker has
 * anywhere to sit.
 *
 * The groups they are in come first, in the order they were put into them, then
 * any room they have read, then any room they have written in that is neither -
 * the board chat, and a group they have since left. A room they have left is on
 * the report because their messages are still in it: leaving takes the
 * membership row away and changes nothing about what was said.
 *
 * Each room's messages stay in the order they were written, which the caller's
 * ascending sort gives for nothing.
 */
function groupChatMessages(
  messages: readonly {
    id: string;
    chatId: string;
    body: string;
    struckAt: Date | null;
    createdAt: Date;
    chat: { kind: "BOARD" | "GROUP"; name: string | null };
  }[],
  memberships: readonly {
    chatId: string;
    joinedAt: Date;
    chat: { kind: "BOARD" | "GROUP"; name: string | null };
  }[],
  reads: readonly {
    chatId: string;
    readAt: Date;
    chat: { kind: "BOARD" | "GROUP"; name: string | null };
  }[],
): ReportChat[] {
  const readAt = new Map(reads.map((read) => [read.chatId, read.readAt]));
  const rooms = new Map<string, ReportChat>();

  const room = (
    chatId: string,
    chat: { kind: "BOARD" | "GROUP"; name: string | null },
    joinedAt: Date | null,
  ): ReportChat => {
    const held = rooms.get(chatId);
    if (held !== undefined) {
      return held;
    }
    const fresh: ReportChat = {
      chatKind: chat.kind,
      chatName: chat.name,
      joinedOn: joinedAt?.toISOString() ?? null,
      readUpTo: readAt.get(chatId)?.toISOString() ?? null,
      messages: [],
    };
    rooms.set(chatId, fresh);
    return fresh;
  };

  for (const membership of memberships) {
    room(membership.chatId, membership.chat, membership.joinedAt);
  }

  /*
   * Then the rooms they have read, so a room they read and never wrote in is on
   * the report with an empty list of messages rather than missing from it. The
   * loop below fills in the ones they wrote in, and a room reached more than one
   * way is one room.
   */
  for (const read of reads) {
    room(read.chatId, read.chat, null);
  }

  for (const message of messages) {
    room(message.chatId, message.chat, null);
    rooms.get(message.chatId)?.messages.push({
      messageId: message.id,
      // In full. What somebody wrote is the personal data this section is
      // about, and nothing ever withholds a chat message from its own author.
      body: message.body,
      writtenAt: message.createdAt.toISOString(),
      /*
       * Whether the board struck it through. Their own text is on the report
       * either way - a strike withholds it from the room and never from its
       * author - and a document that printed it without saying so would leave
       * somebody unaware that a moderation about them had happened at all.
       */
      struckAt: message.struckAt?.toISOString() ?? null,
      /*
       * Derived here rather than stored, exactly as the news comment's is: a
       * shorter retention window moves every pending date by that act alone,
       * and this document has to state the date that will actually apply.
       *
       * The earliest date the purge can reach the row rather than the date it
       * goes on, because a legal hold suspends the purge for the whole person
       * and this document is read by the person a hold may be standing against.
       *
       * Read on the association's own calendar, because the purge date is an
       * instant and a day read off an instant in UTC names yesterday for an
       * hour or two after midnight here.
       */
      erasableFrom: formatDayOfInstant(
        computeChatMessagePurgeDate(message.createdAt),
      ),
    } satisfies ReportChatMessage);
  }

  return [...rooms.values()];
}

/**
 * The same context, with other data subjects taken out of it.
 *
 * The report prints an entry's context to the person it is about, and it carries
 * the entries where they were the actor as well as the ones where they were the
 * subject. So a board member who produced an act covering the whole house would
 * otherwise read every other holder's identifier off their own access report -
 * which GDPR art. 15(4) is precisely about: the right to a copy shall not
 * adversely affect the rights and freedoms of others.
 *
 * The lists are replaced by this person's own membership of them and by a count,
 * rather than removed. Removing them would leave the reader unable to tell an act
 * that covered them from one that did not, and the count is the part of the fact
 * that is about the act rather than about anybody else.
 *
 * The audit log itself is untouched. The entry keeps every identifier it was
 * written with; this narrows only what leaves the building on one document.
 */
function subjectScopedContext(
  context: Record<string, unknown> | null,
  personId: string,
): Record<string, unknown> | null {
  if (context === null) {
    return null;
  }

  const scoped: Record<string, unknown> = { ...context };
  for (const key of CONTEXT_PERSON_LISTS) {
    const value = context[key];
    if (!Array.isArray(value)) {
      continue;
    }
    scoped[key] = value.includes(personId) ? [personId] : [];
    scoped[`${key}Count`] = value.length;
  }
  return scoped;
}
