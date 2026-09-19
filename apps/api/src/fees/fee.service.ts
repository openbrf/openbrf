import { Injectable, Logger } from "@nestjs/common";

import {
  addLocalDays,
  dateColumnOf,
  formatDateColumn,
  formatLocalDay,
  type LocalDay,
  parseLocalDay,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { financialYearStartMonthInForce } from "../retention/financial-year";
import { lockFeeNotifications, lockFeeRates } from "./fee-lock";
import { sumAmounts } from "./fee-period";
import { FeeError } from "./fee.error";

/** What the purge's audit entry names, and what the access report's section is called. */
export const FEE_TARGET_KIND = "fee";

/** The kinds a rate may be recorded under. Mirrors the `FeeKind` enum. */
export const FEE_KINDS = [
  "ANNUAL_FEE",
  "PARKING_SPACE",
  "STORAGE_SPACE",
] as const;

export type FeeKind = (typeof FEE_KINDS)[number];

export type FeeVatTreatment = "EXEMPT" | "RATE";

/**
 * A stored amount read back.
 *
 * `toFixed` rather than `toString`, because the two disagree on exactly the
 * value this module cares about: a `DECIMAL(14, 2)` holding 450 renders as
 * "450" through one and "450.00" through the other, and the document a member
 * pays from has to state ore.
 */
interface AmountValue {
  toFixed: (places: number) => string;
}

export interface FeeRow {
  feeId: string;
  apartmentId: string;
  kind: FeeKind;
  /** "YYYY-MM-DD" on the association's own calendar. */
  appliesFrom: string;
  /** "YYYY-MM-DD", or null while this is the rate in force. */
  appliesUntil: string | null;
  /** Kronor per calendar month, as the decimal column holds it: "3450.50". */
  monthlyAmount: string;
  vatTreatment: FeeVatTreatment;
  /** Whole percent, and null exactly when the treatment is EXEMPT. */
  vatRatePercent: number | null;
}

export interface FeeRegisterApartment {
  apartmentId: string;
  /** The apartment's own number, e.g. "1001". */
  number: string;
  /** "<street> <number> <apartment number>". */
  label: string;
  /**
   * The apartment's participation share (andelstal), as recorded.
   *
   * On this payload for the screen's aid and for no other purpose. Nothing in
   * this service derives an amount from it: BRL 9 kap. 5 § forsta stycket 5
   * leaves the basis for calculating the arsavgift to the stadgar and 9 kap.
   * 13 § leaves fixing the amounts to the board, so a platform that apportioned
   * by it would be enforcing a bylaws construct as if it were statute.
   */
  participationShare: string | null;
  /** The rates in force on the day asked about, oldest kind first. */
  fees: FeeRow[];
  /** What this apartment pays per calendar month, over every rate in force. */
  monthlyAmount: string;
}

export interface FeeRegister {
  housingCooperative: {
    name: string;
    organizationNumber: string | null;
    bankgiro: string | null;
    plusgiro: string | null;
  };
  /** The day the rates are read as in force on. "YYYY-MM-DD". */
  on: string;
  apartments: FeeRegisterApartment[];
  /** The sum of every apartment's monthly amount. Never a balance. */
  monthlyTotal: string;
}

export interface RecordFeeInput {
  actorPersonId: string;
  apartmentId: string;
  kind: FeeKind;
  appliesFrom: string;
  monthlyAmount: string;
  vatTreatment: FeeVatTreatment;
  vatRatePercent: number | null;
}

const FEE_FIELDS = {
  id: true,
  apartmentId: true,
  kind: true,
  appliesFrom: true,
  appliesUntil: true,
  monthlyAmount: true,
  vatTreatment: true,
  vatRatePercent: true,
} as const;

/**
 * The fees the apartments pay (avgifter), and the register of them the board
 * reads.
 *
 * ## What this module is not
 *
 * It is not a ledger, on the charges module's rule and for the same reason:
 * there is no payment, no outstanding balance and no status that stands in for
 * one. The accounting system is where a debt is settled, and a second answer to
 * whether a fee has been paid is worse than none. The pressure to add one comes
 * from the notification screen, where the absence is most visible, and the
 * answer is the same there.
 *
 * It is also not the delivering half. Posting to an accounting system, autogiro
 * and bankgiro files, reminders, collections and an approval step are the paid
 * module, and nothing here is shaped to receive them.
 *
 * ## A rate dated forward is accepted, and a charge dated forward is not
 *
 * The one deliberate difference from `charges/member-charge.service.ts`, whose
 * `readPastDate` refuses a `chargedOn` after today and is untouched by this
 * module. A rate dated forward is the board recording a decision it has taken
 * about a rate - which BRL 9 kap. 13 § makes its standing task - while a charge
 * dated forward is a claim that something happened which has not. That
 * difference is the whole reason these are two tables, and stating it here is
 * what lets `charges/member-charge.error.ts` stand unamended.
 *
 * ## Recording a rate closes the one before it
 *
 * Rates for one apartment and one kind are a history, not a set. Recording one
 * writes `appliesUntil` on the rate in force the day before it begins, in the
 * same transaction, so two rates can never cover one day and the question "what
 * does this apartment pay today" has exactly one answer. A rate that starts on
 * or before one already recorded is refused rather than inserted behind it: the
 * board removes the later rate and records both in order, which is the
 * correction that says what happened. So is a rate starting inside the window
 * of one already closed, which is what removing the rate that closed it leaves
 * behind. The reads and the write run under the lock in `fee-lock.ts`, so two
 * rates recorded at once cannot both pass them.
 *
 * ## No free text, so no scan
 *
 * A fee row carries no words the board wrote, which is why nothing here runs
 * `scanForPersonalIdentityNumbers`. Every other board-written free-text field in
 * this product does, and a note field added to a fee later takes the scan with
 * it, on the argument `member-charge.service.ts` makes: a personal identity
 * number arrives pasted along with the text around it rather than because
 * somebody decided to write one down, and this text would be copied into a
 * document that leaves the association.
 *
 * ## Where the personal data is
 *
 * A fee is recorded against an apartment and names no person, but an apartment
 * leads back to whoever lives in it - which is why it sits in the service tier
 * under this association's ordinary access control, reaches the data subject
 * access report through the residencies covering the period, and is erased by a
 * purge of its own.
 */
@Injectable()
export class FeeService {
  private readonly logger = new Logger(FeeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The fee register as it stands on a day.
   *
   * Every apartment, whether or not it has a rate, because the board's question
   * is as often "which flats have I not set a fee for" as "what does this one
   * pay". An apartment with no rate answers with an empty list and a monthly
   * amount of zero, which is a truthful "nothing is recorded" rather than a
   * claim that the flat pays nothing.
   */
  async readRegister(on: string): Promise<FeeRegister> {
    const day = this.readDate(on);
    const column = dateColumnOf(day);

    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: {
        name: true,
        organizationNumber: true,
        bankgiro: true,
        plusgiro: true,
      },
    });
    if (association === null) {
      throw new FeeError(
        "The housing cooperative has not been created yet.",
        "housing-cooperative-missing",
      );
    }

    const apartments = await this.prisma.apartment.findMany({
      orderBy: [
        { address: { sortOrder: "asc" } },
        { address: { street: "asc" } },
        { address: { number: "asc" } },
        { number: "asc" },
      ],
      select: {
        id: true,
        number: true,
        participationShare: true,
        address: { select: { street: true, number: true } },
        fees: {
          where: {
            appliesFrom: { lte: column },
            OR: [{ appliesUntil: null }, { appliesUntil: { gte: column } }],
          },
          orderBy: [{ kind: "asc" }, { appliesFrom: "asc" }],
          select: FEE_FIELDS,
        },
      },
    });

    const rows = apartments.map((apartment) => {
      const fees = apartment.fees.map((fee) => this.toRow(fee));
      return {
        apartmentId: apartment.id,
        number: apartment.number,
        label: `${apartment.address.street} ${apartment.address.number} ${apartment.number}`,
        // toString and not toFixed: the share is a DECIMAL(12, 8) and the
        // number of places a board typed is part of what they stated. The two
        // money columns in this payload go the other way, for the reason
        // AmountValue gives.
        participationShare: apartment.participationShare?.toString() ?? null,
        fees,
        monthlyAmount: sumAmounts(fees.map((fee) => fee.monthlyAmount)),
      };
    });

    return {
      housingCooperative: association,
      on: formatLocalDay(day),
      apartments: rows,
      monthlyTotal: sumAmounts(rows.map((row) => row.monthlyAmount)),
    };
  }

  /**
   * Records a rate, closing the one it replaces.
   *
   * Answers with the row as the register would show it, so a screen that has
   * just recorded a rate shows the same figures as the register it sits on
   * rather than a second rendering of them.
   */
  async record(input: RecordFeeInput): Promise<FeeRow> {
    const appliesFrom = this.readDate(input.appliesFrom);
    const monthlyAmount = this.readAmount(input.monthlyAmount);
    const vatRatePercent = this.readVatRate(
      input.vatTreatment,
      input.vatRatePercent,
    );

    const apartment = await this.prisma.apartment.findUnique({
      where: { id: input.apartmentId },
      select: { id: true },
    });
    if (apartment === null) {
      throw new FeeError("No such apartment.", "apartment-not-found");
    }

    const fee = await this.prisma.$transaction(async (tx) => {
      /*
       * Before either read, so the two reads and the write below are one
       * decision. Two rates recorded together for the same apartment and kind
       * would otherwise both find nothing in the way and both be written. See
       * `fee-lock.ts`.
       */
      await lockFeeRates(tx, input.apartmentId, input.kind);

      const later = await tx.fee.findFirst({
        where: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          appliesFrom: { gte: dateColumnOf(appliesFrom) },
        },
        select: { id: true },
      });
      if (later !== null) {
        /*
         * Refused rather than inserted behind. Rates are a history and
         * recording one closes the rate before it, so a rate slipped in under
         * an existing one would leave two covering one day with no answer to
         * which the apartment pays.
         */
        throw new FeeError(
          "A later fee of this kind is already recorded for that apartment.",
          "fee-already-recorded-later",
        );
      }

      /*
       * A rate already closed whose window still reaches the new start day.
       *
       * The query above sees only rates that begin on or after the day, and the
       * standing lookup below only the one still open, so a closed rate covering
       * the day passes both - which is exactly what removing the rate that
       * closed it leaves behind. Recording into its window would give the
       * apartment two rates for the same days, and a run would bill both.
       * Refused with a reason of its own, because the correction differs: the
       * new rate starts the day after this one ends, or this one is removed.
       */
      const covering = await tx.fee.findFirst({
        where: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          appliesUntil: { not: null, gte: dateColumnOf(appliesFrom) },
        },
        select: { id: true },
      });
      if (covering !== null) {
        throw new FeeError(
          "A fee of this kind already applies to that apartment on that day.",
          "fee-already-in-force",
        );
      }

      const standing = await tx.fee.findFirst({
        where: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          appliesUntil: null,
        },
        select: { id: true, appliesFrom: true },
      });
      if (standing !== null) {
        // The day before the new rate begins, so the two meet without
        // overlapping and without a gap.
        await tx.fee.update({
          where: { id: standing.id },
          data: {
            appliesUntil: dateColumnOf(addLocalDays(appliesFrom, -1)),
          },
        });
      }

      const created = await tx.fee.create({
        data: {
          apartmentId: input.apartmentId,
          kind: input.kind,
          appliesFrom: dateColumnOf(appliesFrom),
          monthlyAmount,
          vatTreatment: input.vatTreatment,
          vatRatePercent,
          recordedByPersonId: input.actorPersonId,
          // The books this rate is entered in, so its erasure is counted from
          // them and not from whatever the setting says later.
          financialYearStartMonth: await financialYearStartMonthInForce(tx),
        },
        select: FEE_FIELDS,
      });

      await this.audit.record(
        {
          action: "FEE_RECORDED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          // No subject. Which of the apartment's residents this would be is a
          // question the log must not answer by guessing, exactly as the
          // charge module's apartment-keyed entry says.
          targetPersonId: null,
          targetKind: FEE_TARGET_KIND,
          targetId: created.id,
          /*
           * The apartment, the kind and the day it starts. Never the amount:
           * the log is exempt from every purge, so a figure copied in here
           * would be a permanent record of what one household pays inside the
           * entry that merely says a rate was recorded.
           */
          context: {
            apartmentId: input.apartmentId,
            kind: input.kind,
            appliesFrom: formatLocalDay(appliesFrom),
            ...(standing === null ? {} : { replacedFeeId: standing.id }),
          },
        },
        tx,
      );

      return created;
    });

    this.logger.log(
      `Fee recorded for apartment ${input.apartmentId} from ${formatLocalDay(
        appliesFrom,
      )}`,
    );
    return this.toRow(fee);
  }

  /**
   * Removes a rate recorded in error.
   *
   * Removed and not corrected, on the shape the charges module's own correction
   * takes for the charged party: a rate on the wrong apartment or of the wrong
   * kind is removed and recorded again, so the log says what happened. A rate
   * that is merely out of date is not removed at all - recording the next one
   * closes it, and the closed row is what says what the apartment paid until
   * then.
   *
   * A rate a notification run has already billed from cannot be removed. That
   * notice is the basis for money the association asked for, and bokforingslagen
   * 7 kap. 1 § forbids altering preserved rakenskapsinformation; the purge is
   * the one thing that reaches it.
   *
   * The rate before it does not re-open. A removal leaves the apartment with no
   * rate of that kind from the day the removed one began, which the register
   * shows plainly, and the board records what it meant to record.
   */
  async remove(feeId: string, actorPersonId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // A run issued between the question below and the delete would bill a
      // rate that then no longer exists. See `fee-lock.ts`.
      await lockFeeNotifications(tx);

      const fee = await tx.fee.findUnique({
        where: { id: feeId },
        select: {
          id: true,
          apartmentId: true,
          kind: true,
          appliesFrom: true,
          appliesUntil: true,
        },
      });
      if (fee === null) {
        throw new FeeError("No such fee.", "not-found");
      }

      const billed = await tx.feeNotification.findFirst({
        where: {
          periodTo: { gte: fee.appliesFrom },
          ...(fee.appliesUntil === null
            ? {}
            : { periodFrom: { lte: fee.appliesUntil } }),
          notices: { some: { apartmentId: fee.apartmentId } },
        },
        select: { id: true },
      });
      if (billed !== null) {
        throw new FeeError(
          "That fee has already been billed and cannot be removed.",
          "fee-notified",
        );
      }

      await tx.fee.delete({ where: { id: feeId } });

      await this.audit.record(
        {
          action: "FEE_REMOVED",
          channel: "WEB",
          actorPersonId,
          targetPersonId: null,
          targetKind: FEE_TARGET_KIND,
          targetId: feeId,
          // The apartment and the kind, and no figure, per the recording
          // entry's own rule.
          context: { apartmentId: fee.apartmentId, kind: fee.kind },
        },
        tx,
      );
    });

    this.logger.log(`Fee ${feeId} removed`);
  }

  /** A stored row as the register states it. */
  private toRow(fee: {
    id: string;
    apartmentId: string;
    kind: string;
    appliesFrom: Date;
    appliesUntil: Date | null;
    monthlyAmount: AmountValue;
    vatTreatment: string;
    vatRatePercent: number | null;
  }): FeeRow {
    return {
      feeId: fee.id,
      apartmentId: fee.apartmentId,
      kind: fee.kind as FeeKind,
      appliesFrom: formatDateColumn(fee.appliesFrom),
      appliesUntil: formatDateColumn(fee.appliesUntil),
      monthlyAmount: fee.monthlyAmount.toFixed(2),
      vatTreatment: fee.vatTreatment as FeeVatTreatment,
      vatRatePercent: fee.vatRatePercent,
    };
  }

  /** A date the board stated, read as a calendar day rather than as an instant. */
  private readDate(text: string): LocalDay {
    const day = parseLocalDay(text);
    if (day === null) {
      throw new FeeError(
        "That is not a calendar date.",
        "date-not-a-calendar-date",
      );
    }
    return day;
  }

  /**
   * An amount the board stated, as the column holds it.
   *
   * The controller's own pattern is `^\d{1,12}(\.\d{1,2})?$`, so there is a
   * whole part, at most two decimals, and nothing else to handle. Refused and
   * never rounded: a fee the board did not state is a fee nobody decided on.
   */
  private readAmount(amount: string): string {
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(amount)) {
      throw new FeeError(
        "That is not a sum of kronor and ore.",
        "amount-not-a-sum",
      );
    }
    const [whole, fraction = ""] = amount.split(".");
    const normalised = `${String(BigInt(whole ?? "0"))}.${fraction.padEnd(2, "0")}`;
    if (normalised === "0.00") {
      throw new FeeError("A fee is a positive amount.", "amount-not-positive");
    }
    return normalised;
  }

  /** The rate belongs to the treatment that has one. */
  private readVatRate(
    treatment: FeeVatTreatment,
    vatRatePercent: number | null,
  ): number | null {
    if (treatment === "EXEMPT") {
      if (vatRatePercent !== null) {
        throw new FeeError(
          "An exempt fee carries no rate.",
          "vat-rate-not-applicable",
        );
      }
      return null;
    }

    if (vatRatePercent === null) {
      throw new FeeError(
        "A fee carrying value added tax states its rate.",
        "vat-rate-required",
      );
    }
    if (
      !Number.isInteger(vatRatePercent) ||
      vatRatePercent < 1 ||
      vatRatePercent > 100
    ) {
      throw new FeeError(
        "That is not a whole percentage.",
        "vat-rate-out-of-range",
      );
    }
    return vatRatePercent;
  }
}
