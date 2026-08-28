import { Injectable } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";

/**
 * The statutory apartment register (lagenhetsforteckning), BRL 9 kap.
 *
 * A different document from the member register, with a different field list
 * and a different access rule, and the two must never be blended:
 *
 *   apartment designation, holder including personal identity number,
 *   initial share capital, participation share, liens with their note dates,
 *   transfers with their agreement references
 *
 * The member register is public on request. This one is confidential: the board
 * may read it, and a tenant-owner may read their own entry and nobody else's.
 * That is why this service, its controller and its screen are separate from the
 * member register's rather than one view with a flag - a flag is a thing that
 * can be wrong, and the wrong value here publishes personal identity numbers.
 *
 * The personal identity number is masked by default even here, and disclosed
 * only when the caller asks for the full statutory document. The disclosure is
 * written to the audit log naming every person it covered, because "who has
 * seen these identity numbers" is the question the log exists to answer.
 */

export class ApartmentRegisterError extends DomainError {
  override readonly status: number;
  override readonly reason: "apartment-not-found" | "lien-not-found";

  constructor(
    message: string,
    reason: "apartment-not-found" | "lien-not-found",
  ) {
    super(message);
    this.reason = reason;
    this.status = 404;
  }
}

/** A personal identity number is masked unless the extract disclosed it. */
export type RegisterIdentityNumber =
  | { state: "masked"; hasValue: boolean }
  | { state: "visible"; value: string | null };

export interface ApartmentRegisterHolder {
  personId: string;
  name: string;
  protectedPersonalData: boolean;
  personalIdentityNumber: RegisterIdentityNumber;
  heldFrom: string;
  /** Null while the tenant-ownership is still held. */
  heldUntil: string | null;
}

export interface ApartmentRegisterLien {
  id: string;
  creditor: string;
  /** Statutory date of record (anteckningsdag). */
  notedOn: string;
  releasedOn: string | null;
  amount: string | null;
}

export interface ApartmentRegisterTransfer {
  id: string;
  transferredOn: string;
  /** Null for the first grant of a tenant-ownership (upplatelse). */
  fromName: string | null;
  toName: string;
  price: string | null;
  /** The board's reference to the agreement, or the uploaded document's path. */
  agreementReference: string | null;
}

export interface ApartmentRegisterRow {
  apartmentId: string;
  /** Address and apartment number together, as the register designates it. */
  designation: string;
  number: string;
  addressLabel: string;
  initialShareCapital: string | null;
  participationShare: string | null;
  holders: ApartmentRegisterHolder[];
  liens: ApartmentRegisterLien[];
  transfers: ApartmentRegisterTransfer[];
}

export interface ApartmentRegisterExtract {
  housingCooperative: { name: string; organizationNumber: string | null };
  generatedOn: string;
  /** Whether this copy carries the holders' personal identity numbers. */
  identityNumbersIncluded: boolean;
  /** Whether the caller is reading the whole register or their own entry. */
  audience: "board" | "holder";
  rows: ApartmentRegisterRow[];
}

export interface ApartmentRegisterQuery {
  actorPersonId: string;
  audience: "board" | "holder";
  /** Null reads every apartment the audience is entitled to. */
  apartmentId: string | null;
  includeIdentityNumbers: boolean;
}

