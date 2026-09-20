import { Injectable } from "@nestjs/common";
import {
  compareLocalDays,
  dateColumnOf,
  formatDateColumn,
  formatDayOfInstant,
  formatLocalDay,
  type LocalDay,
  parseLocalDay,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { DebitingListRow } from "../charges/debiting-list";
import { MemberChargeService } from "../charges/member-charge.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type AccountingBasis,
  accountingBasisFileName,
  type AccountingBasisRow,
  totalsOf,
  writeAccountingBasis,
} from "./accounting-basis";
import { AccountingError } from "./accounting.error";

/** The basis plus the file it is taken away as. */
export interface AccountingBasisExport {
  basis: AccountingBasis;
  fileName: string;
  csv: string;
}

/**
 * The period's fee notices and member charges, as the file whoever keeps the
 * association's books reads (bokforingsunderlag).
 *
 * ## One act, and it is a disclosure
 *
 * There is no read half. Every row is a copy of a named apartment's or a named
 * person's money leaving the association for a recipient outside it, so the one
 * thing this service does is produce the file, through `withAuditedRead` so the
 * rows and the entry that records the disclosure commit together. The debiting
 * list and the notice document each keep an unaudited read for the board's own
 * screen because a board reads them while it works; nobody reads this file on a
 * screen without taking it.
 *
 * ## Which rows a period holds
 *
 * A charge falls on one day and is in the period when that day is
 * (`chargedOn`), which is the debiting list's own rule.
 *
 * **A notification run is dated by the day its period opens.** Its notices are
 * in the export when that day is in the period, whatever the run's own period
 * does afterwards. A notice's amount is what was billed for the whole run and
 * this product refuses to apportion one - a part period would need a
 * division of kronor by days - so a run that straddles the end of the export
 * period is carried whole at its opening rather than split. Every run therefore
 * lands in exactly one export of consecutive periods: never counted twice and
 * never dropped between two. The row states the run's own period in its two
 * date columns, so a reader can see what a figure covers.
 *
 * ## The charge half is read through the charges module
 *
 * `MemberChargeService.list` builds the rows, masking included, and this
 * service adapts them. The masking rule is the hard part and exists once: a
 * second read here would be a second place deciding whether a protected
 * person's apartment reaches a file the association hands out.
 *
 * ## Whose money, and nothing about payment
 *
 * No account numbers, no verification series and no balance: Open BRF holds no
 * ledger and no chart of accounts. Nothing says whether anything was paid,
 * because the accounting system settles the debt and a second answer to that is
 * worse than none.
 */
@Injectable()
export class AccountingBasisService {
  constructor(
    private readonly audit: AuditLogService,
    private readonly charges: MemberChargeService,
  ) {}

  /**
   * Produces the period's basis, and records that it was produced.
   *
   * A POST rather than a GET on the controller, and audited here rather than
   * there, for the reason the debiting list export gives: an audited disclosure
   * has to be an act somebody chose to take rather than something a prefetch, a
   * bookmark or a link checker could cause.
   */
  async produce(
    input: { actorPersonId: string; from: string; to: string },
    now: Date = new Date(),
  ): Promise<AccountingBasisExport> {
    const period = this.readPeriod(input.from, input.to);

    const basis = await this.audit.withAuditedRead<AccountingBasis>(
      {
        action: "ACCOUNTING_BASIS_EXPORTED",
        channel: "WEB",
        actorPersonId: input.actorPersonId,
        // No subject: the file names every apartment billed and every person
        // charged in the period rather than one of them.
        targetPersonId: null,
        /*
         * The period asked for, and nothing the file held. This entry says who
         * took a copy of what, which is the question a supervisory authority
         * asks, and the copy itself is the file rather than the log - which is
         * exempt from every purge and would otherwise keep a household's
         * figures after the rows themselves were erased.
         */
        context: { from: period.from, to: period.to },
      },
      async (tx) => this.build(tx, period, now),
    );

    return {
      basis,
      fileName: accountingBasisFileName(basis.from, basis.to),
      csv: writeAccountingBasis(basis),
    };
  }

