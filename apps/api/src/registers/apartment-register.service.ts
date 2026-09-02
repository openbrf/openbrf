import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma, TerminationKind } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { failureName } from "../logging/failure";
import { RegisterReportMailerService } from "./register-report-mailer.service";
import { reportDueOn } from "./report-deadline";
import { statutoryDate } from "./statutory-date";

/**
 * The statutory apartment register (lagenhetsforteckning), BRL 9 kap.
 *
 * A different document from the member register, with a different field list
 * and a different access rule, and the two must never be blended:
 *
 *   apartment designation, holder including personal identity number,
 *   initial share capital, participation share, liens with their note dates,
 *   transfers with their agreement references and membership decision dates,
 *   terminations with the ground and the day they took effect
 *
 * The member register is public on request. This one is confidential: the board
 * may read it, and a tenant-owner may read their own entry and nobody else's.
 * That is why this service, its controller and its screen are separate from the
 * member register's rather than one view with a flag - a flag is a thing that
 * can be wrong, and the wrong value here publishes personal identity numbers.
 *
 * The personal identity number is masked by default even here, and disclosed
 * only when the caller asks for the full statutory document. The board's copy
 * carries every holder's; a tenant-owner's own copy carries theirs alone, since
 * an apartment lists its co-holders and its previous holders too and none of
 * those numbers is theirs to read. The disclosure is written to the audit log
 * naming every person it covered, because "who has seen these identity numbers"
 * is the question the log exists to answer.
 *
 * This service also writes the obligation ledger, which is not part of this
 * register: it is the association's record of the deadlines the cooperative
 * housing register imposes. It is written here because a deadline and the
 * register event it runs from have to be one transaction, and this is where
 * those events are recorded. RegisterReportObligation in schema.prisma carries
 * the model's own account of itself.
 */

export type ApartmentRegisterErrorReason =
  | "apartment-not-found"
  | "lien-not-found"
  | "lien-already-released"
  | "transfer-not-found"
  | "membership-decision-already-recorded"
  | "date-not-a-calendar-date"
  | "date-in-the-future"
  | "association-not-set-up";

/**
 * Which reasons are a conflict rather than an absence, and which a bad request.
 *
 * Stated as a map rather than as a chain of ternaries: a reason added without a
 * status here is a compile error, where a fall-through default would silently
 * answer 404 to a refusal that is nothing of the kind.
 */
const ERROR_STATUS = {
  "apartment-not-found": 404,
  "lien-not-found": 404,
  "lien-already-released": 409,
  "transfer-not-found": 404,
  "membership-decision-already-recorded": 409,
  "date-not-a-calendar-date": 400,
  "date-in-the-future": 400,
  "association-not-set-up": 409,
} as const satisfies Record<ApartmentRegisterErrorReason, number>;

export class ApartmentRegisterError extends DomainError {
  override readonly status: number;
  override readonly reason: ApartmentRegisterErrorReason;

