import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { toIsoDate } from "../address-book/address-book-view";
import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import type {
  DataSubjectReport,
  ReportAuditEntry,
  ReportPostalAddress,
} from "./data-subject-report";
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
  "publicationConsents",
  "legalHolds",
  "issues",
  "documents",
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
 * member register entries and transfers - even though those are exempt from
 * erasure, because exemption from purging is not exemption from access: a
 * person is entitled to see what the cooperative keeps about them and to be
 * told that it is kept because the law requires it, which the retention
 * section says.
 *
 * It carries issues and archived documents that reference the person even
 * though this train does not purge either. A report that omitted rows because
 * their retention story was unfinished would be an incomplete answer to an
 * access request, which is the one failure this document cannot have.
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
      })),
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
