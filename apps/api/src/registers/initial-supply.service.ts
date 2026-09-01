import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { formatLocalDay, localDayOf } from "../bookings/stockholm-calendar";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import {
  SUPPLY_COLUMNS,
  type SupplyRecordType,
  type SupplyRow,
  supplyFileName,
  writeSupplyFile,
} from "./initial-supply-file";

/**
 * The initial supply to the cooperative housing register.
 *
 * Lag (2026:485) 3 § makes an association supply, by 31 December 2027, the data
 * the register is to hold about the bostadsrattslagenhet, the
 * bostadsrattsforening, the bostadsrattshavare, pantsattningar and anteckningar.
 * 7 § lets Lantmateriet order a defaulting association to do it under penalty of
 * a fine, and 6 § drops the duty for data obtainable from fastighetsregistret or
 * lagenhetsregistret instead.
 *
 * This service assembles that data. What it produces is a documented file and a
 * document to check it against, not a transmission: Lantmateriet's technical
 * interface is not published, and `initial-supply-file.ts` carries the reasoning
 * about the shape.
 *
 * ## The second operation in the product that decrypts a personal identity
 * number
 *
 * The data subject access report is the first. This one is gated and audited on
 * that report's reading rather than on a weaker one, because it is the more
 * disclosing of the two in one respect: the report decrypts one person's number
 * onto one document, and this decrypts every current holder's in the
 * association onto one file.
 *
 * Three properties follow and none is negotiable.
 *
 *   It sits behind `registerReport:export` as well as `apartmentRegister:read`
 *   and `protectedData:reveal`. The first says the caller may supply the
 *   register onward; the third says they may see a number the product otherwise
 *   masks. Without the third this route would be a second, weaker path to a
 *   disclosure the register's own reveal route refuses.
 *
 *   Its entries and the read commit together, so a copy cannot leave the
 *   building without the log saying so, and the entry names every person whose
 *   number the file carried, every column it has and how many rows of each kind.
 *   A count alone would not answer the question a supervisory authority asks. A
 *   PROTECTED_DATA_REVEALED entry goes in beside it, so "who has seen these
 *   identity numbers" stays answerable from one action across the whole product
 *   rather than from a list of the operations that disclose one.
 *
 *   The plaintext number exists in one local for the length of the assembly and
 *   reaches no log line. The log carries the actor and the counts, which is the
 *   convention `logging/failure.ts` sets out.
 *
 * ## A protected holder's address is not supplied
 *
 * A person with skyddade personuppgifter has an address the association may not
 * pass on, and a supply duty is not an exception to that: the file carries the
 * name and the personal identity number, which are what identifies the holder
 * in a register keyed on exactly those, and leaves the three postal columns
 * empty with a column beside them saying why. The receiving authority is not
 * left without an address - it holds one through Skatteverket, which is where
 * the protection is administered and where a change of it is recorded.
 *
 * The alternative address the register keeps for such a person is deliberately
 * not put in its place. It exists so the association can reach them; supplying
 * it as the postadress a state register is to hold would be a statement nobody
 * made.
 */

/**
 * The supply was asked for before the association was set up.
 *
 * A conflict rather than a bad request, on the reading the apartment register's
 * property designation takes of the same absence: nothing about the request is
 * wrong, the instance is not in a state where a supply exists to produce.
 */
export class InitialSupplyError extends DomainError {
  readonly status = 409;
  readonly reason = "association-not-set-up";
}

export interface InitialSupply {
  /** The association's calendar day the file was produced on. */
  generatedOn: string;
  /** The name it is offered under. */
  fileName: string;
  /** The column contract, in file order. */
  columns: readonly string[];
  /** Every row, as the columns it fills. */
  rows: SupplyRow[];
  counts: Record<SupplyRecordType, number>;
  /**
   * The file itself.
   *
   * Beside the rows rather than instead of them, and the rows are the same data
   * rather than a summary of it. The document a board member checks and signs is
   * the file's own content - a prettier rendering would be a second thing to get
   * right, and the one they sign off on would not be the one that goes.
   *
   * Produced here rather than by the browser so the column contract has exactly
   * one implementation. A client that serialised its own would be a second
   * writer of a format whose whole value is that it is stable.
   */
  csv: string;
}