  /** The period's rows, read inside the audited transaction. */
  private async build(
    tx: Prisma.TransactionClient,
    period: { fromDay: LocalDay; toDay: LocalDay; from: string; to: string },
    now: Date,
  ): Promise<AccountingBasis> {
    const association = await tx.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });
    if (association === null) {
      throw new AccountingError(
        "The housing cooperative has not been created yet.",
        "housing-cooperative-missing",
      );
    }

    const notices = await this.feeRows(tx, period);
    const list = await this.charges.list(period.from, period.to, now, tx);
    const rows = [...notices, ...list.rows.map(toChargeRow)];

    return {
      housingCooperative: association,
      from: period.from,
      to: period.to,
      // An instant and not a date column, so the day it falls on is read on
      // the association's calendar.
      generatedOn: formatDayOfInstant(now),
      rows,
      ...totalsOf(rows),
    };
  }

  /**
   * The notices of every run whose period opens inside the export period.
   *
   * Ordered by the run's opening day and then by the payment reference, which
   * is the order the run numbered its apartments in - the house, then the
   * apartment number. A stable order rather than the database's, so two exports
   * of one period are the same file unless the rows themselves changed.
   *
   * No holder is read. The fee half of this file names nobody, per the module
   * comment on `accounting-basis.ts`.
   *
   * No lock is taken. `fees/fee-lock.ts` serialises the writers whose
   * invariants are read and then written; this is a read, and a run and its
   * notices are committed in one transaction and read here in one statement,
   * so the file carries a run whole or not at all.
   */
  private async feeRows(
    tx: Prisma.TransactionClient,
    period: { fromDay: LocalDay; toDay: LocalDay },
  ): Promise<AccountingBasisRow[]> {
    const notices = await tx.feeNotice.findMany({
      where: {
        notification: {
          periodFrom: {
            gte: dateColumnOf(period.fromDay),
            lte: dateColumnOf(period.toDay),
          },
        },
      },
      orderBy: [
        { notification: { periodFrom: "asc" } },
        { paymentReference: "asc" },
      ],
      select: {
        id: true,
        amount: true,
        paymentReference: true,
        notification: { select: { periodFrom: true, periodTo: true } },
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
      },
    });

    return notices.map((notice) => ({
      kind: "FEE_NOTICE" as const,
      rowId: notice.id,
      // Date columns, so read as the calendar day they hold and not through
      // the association's zone, which would move them a day at midnight UTC.
      from: formatDateColumn(notice.notification.periodFrom),
      to: formatDateColumn(notice.notification.periodTo),
      apartment: {
        state: "visible" as const,
        label: `${notice.apartment.address.street} ${notice.apartment.address.number} ${notice.apartment.number}`,
      },
      name: null,
      /*
       * `toFixed(2)` and never `toString()`. The decimal column renders as
       * `<digits>.<two digits>` and the sums are taken over that rendering; a
       * value that reached the file any other way would be a figure this table
       * cannot hold.
       */
      amount: notice.amount.toFixed(2),
      /*
       * Null, and deliberately not recomputed. A notice is one frozen figure
       * per apartment, summed across the kinds it holds and the months of the
       * run; splitting it by value added tax would mean reading the rates back
       * and multiplying them again, which is a second answer to what was
       * actually billed. `docs/accounting-basis-contract.md` says where the
       * treatment is read instead.
       */
      vatTreatment: null,
      vatRatePercent: null,
      reason: null,
      paymentReference: notice.paymentReference,
    }));
  }

  /**
   * The period a read covers, as calendar dates the board stated.
   *
   * The debiting list's own two refusals, spelled the same way: the two exports
   * are asked the same question in the same words, and a period is not bounded
   * beyond that because the nightly purge is what bounds how far back any
   * period can reach.
   */
  private readPeriod(
    from: string,
    to: string,
  ): { fromDay: LocalDay; toDay: LocalDay; from: string; to: string } {
    const fromDay = parseLocalDay(from);
    const toDay = parseLocalDay(to);
    if (fromDay === null || toDay === null) {
      throw new AccountingError(
        "A period is stated as two calendar dates.",
        "date-not-a-calendar-date",
      );
    }
    if (compareLocalDays(fromDay, toDay) > 0) {
      throw new AccountingError(
        "A period cannot end before it begins.",
        "range-invalid",
      );
    }
    return {
      fromDay,
      toDay,
      from: formatLocalDay(fromDay),
      to: formatLocalDay(toDay),
    };
  }
}

/**
 * One debiting list row as the basis states it.
 *
 * An adapter and not a second reading. What the charges module decided - who
 * the charged party is, and whether their apartment reaches a file that leaves
 * the association - is carried across unchanged; what this function does is put
 * it in the columns both halves share.
 */
function toChargeRow(row: DebitingListRow): AccountingBasisRow {
  const party = row.chargedTo;
  return {
    kind: "MEMBER_CHARGE",
    rowId: row.chargeId,
    // A charge falls on one day and states it as both ends of its period, so
    // every row in the file answers the same question in the same two columns.
    from: row.chargedOn,
    to: row.chargedOn,
    apartment:
      party.apartment.state === "masked"
        ? { state: "withheld" }
        : { state: "visible", label: party.apartment.label },
    name: party.kind === "person" ? party.name : null,
    amount: row.amount,
    vatTreatment: row.vatTreatment,
    vatRatePercent: row.vatRatePercent,
    reason: row.reason,
    paymentReference: null,
  };
}