  constructor(message: string, reason: ApartmentRegisterErrorReason) {
    super(message);
    this.reason = reason;
    this.status = ERROR_STATUS[reason];
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
  /**
   * The day the association decided on the acquirer's membership, which is the
   * day the cooperative housing register's two-week reporting window opens
   * (Lag (2026:484) 3 kap. 3 § andra stycket).
   *
   * Null where there was no such decision to date - a transfer to a sitting
   * member, or to an acquirer outside the membership requirement, which the
   * same paragraph runs from the transfer instead - and null on a transfer
   * recorded before the column existed. The extract does not distinguish the
   * two: nothing in the register can, which is why the date is recorded when
   * the decision is taken rather than derived afterwards.
   */
  membershipDecidedOn: string | null;
  /** Null for the first grant of a tenant-ownership (upplatelse). */
  fromName: string | null;
  toName: string;
  price: string | null;
  /**
   * The board's reference to the agreement, or the uploaded document's path.
   * Required of every transfer recorded from now on, and null only for a row
   * written before the constraint that says so
   * (20260828170000_transfer_agreement_reference_required). The extract names
   * such a row as having no reference rather than printing an empty space.
   */
  agreementReference: string | null;
}

/**
 * A tenant-ownership that has ceased to exist (upphorande).
 *
 * On the extract because the register has to say that an apartment no longer
 * carries a tenant-ownership: an entry listing holders and transfers, with
 * nothing saying the right itself ended, reads as though it were still held.
 */
export interface ApartmentRegisterTermination {
  id: string;
  kind: TerminationKind;
  /** The day it ceased, and the day the statutory two weeks start running. */
  tookEffectOn: string;
  reference: string;
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
  terminations: ApartmentRegisterTermination[];
}

export interface ApartmentRegisterExtract {
  housingCooperative: {
    name: string;
    organizationNumber: string | null;
    /**
     * The property's designation with Lantmateriet, from the association's own
     * authoritative record of it and never from the published broker prose.
     *
     * On this extract and not on the member register's: the designation names
     * the property the apartments are in, which is apartment register content.
     */
    propertyDesignation: string | null;
  };
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
  /**
   * Why the identity numbers were asked for, as the caller stated it. Written
   * into the audit entry: "who saw these numbers" is only half the question a
   * data protection officer asks afterwards.
   */
  reason?: string | null;
}

@Injectable()
export class ApartmentRegisterService {
  private readonly logger = new Logger(ApartmentRegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly notices: RegisterReportMailerService,
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

          const reason = (query.reason ?? "").trim();
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
                // Stated or not, the entry says which: an absent reason is a
                // fact about the disclosure rather than a missing field.
                reason: reason === "" ? null : reason,
              },
            },
            tx,
          );
        }

        return extract;
      },
    );
  }

  /**
   * The board records a lien note (pantnotering) against an apartment.
   *
   * The write and its audit entry share a transaction, exactly as every read of
   * this register does. The log covers changes as well as accesses, and a lien
   * noted against an apartment with nothing saying who noted it would leave the
   * board unable to answer for a statutory date of record.
   */
  async addLien(input: {
    actorPersonId: string;
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

    return this.prisma.$transaction(async (tx) => {
      const lien = await tx.lienNote.create({
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

      await this.audit.record(
        {
          action: "APARTMENT_REGISTER_LIEN_NOTED",
          actorPersonId: input.actorPersonId,
          targetKind: "lienNote",
          targetId: lien.id,
          context: {
            apartmentId: input.apartmentId,
            creditor: input.creditor,
            notedOn: isoDate(lien.notedOn),
          },
        },
        tx,
      );

      return toLien(lien);
    });
  }

  /**
   * Releases a lien note.
   *
   * Released rather than removed: the runtime role holds no DELETE on this
   * table, and a lien that was once recorded is part of the apartment's history
   * whether or not it still binds.
   *
   * A note that already carries a release date is refused rather than rewritten.
   * The release date is the statutory date of record on a row the database will
   * not let anyone delete, so overwriting it would lose the recorded date with
   * nothing left saying what it had been.
   */
  async releaseLien(input: {
    actorPersonId: string;
    lienId: string;
    releasedOn: string;
  }): Promise<ApartmentRegisterLien> {
    const existing = await this.prisma.lienNote.findUnique({
      where: { id: input.lienId },
      select: { id: true, apartmentId: true, releasedOn: true },
    });
    if (existing === null) {
      throw new ApartmentRegisterError("No such lien note.", "lien-not-found");
    }
    if (existing.releasedOn !== null) {
      throw new ApartmentRegisterError(
        "That lien note was already released.",
        "lien-already-released",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional on the note still being unreleased, so two releases
      // arriving together cannot both write: the loser sees no row and is
      // answered with the same refusal as a sequential second attempt.
      const claimed = await tx.lienNote.updateMany({
        where: { id: input.lienId, releasedOn: null },
        data: { releasedOn: new Date(input.releasedOn) },
      });
      if (claimed.count === 0) {
        throw new ApartmentRegisterError(
          "That lien note was already released.",
          "lien-already-released",
        );
      }

      const lien = await tx.lienNote.findUniqueOrThrow({
        where: { id: input.lienId },
      });

      await this.audit.record(
        {
          action: "APARTMENT_REGISTER_LIEN_RELEASED",
          actorPersonId: input.actorPersonId,
          targetKind: "lienNote",
          targetId: lien.id,
          context: {
            apartmentId: existing.apartmentId,
            releasedOn: isoDate(lien.releasedOn),
          },
        },
        tx,
      );

      return toLien(lien);
    });
  }

  /**
   * The board records that a tenant-ownership has ceased (upphorande).
   *
   * The event Lag (2026:484) 3 kap. 4 § makes the association report to the
   * cooperative housing register within two weeks of the day it ceased, and
   * 3 kap. 10 § lets Lantmateriet order a late report in under penalty of a
   * fine. The report itself is a later train; the deadline is not, and it is
   * entered in the obligation ledger by this same transaction.
   *
   * The window runs from `tookEffectOn` and never from the day the board typed
   * it in. 3 kap. 4 § says "inom tva veckor fran det att bostadsratten
   * upphorde", and nothing in that section defers the count to the day the
   * association noticed: a termination recorded a month after the general
   * meeting resolved it arrives with its window already closed, which is the
   * true state and the one 3 kap. 10 § attaches a fine to. `createdAt` says
   * when the row was written and is not a statutory date.
   *
   * The row, its obligation and its audit entries share a transaction, as every
   * write to this register does. Nothing here checks the conditions the ground
   * carries - BRL
   * 6 kap. 11 § permits the general meeting's decision on a pledged
   * tenant-ownership only with the lienholder's consent - because those are
   * conditions on the decision the association took, not on recording that it
   * took it, and a register that refused to record a decision already made
   * would leave the association unable to report it.
   */
  async recordTermination(input: {
    actorPersonId: string;
    apartmentId: string;
    kind: TerminationKind;
    tookEffectOn: string;
    reference: string;
    now?: Date;
  }): Promise<ApartmentRegisterTermination> {
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

    const tookEffectOn = statutoryDateColumn(
      input.tookEffectOn,
      input.now ?? new Date(),
    );

    const recorded = await this.prisma.$transaction(async (tx) => {
      const termination = await tx.termination.create({
        data: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          tookEffectOn,
          reference: input.reference.trim(),
        },
      });

      await this.audit.record(
        {
          action: "APARTMENT_REGISTER_TERMINATION_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "termination",
          targetId: termination.id,
          context: {
            apartmentId: input.apartmentId,
            kind: termination.kind,
            tookEffectOn: isoDate(termination.tookEffectOn),
          },
        },
        tx,
      );

      const obligation = await this.enterObligation(tx, {
        actorPersonId: input.actorPersonId,
        kind: "TERMINATION",
        apartmentId: input.apartmentId,
        terminationId: termination.id,
        triggeredOn: termination.tookEffectOn,
      });

      return { view: toTermination(termination), obligation };
    });

    await this.enqueueBoardNotice(recorded.obligation.id);
    return recorded.view;
  }

  /**
   * Records the day the association decided on an acquirer's membership.
   *
   * Its own act rather than a field on the move, because it is a different
   * decision taken on a different day: the board approves membership when it
   * meets, and the transfer completes on the tilltradesdag. Lag (2026:484)
   * 3 kap. 3 § andra stycket runs the transfer report's two weeks from the
   * former.
   *
   * Refused rather than rewritten once recorded. Transfer keeps UPDATE, so the
   * database would accept a second value, and this date is the start of a
   * statutory window: overwriting it would move a deadline with nothing left
   * saying where it had been. Claimed conditionally, so two boards recording it
   * at once cannot both write and the loser is answered as a sequential second
   * attempt would be.
   *
   * This is also where the transfer's entry in the obligation ledger is written,
   * in the same transaction as the date it runs from - and not at the transfer's
   * own insert, where there is no decision date and 3 kap. 3 § andra stycket
   * gives no other day to count from. So a transfer whose decision has not been
   * recorded has no deadline in the ledger, which is what is true of it: the
   * board has not told the register when its window opened.
   */
  async recordMembershipDecision(input: {
    actorPersonId: string;
    transferId: string;
    membershipDecidedOn: string;
    now?: Date;
  }): Promise<ApartmentRegisterTransfer> {
    const existing = await this.prisma.transfer.findUnique({
      where: { id: input.transferId },
      select: { id: true, apartmentId: true, membershipDecidedOn: true },
    });
    if (existing === null) {
      throw new ApartmentRegisterError(
        "No such transfer.",
        "transfer-not-found",
      );
    }
    if (existing.membershipDecidedOn !== null) {
      throw new ApartmentRegisterError(
        "That transfer already carries a membership decision date.",
        "membership-decision-already-recorded",
      );
    }

    const decidedOn = statutoryDateColumn(
      input.membershipDecidedOn,
      input.now ?? new Date(),
    );

    const recorded = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.transfer.updateMany({
        where: { id: input.transferId, membershipDecidedOn: null },
        data: { membershipDecidedOn: decidedOn },
      });
      if (claimed.count === 0) {
        throw new ApartmentRegisterError(
          "That transfer already carries a membership decision date.",
          "membership-decision-already-recorded",
        );
      }

      const transfer = await tx.transfer.findUniqueOrThrow({
        where: { id: input.transferId },
        select: {
          id: true,
          transferredOn: true,
          membershipDecidedOn: true,
          price: true,
          agreementReference: true,
          agreementDocumentPath: true,
          fromPerson: { select: { firstName: true, lastName: true } },
          toPerson: { select: { firstName: true, lastName: true } },
        },
      });

      await this.audit.record(
        {
          action: "APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "transfer",
          targetId: transfer.id,
          context: {
            apartmentId: existing.apartmentId,
            membershipDecidedOn: isoDate(transfer.membershipDecidedOn),
            transferredOn: isoDate(transfer.transferredOn),
          },
        },
        tx,
      );

      const obligation = await this.enterObligation(tx, {
        actorPersonId: input.actorPersonId,
        kind: "TRANSFER",
        apartmentId: existing.apartmentId,
        transferId: transfer.id,
        // The decision date this transaction has just claimed, and never
        // transfer.transferredOn beside it. 3 kap. 3 § andra stycket runs the
        // two weeks from the decision, and the transfer completes on the
        // tilltradesdag - usually the later day - so counting from it would
        // state a deadline after the statutory one.
        triggeredOn: decidedOn,
      });

      return { view: toTransfer(transfer), obligation };
    });

    await this.enqueueBoardNotice(recorded.obligation.id);
    return recorded.view;
  }

  /**
   * Puts the board's notice on the queue, after the commit and best effort.
   *
   * After, because by now the register event and its deadline have both been
   * written and neither can be taken back: the obligation ledger refuses UPDATE
   * and DELETE, a termination is as strictly append-only, and a transfer that
   * carries a membership decision date refuses a second one. Letting a queue
   * outage reject the request would report a written register as a failure and
   * invite a retry that writes a second statutory row, since a termination
   * carries no uniqueness constraint - and the deadline would still be running,
   * now with nobody told and the board believing nothing was recorded.
   *
   * Best effort for the same reason it is after: the part that cannot be
   * reconstructed is the deadline, and that is written by the same transaction
   * as the event it is computed from. A notice that never went out is
   * recoverable from the queue screen, which lists every duty whether or not
   * anybody was written to. So this is the one half worth losing, and the
   * move-out reminder's opposite ordering - enqueued by the transaction itself -
   * is right there for the opposite reason.
   *
   * A queue and not a send, because a board has as many seats as it has and
   * every one of them is a separate SMTP conversation. The reasoning is in
   * `register-report-mailer.service.ts`, which is where the sending lives.
   *
   * The failure is named by the obligation and by the class of what went wrong,
   * never by its payload.
   */
  private async enqueueBoardNotice(obligationId: string): Promise<void> {
    try {
      await this.notices.enqueueNotice(obligationId);
    } catch (error) {
      this.logger.error(
        `Reporting obligation notice could not be queued for obligation ${obligationId}: ` +
          failureName(error),
      );
    }
  }

  /**
   * Enters one duty in the obligation ledger, inside the caller's transaction.
   *
   * Private and takes the transaction client rather than the service's own, so
   * there is no way to reach it that is not already writing the register event
   * the deadline is computed from. That coupling is the guarantee the ledger
   * rests on: an obligation cannot be lost to a crash between the two writes,
   * and a scan that built the ledger afterwards could be missing a deadline
   * nobody would notice was absent.
   *
   * The deadline itself comes from `report-deadline.ts`, and the database states
   * the same rule as a CHECK, so a wrong window is refused rather than recorded.
   *
   * The kind and the event it names travel together as one argument rather than
   * as a kind beside two optional identifiers, so naming a termination on a
   * transfer's clock is a compile error. The database refuses that combination
   * too (`register_report_obligation_event_matches_kind`), and this is the half
   * that says so before anything runs.
   */
  private async enterObligation(
    tx: Prisma.TransactionClient,
    input: {
      actorPersonId: string;
      apartmentId: string;
      /** The day the statutory window opened, as a date column value. */
      triggeredOn: Date;
    } & (
      | { kind: "TRANSFER"; transferId: string }
      | { kind: "TERMINATION"; terminationId: string }
    ),
  ): Promise<{
    id: string;
    kind: "TRANSFER" | "TERMINATION";
    triggeredOn: Date;
    dueOn: Date;
  }> {
    const obligation = await tx.registerReportObligation.create({
      data: {
        kind: input.kind,
        apartmentId: input.apartmentId,
        transferId: input.kind === "TRANSFER" ? input.transferId : null,
        terminationId:
          input.kind === "TERMINATION" ? input.terminationId : null,
        triggeredOn: input.triggeredOn,
        dueOn: reportDueOn(input.triggeredOn),
      },
    });

    await this.audit.record(
      {
        action: "REGISTER_REPORT_OBLIGATION_RECORDED",
        actorPersonId: input.actorPersonId,
        targetKind: "registerReportObligation",
        targetId: obligation.id,
        context: {
          kind: obligation.kind,
          apartmentId: obligation.apartmentId,
          transferId: obligation.transferId,
          terminationId: obligation.terminationId,
          triggeredOn: isoDate(obligation.triggeredOn),
          dueOn: isoDate(obligation.dueOn),
        },
      },
      tx,
    );

    // The row as written, for the notice the caller sends once this transaction
    // has committed. Returned rather than recomposed out there: the dates the
    // message states are the ones the database accepted, and the CHECK on the
    // table is what makes that a meaningful difference.
    return {
      id: obligation.id,
      kind: input.kind,
      triggeredOn: obligation.triggeredOn,
      dueOn: obligation.dueOn,
    };
  }

  /**
   * Records the association's authoritative property designation.
   *
   * Register content rather than a setting, which is why it is written here and
   * not in the settings module: the designation identifies the property the
   * register's apartments are in, the cooperative housing register holds data
   * about the bostadsrattslagenhet (Lag (2026:484) 2 kap. 1 § forsta stycket 1)
   * which the association has to supply (Lag (2026:485) 3 §), and 6 § of that
   * act drops the duty where the data can instead be taken from
   * fastighetsregistret or lagenhetsregistret - registers keyed on this
   * designation.
   *
   * association_facts carries a designation of its own and keeps it. That one is
   * prose the board publishes to a broker, and that model forbids statutory data
   * being derived from it; this one is the register's. Correctable in place - a
   * fastighetsbildning renames a property - and the audit entry carries what it
   * was changed from as well as to, because "the designation was wrong for a
   * year" is a question the log has to be able to answer.
   */
  async recordPropertyDesignation(input: {
    actorPersonId: string;
    propertyDesignation: string | null;
  }): Promise<{ propertyDesignation: string | null }> {
    const trimmed = input.propertyDesignation?.trim() ?? "";
    const designation = trimmed === "" ? null : trimmed;

    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { propertyDesignation: true },
    });
    if (association === null) {
      throw new ApartmentRegisterError(
        "The association has not been set up yet.",
        "association-not-set-up",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.association.update({
        where: { id: 1 },
        data: { propertyDesignation: designation },
        select: { propertyDesignation: true },
      });

      await this.audit.record(
        {
          action: "ASSOCIATION_PROPERTY_DESIGNATION_RECORDED",
          actorPersonId: input.actorPersonId,
          targetKind: "association",
          targetId: "1",
          context: {
            // The designation names a property and not a person, and the
            // register extract prints it, so both values belong in the entry:
            // what it was and what it became is the whole content of the act.
            from: association.propertyDesignation,
            to: updated.propertyDesignation,
          },
        },
        tx,
      );

      return updated;
    });
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
      select: {
        name: true,
        organizationNumber: true,
        propertyDesignation: true,
      },
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
            membershipDecidedOn: true,
            price: true,
            agreementReference: true,
            agreementDocumentPath: true,
            fromPerson: { select: { firstName: true, lastName: true } },
            toPerson: { select: { firstName: true, lastName: true } },
          },
        },
        terminations: {
          orderBy: [{ tookEffectOn: "desc" }],
          select: {
            id: true,
            kind: true,
            tookEffectOn: true,
            reference: true,
          },
        },
      },
    });

    const rows: ApartmentRegisterRow[] = [];
    for (const apartment of apartments) {
      const holders: ApartmentRegisterHolder[] = [];
      for (const residency of apartment.residencies) {
        // A tenant-owner's own extract discloses their own number and nobody
        // else's. The apartment lists every holder it has ever had, so a
        // co-holder's and a previous holder's numbers are on this row too, and
        // the masking matrix answers "another resident, signed in" with never.
        // The board's full statutory copy, which carries all of them, is a
        // separate request behind protectedData:reveal.
        const mayReadIdentityNumber =
          query.includeIdentityNumbers &&
          (query.audience === "board" ||
            residency.person.id === query.actorPersonId);

        holders.push({
          personId: residency.person.id,
          name: `${residency.person.firstName} ${residency.person.lastName}`.trim(),
          protectedPersonalData: residency.person.protectedPersonalData,
          personalIdentityNumber: await this.identityNumber(
            residency.person.personalIdentityNumberCipher,
            mayReadIdentityNumber,
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
        transfers: apartment.transfers.map(toTransfer),
        terminations: apartment.terminations.map(toTermination),
      });
    }

    return {
      housingCooperative: {
        name: association?.name ?? "",
        organizationNumber: association?.organizationNumber ?? null,
        propertyDesignation: association?.propertyDesignation ?? null,
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

/**
 * One transfer as the extract states it.
 *
 * A function rather than an inline map because two callers now build it: the
 * extract, and recording a membership decision, which answers with the row it
 * changed. Two spellings of one payload is how a field ends up on one path and
 * not the other.
 */
function toTransfer(transfer: {
  id: string;
  transferredOn: Date;
  membershipDecidedOn: Date | null;
  price: { toString: () => string } | null;
  agreementReference: string | null;
  agreementDocumentPath: string | null;
  fromPerson: { firstName: string; lastName: string } | null;
  toPerson: { firstName: string; lastName: string };
}): ApartmentRegisterTransfer {
  return {
    id: transfer.id,
    transferredOn: isoDate(transfer.transferredOn) ?? "",
    membershipDecidedOn: isoDate(transfer.membershipDecidedOn),
    fromName:
      transfer.fromPerson === null
        ? null
        : `${transfer.fromPerson.firstName} ${transfer.fromPerson.lastName}`.trim(),
    toName:
      `${transfer.toPerson.firstName} ${transfer.toPerson.lastName}`.trim(),
    price: transfer.price?.toString() ?? null,
    agreementReference:
      transfer.agreementReference ?? transfer.agreementDocumentPath,
  };
}

function toTermination(termination: {
  id: string;
  kind: TerminationKind;
  tookEffectOn: Date;
  reference: string;
}): ApartmentRegisterTermination {
  return {
    id: termination.id,
    kind: termination.kind,
    tookEffectOn: isoDate(termination.tookEffectOn) ?? "",
    reference: termination.reference,
  };
}

/**
 * The value a statutory `@db.Date` column takes, or the refusal.
 *
 * The check and the conversion both live in `statutory-date.ts`, which is pure
 * and where the daylight-saving boundary is tested; this only turns its answer
 * into the refusal a board reads.
 */
function statutoryDateColumn(text: string, now: Date): Date {
  const parsed = statutoryDate(text, now);
  if (parsed.ok) {
    return parsed.column;
  }
  throw new ApartmentRegisterError(
    parsed.problem === "date-not-a-calendar-date"
      ? "That is not a calendar date."
      : "That date has not arrived yet.",
    parsed.problem,
  );
}

function isoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