@Injectable()
export class InitialSupplyService {
  private readonly logger = new Logger(InitialSupplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  async produce(input: {
    actorPersonId: string;
    now?: Date;
  }): Promise<InitialSupply> {
    const now = input.now ?? new Date();
    // The association's own calendar day, not the UTC one: the file is named for
    // the day it was produced, and an instant sliced in UTC names the previous
    // day for the two hours after midnight in summer.
    const generatedOn = formatLocalDay(localDayOf(now));

    /*
     * The read and both of its entries in one transaction, so a copy of the
     * register cannot leave the building without the log saying so - which is
     * the property AuditLogService.withAuditedRead exists for. Written out here
     * rather than through that helper because the helper fixes its entry before
     * the read runs, and the entry this disclosure needs has to name what the
     * file turned out to contain: which people's numbers went into it, and how
     * many rows of each kind. An entry stating the intention rather than the
     * result would answer none of that.
     */
    const supply = await this.prisma.$transaction(async (tx) => {
      const built = await this.build(tx, generatedOn, now);

      await this.audit.record(
        {
          action: "REGISTER_INITIAL_SUPPLY_EXPORTED",
          actorPersonId: input.actorPersonId,
          targetKind: "registerInitialSupply",
          context: {
            // Who the disclosure is for, which is what makes it accountable:
            // this is the one operation in the product whose recipient is
            // outside the association.
            recipient: "bostadsrattsregistret",
            basis: "SFS 2026:485 3 §",
            // Field names and counts, never a value. Naming the columns is what
            // makes the entry say how much was disclosed rather than merely
            // that something was, which is the reading the data subject access
            // report takes of its own section list.
            columns: [...SUPPLY_COLUMNS],
            records: built.supply.counts,
            // Every person whose number the file carried, so the entry answers
            // "whose" and not only "how many".
            personIds: built.disclosed,
            protectedPersonIds: built.protectedPersons,
            apartmentIds: built.apartmentIds,
          },
        },
        tx,
      );

      await this.audit.record(
        {
          action: "PROTECTED_DATA_REVEALED",
          actorPersonId: input.actorPersonId,
          targetKind: "registerInitialSupply",
          context: {
            fields: ["personalIdentityNumber"],
            via: "register-initial-supply",
            personIds: built.disclosed,
            protectedPersonIds: built.protectedPersons,
            // The supply is made under a statutory duty rather than on a reason
            // a board member types, so the entry states the duty where the
            // register's own reveal route states a reason. An absent reason
            // there is a fact about the disclosure; here there is nothing for
            // one to be absent from.
            reason: null,
          },
        },
        tx,
      );

      return built.supply;
    });

    // The act and the size of it, and nothing the file was carrying.
    this.logger.log(
      `Initial supply to the cooperative housing register produced by ${input.actorPersonId}: ` +
        `${String(supply.counts.APARTMENT)} apartments, ` +
        `${String(supply.counts.HOLDER)} holders, ` +
        `${String(supply.counts.LIEN)} lien notes`,
    );
    return supply;
  }

  /**
   * Assembles the file, and reports what went into it.
   *
   * The two identifier lists come back beside the supply rather than being
   * written from in here, so the entries above state one set of facts about one
   * assembly: a build that computed them and an entry that named a different
   * set would be two answers to the same question.
   */
  private async build(
    tx: Prisma.TransactionClient,
    generatedOn: string,
    now: Date,
  ): Promise<{
    supply: InitialSupply;
    /** Every person whose personal identity number the file carries. */
    disclosed: string[];
    protectedPersons: string[];
    apartmentIds: string[];
  }> {
    const association = await tx.association.findUnique({
      where: { id: 1 },
      select: {
        name: true,
        organizationNumber: true,
        propertyDesignation: true,
      },
    });
    if (association === null) {
      /*
       * Refused rather than supplied with an empty ASSOCIATION row. Lag
       * (2026:485) 3 § is a duty on a named bostadsrattsforening, and Forordning
       * (2026:898) 2 kap. 4 § 1 and 2 make its name and organisationsnummer the
       * first two things the register holds - so a file that identifies nobody
       * is not a smaller supply but one that cannot discharge the duty at all.
       * Before the rows and before the audit entries, because the entry would
       * otherwise record a disclosure that produced an unusable file and the
       * association would have a completed export to point at.
       */
      throw new InitialSupplyError("The association has not been set up yet.");
    }

    const apartments = await tx.apartment.findMany({
      orderBy: [{ address: { sortOrder: "asc" } }, { number: "asc" }],
      select: {
        id: true,
        number: true,
        address: {
          select: {
            street: true,
            number: true,
            postalCode: true,
            city: true,
          },
        },
        // Current tenant-ownerships only. A supply states who holds the
        // bostadsratt now; Forordning (2026:898) 2 kap. 11 § makes the record of
        // earlier holders the register's own, built from the reports it
        // receives, and this file is the first of those rather than a history.
        residencies: {
          where: {
            role: "MEMBER",
            // A move-out dated in the future has not happened: that person still
            // holds the bostadsratt today and belongs in the supply. The same
            // predicate the apartment register decides a holder's own scope by,
            // and a plain `movedOutOn: null` would leave a current holder out of
            // a statutory supply on the strength of a date nobody has reached.
            OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }],
          },
          orderBy: [{ movedInOn: "asc" }],
          select: {
            movedInOn: true,
            person: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                postalStreet: true,
                postalCode: true,
                postalCity: true,
                protectedPersonalData: true,
                personalIdentityNumberCipher: true,
              },
            },
          },
        },
        // A lien that has been released no longer applies, and Lag (2026:485)
        // 11 § registers a noterad pant for a panträtt that had sakrattsligt
        // skydd before the act came into force. A released note has none.
        lienNotes: {
          where: { releasedOn: null },
          orderBy: [{ notedOn: "asc" }],
          select: { creditor: true, notedOn: true },
        },
        // The membership decision belongs to the holder rather than to the
        // apartment (Forordning (2026:898) 2 kap. 5 § forsta stycket 7), so the
        // transfers are read here and matched to the holder below.
        transfers: {
          where: { membershipDecidedOn: { not: null } },
          orderBy: [{ membershipDecidedOn: "asc" }],
          select: { toPersonId: true, membershipDecidedOn: true },
        },
      },
    });

    const rows: SupplyRow[] = [
      {
        recordType: "ASSOCIATION",
        associationName: association.name,
        associationOrganizationNumber: association.organizationNumber ?? "",
        associationPropertyDesignation: association.propertyDesignation ?? "",
      },
    ];

    const disclosed: string[] = [];
    const protectedPersons: string[] = [];

    for (const apartment of apartments) {
      const apartmentKey = `${apartment.address.street} ${apartment.address.number} ${apartment.number}`;

      rows.push({
        recordType: "APARTMENT",
        apartmentKey,
        apartmentNumber: apartment.number,
        apartmentAddressStreet: apartment.address.street,
        apartmentAddressNumber: apartment.address.number,
        apartmentPostalCode: apartment.address.postalCode,
        apartmentPostalCity: apartment.address.city,
      });

      for (const residency of apartment.residencies) {
        const person = residency.person;
        // The latest decision recorded for this person on this apartment. An
        // acquirer who bought, sold and bought back has two, and the one that
        // admitted them to the membership they hold now is the later.
        const decided = apartment.transfers
          .filter((transfer) => transfer.toPersonId === person.id)
          .map((transfer) => isoDate(transfer.membershipDecidedOn))
          .filter((day): day is string => day !== null)
          .at(-1);

        const identityNumber =
          person.personalIdentityNumberCipher === null
            ? null
            : await this.encryption.decrypt(
                "person.personalIdentityNumber",
                person.personalIdentityNumberCipher,
              );
        if (identityNumber !== null) {
          disclosed.push(person.id);
        }
        if (person.protectedPersonalData) {
          protectedPersons.push(person.id);
        }

        rows.push({
          recordType: "HOLDER",
          apartmentKey,
          holderName: `${person.firstName} ${person.lastName}`.trim(),
          holderPersonalIdentityNumber: identityNumber ?? "",
          // Empty for a protected holder, and the column beside it says so. See
          // the note on this service.
          holderPostalStreet: person.protectedPersonalData
            ? ""
            : (person.postalStreet ?? ""),
          holderPostalCode: person.protectedPersonalData
            ? ""
            : (person.postalCode ?? ""),
          holderPostalCity: person.protectedPersonalData
            ? ""
            : (person.postalCity ?? ""),
          holderProtectedPersonalData: person.protectedPersonalData
            ? "yes"
            : "no",
          holderHeldFrom: isoDate(residency.movedInOn) ?? "",
          holderMembershipDecidedOn: decided ?? "",
        });
      }

      for (const lien of apartment.lienNotes) {
        rows.push({
          recordType: "LIEN",
          apartmentKey,
          lienCreditor: lien.creditor,
          lienNotedOn: isoDate(lien.notedOn) ?? "",
        });
      }
    }

    const counts = {
      ASSOCIATION: rows.filter((row) => row.recordType === "ASSOCIATION")
        .length,
      APARTMENT: rows.filter((row) => row.recordType === "APARTMENT").length,
      HOLDER: rows.filter((row) => row.recordType === "HOLDER").length,
      LIEN: rows.filter((row) => row.recordType === "LIEN").length,
    } satisfies Record<SupplyRecordType, number>;

    return {
      supply: {
        generatedOn,
        fileName: supplyFileName(generatedOn),
        columns: SUPPLY_COLUMNS,
        rows,
        counts,
        csv: writeSupplyFile(rows),
      },
      disclosed: [...new Set(disclosed)],
      protectedPersons: [...new Set(protectedPersons)],
      apartmentIds: apartments.map((apartment) => apartment.id),
    };
  }
}

function isoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