@Injectable()
export class ApartmentRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Produces the extract and logs it.
   *
   * The read and its audit entry share a transaction, so a copy of the register
   * cannot leave the building without the log saying so. When the copy carries
   * identity numbers, the entry names every person whose number it disclosed:
   * a count would not answer the only question worth asking afterwards.
   */
  async extract(
    query: ApartmentRegisterQuery,
    now: Date = new Date(),
  ): Promise<ApartmentRegisterExtract> {
    const apartmentIds = await this.scopeFor(query);

    return this.audit.withAuditedRead<ApartmentRegisterExtract>(
      {
        action: "APARTMENT_REGISTER_EXTRACT_GENERATED",
        actorPersonId: query.actorPersonId,
        context: {
          audience: query.audience,
          apartmentIds,
          identityNumbers: query.includeIdentityNumbers,
        },
      },
      async (tx) => {
        const extract = await this.build(tx, query, apartmentIds, now);

        if (query.includeIdentityNumbers) {
          const disclosed = extract.rows.flatMap((row) =>
            row.holders
              .filter(
                (holder) =>
                  holder.personalIdentityNumber.state === "visible" &&
                  holder.personalIdentityNumber.value !== null,
              )
              .map((holder) => holder.personId),
          );
          const protectedPersons = extract.rows.flatMap((row) =>
            row.holders
              .filter((holder) => holder.protectedPersonalData)
              .map((holder) => holder.personId),
          );

          await this.audit.record(
            {
              action: "PROTECTED_DATA_REVEALED",
              actorPersonId: query.actorPersonId,
              targetKind: "apartmentRegister",
              context: {
                fields: ["personalIdentityNumber"],
                via: "apartment-register-extract",
                personIds: [...new Set(disclosed)],
                protectedPersonIds: [...new Set(protectedPersons)],
              },
            },
            tx,
          );
        }

        return extract;
      },
    );
  }

  /** The board records a lien note (pantnotering) against an apartment. */
  async addLien(input: {
    apartmentId: string;
    creditor: string;
    notedOn: string;
    amount?: string | null;
  }): Promise<ApartmentRegisterLien> {
    const apartment = await this.prisma.apartment.findUnique({
      where: { id: input.apartmentId },
      select: { id: true },
    });
    if (apartment === null) {
      throw new ApartmentRegisterError(
        "No such apartment.",
        "apartment-not-found",
      );
    }

    const lien = await this.prisma.lienNote.create({
      data: {
        apartmentId: input.apartmentId,
        creditor: input.creditor,
        notedOn: new Date(input.notedOn),
        amount:
          input.amount === undefined || input.amount === null
            ? null
            : input.amount,
      },
    });

    return toLien(lien);
  }

  /**
   * Releases a lien note.
   *
   * Released rather than removed: the runtime role holds no DELETE on this
   * table, and a lien that was once recorded is part of the apartment's history
   * whether or not it still binds.
   */
  async releaseLien(input: {
    lienId: string;
    releasedOn: string;
  }): Promise<ApartmentRegisterLien> {
    const existing = await this.prisma.lienNote.findUnique({
      where: { id: input.lienId },
      select: { id: true },
    });
    if (existing === null) {
      throw new ApartmentRegisterError("No such lien note.", "lien-not-found");
    }

    const lien = await this.prisma.lienNote.update({
      where: { id: input.lienId },
      data: { releasedOn: new Date(input.releasedOn) },
    });

    return toLien(lien);
  }

  /**
   * Which apartments this request may read.
   *
   * A tenant-owner reads the apartments they currently hold and nothing else,
   * and asking for one they do not hold is answered as if it did not exist
   * rather than as a refusal: a 403 on a specific apartment id would confirm
   * that the apartment exists to someone with no right to know.
   */
  private async scopeFor(query: ApartmentRegisterQuery): Promise<string[]> {
    if (query.audience === "board") {
      if (query.apartmentId === null) {
        const apartments = await this.prisma.apartment.findMany({
          select: { id: true },
        });
        return apartments.map((apartment) => apartment.id);
      }
      const apartment = await this.prisma.apartment.findUnique({
        where: { id: query.apartmentId },
        select: { id: true },
      });
      if (apartment === null) {
        throw new ApartmentRegisterError(
          "No such apartment.",
          "apartment-not-found",
        );
      }
      return [apartment.id];
    }

    const now = new Date();
    const held = await this.prisma.residency.findMany({
      where: {
        personId: query.actorPersonId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
        ...(query.apartmentId === null
          ? {}
          : { apartmentId: query.apartmentId }),
      },
      select: { apartmentId: true },
    });

    if (query.apartmentId !== null && held.length === 0) {
      throw new ApartmentRegisterError(
        "No such apartment.",
        "apartment-not-found",
      );
    }
    return [...new Set(held.map((residency) => residency.apartmentId))];
  }

  private async build(
    tx: Prisma.TransactionClient,
    query: ApartmentRegisterQuery,
    apartmentIds: readonly string[],
    now: Date,
  ): Promise<ApartmentRegisterExtract> {
    const association = await tx.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });

    const apartments = await tx.apartment.findMany({
      where: { id: { in: [...apartmentIds] } },
      orderBy: [{ address: { sortOrder: "asc" } }, { number: "asc" }],
      select: {
        id: true,
        number: true,
        initialShareCapital: true,
        participationShare: true,
        address: { select: { street: true, number: true } },
        // Tenant-ownerships only. A non-member resident is address book
        // content; the apartment register records who holds the apartment.
        residencies: {
          where: { role: "MEMBER" },
          orderBy: [{ movedInOn: "desc" }],
          select: {
            movedInOn: true,
            movedOutOn: true,
            person: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                protectedPersonalData: true,
                personalIdentityNumberCipher: true,
              },
            },
          },
        },
        lienNotes: {
          orderBy: [{ notedOn: "desc" }],
          select: {
            id: true,
            creditor: true,
            notedOn: true,
            releasedOn: true,
            amount: true,
          },
        },
        transfers: {
          orderBy: [{ transferredOn: "desc" }],
          select: {
            id: true,
            transferredOn: true,
            price: true,
            agreementReference: true,
            agreementDocumentPath: true,
            fromPerson: { select: { firstName: true, lastName: true } },
            toPerson: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    const rows: ApartmentRegisterRow[] = [];
    for (const apartment of apartments) {
      const holders: ApartmentRegisterHolder[] = [];
      for (const residency of apartment.residencies) {
        holders.push({
          personId: residency.person.id,
          name: `${residency.person.firstName} ${residency.person.lastName}`.trim(),
          protectedPersonalData: residency.person.protectedPersonalData,
          personalIdentityNumber: await this.identityNumber(
            residency.person.personalIdentityNumberCipher,
            query.includeIdentityNumbers,
          ),
          heldFrom: isoDate(residency.movedInOn) ?? "",
          heldUntil: isoDate(residency.movedOutOn),
        });
      }

      rows.push({
        apartmentId: apartment.id,
        designation: `${apartment.address.street} ${apartment.address.number} ${apartment.number}`,
        number: apartment.number,
        addressLabel: `${apartment.address.street} ${apartment.address.number}`,
        initialShareCapital: apartment.initialShareCapital?.toString() ?? null,
        participationShare: apartment.participationShare?.toString() ?? null,
        holders,
        liens: apartment.lienNotes.map(toLien),
        transfers: apartment.transfers.map((transfer) => ({
          id: transfer.id,
          transferredOn: isoDate(transfer.transferredOn) ?? "",
          fromName:
            transfer.fromPerson === null
              ? null
              : `${transfer.fromPerson.firstName} ${transfer.fromPerson.lastName}`.trim(),
          toName:
            `${transfer.toPerson.firstName} ${transfer.toPerson.lastName}`.trim(),
          price: transfer.price?.toString() ?? null,
          agreementReference:
            transfer.agreementReference ?? transfer.agreementDocumentPath,
        })),
      });
    }

    return {
      housingCooperative: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
      },
      generatedOn: isoDate(now) ?? "",
      identityNumbersIncluded: query.includeIdentityNumbers,
      audience: query.audience,
      rows,
    };
  }

  /**
   * The holder's personal identity number.
   *
   * Masked unless this copy of the extract is the full statutory document. The
   * ciphertext is not decrypted in the masked case, so the number never exists
   * in the process and cannot reach a log, a trace or a serialiser by mistake.
   */
  private async identityNumber(
    cipher: string | null,
    include: boolean,
  ): Promise<RegisterIdentityNumber> {
    if (!include) {
      return { state: "masked", hasValue: cipher !== null };
    }
    return {
      state: "visible",
      value:
        cipher === null
          ? null
          : await this.encryption.decrypt(
              "person.personalIdentityNumber",
              cipher,
            ),
    };
  }
}

function toLien(lien: {
  id: string;
  creditor: string;
  notedOn: Date;
  releasedOn: Date | null;
  amount: { toString: () => string } | null;
}): ApartmentRegisterLien {
  return {
    id: lien.id,
    creditor: lien.creditor,
    notedOn: isoDate(lien.notedOn) ?? "",
    releasedOn: isoDate(lien.releasedOn),
    amount: lien.amount?.toString() ?? null,
  };
}

function isoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
