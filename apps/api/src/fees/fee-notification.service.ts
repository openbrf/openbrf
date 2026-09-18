import { Injectable, Logger } from "@nestjs/common";

import {
  compareLocalDays,
  dateColumnOf,
  formatDateColumn,
  formatLocalDay,
  type LocalDay,
  localDayOf,
  parseLocalDay,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  amountForMonths,
  isWholeMonths,
  MAX_MONTHS_PER_PERIOD,
  monthsIn,
  sumAmounts,
} from "./fee-period";
import {
  type FeeNoticeDocument,
  feeNoticeListFileName,
  type FeeNoticeRow,
  totalOf,
  writeFeeNoticeList,
} from "./fee-notice";
import { FeeError } from "./fee.error";
import { MAX_NOTICES_PER_RUN, paymentReferenceFor } from "./payment-reference";

/** One run as the board's list shows it. */
export interface FeeNotificationSummary {
  notificationId: string;
  /** "YYYY-MM-DD", inclusive at both ends. */
  from: string;
  to: string;
  dueOn: string;
  issuedOn: string;
  /** How many apartments were billed. */
  notices: number;
  /** The sum of the notices' amounts. A sum of what was billed, never a balance. */
  total: string;
}

/** The document plus the file it is taken away as. */
export interface FeeNoticeExport {
  document: FeeNoticeDocument;
  fileName: string;
  csv: string;
}

export interface IssueNotificationInput {
  actorPersonId: string;
  from: string;
  to: string;
  dueOn: string;
}

/**
 * Issuing a period's fee notices, and producing the document they are taken
 * away as (avisering).
 *
 * ## Produced, not sent
 *
 * The run writes the rows and the board takes the document away. Nothing here
 * emails or posts anything: sending is core rather than paid - a member's
 * notice reaching a member is not delivery into another system - but it is its
 * own act with its own claim-once problem, and it lands after a produced notice
 * has been read by a real board. There is no delivery state on a row to be left
 * half-true in the meantime.
 *
 * ## One run per period
 *
 * A period may be issued once, and two runs may not overlap. A month billed
 * twice would give the association two answers to what it asked for and two
 * sets of payment references for one month's money, and a member holding the
 * older notice would be quoting a reference against a sum that had been
 * superseded. The refusal names which of the two it is, because they are met by
 * different corrections.
 *
 * It is also what makes the payment reference unique without any counter: the
 * reference carries the month the period opens in, and no two runs can open in
 * the same month if none of them may overlap.
 *
 * ## What a period is
 *
 * Whole calendar months, and each month billed at the rate in force on its
 * first day. The arithmetic and the reason it has to be exact are in
 * `fee-period.ts`. A period that is not whole months is refused rather than
 * apportioned: a part month needs a division of kronor by days, and this
 * product refuses a malformed amount rather than rounding one.
 *
 * ## Never edited afterwards
 *
 * A run and its notices are rakenskapsinformation (bokforingslagen 1 kap. 2 §
 * 9 through 5 kap. 6-7 §§), and 7 kap. 1 § forbids altering what is preserved.
 * There is no route here that changes a row: a correction is a new act that
 * records the correction - which 5 kap. 9 § requires of a rattelse in any case -
 * and the purge is the only thing that reaches these rows.
 *
 * ## The due date
 *
 * Stated by the board and read by nothing. BRL 7 kap. 18 § makes an arsavgift
 * unpaid more than a week after the forfallodag a ground for forverkande of the
 * nyttjanderatt, with no anmaning, and 7 kap. 23 § then requires a served
 * notice and a message to socialnamnden before anybody can be made to leave. A
 * platform that counted those days would be running a forfeiture procedure. It
 * is bounded to the period it bills and decides nothing.
 */
@Injectable()
export class FeeNotificationService {
  private readonly logger = new Logger(FeeNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** The runs the board has made, newest period first. */
  async list(): Promise<FeeNotificationSummary[]> {
    const runs = await this.prisma.feeNotification.findMany({
      orderBy: [{ periodTo: "desc" }, { periodFrom: "desc" }],
      select: {
        id: true,
        periodFrom: true,
        periodTo: true,
        dueOn: true,
        issuedAt: true,
        notices: { select: { amount: true } },
      },
    });

    return runs.map((run) => ({
      notificationId: run.id,
      from: formatDateColumn(run.periodFrom),
      to: formatDateColumn(run.periodTo),
      dueOn: formatDateColumn(run.dueOn),
      issuedOn: formatLocalDay(localDayOf(run.issuedAt)),
      notices: run.notices.length,
      total: sumAmounts(run.notices.map((notice) => notice.amount.toFixed(2))),
    }));
  }

  /**
   * Issues the period's notices, in one transaction.
   *
   * One transaction because a half-issued period is worse than an unissued one:
   * the board would have sent some households a notice and not others, with
   * nothing saying which, and the period would be taken so the run could not be
   * repeated.
   */
  async issue(input: IssueNotificationInput): Promise<FeeNotificationSummary> {
    const period = this.readPeriod(input.from, input.to);
    const dueOn = this.readDate(input.dueOn);
    if (compareLocalDays(dueOn, period.from) < 0) {
      throw new FeeError(
        "The due date cannot fall before the period it bills.",
        "due-before-period",
      );
    }

    const months = monthsIn(period.from, period.to);
    if (months.length > MAX_MONTHS_PER_PERIOD) {
      throw new FeeError(
        `A period bills at most ${String(MAX_MONTHS_PER_PERIOD)} months.`,
        "period-too-long",
      );
    }

    const summary = await this.prisma.$transaction(async (tx) => {
      const clash = await tx.feeNotification.findFirst({
        where: {
          periodFrom: { lte: dateColumnOf(period.to) },
          periodTo: { gte: dateColumnOf(period.from) },
        },
        select: { id: true, periodFrom: true, periodTo: true },
      });
      if (clash !== null) {
        const identical =
          formatDateColumn(clash.periodFrom) === formatLocalDay(period.from) &&
          formatDateColumn(clash.periodTo) === formatLocalDay(period.to);
        throw identical
          ? new FeeError(
              "That period has already been issued.",
              "period-already-issued",
            )
          : new FeeError(
              "That period overlaps one already issued.",
              "period-overlaps-a-run",
            );
      }

      const amounts = await this.amountPerApartment(tx, months);
      if (amounts.length === 0) {
        /*
         * Refused rather than recorded empty. A run with no notices states that
         * the board issued the period's notices when it issued none, and it
         * would take the period so the real run could never be made.
         */
        throw new FeeError(
          "No apartment has a fee in force for that period.",
          "nothing-to-bill",
        );
      }
      if (amounts.length > MAX_NOTICES_PER_RUN) {
        throw new FeeError(
          `A run carries at most ${String(MAX_NOTICES_PER_RUN)} notices.`,
          "too-many-notices",
        );
      }

      const run = await tx.feeNotification.create({
        data: {
          periodFrom: dateColumnOf(period.from),
          periodTo: dateColumnOf(period.to),
          dueOn: dateColumnOf(dueOn),
          issuedByPersonId: input.actorPersonId,
        },
        select: { id: true, issuedAt: true },
      });

      await tx.feeNotice.createMany({
        data: amounts.map((billed, index) => ({
          notificationId: run.id,
          apartmentId: billed.apartmentId,
          amount: billed.amount,
          // The position within the run, counting from 1, over the stable
          // ordering `amountPerApartment` reads in.
          paymentReference: paymentReferenceFor(
            formatLocalDay(period.from),
            index + 1,
          ),
        })),
      });

      await this.audit.record(
        {
          action: "FEE_NOTIFICATION_ISSUED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          // No subject: a run names every apartment rather than one person, and
          // which residents those are is a question the log must not answer by
          // guessing.
          targetPersonId: null,
          targetKind: "feeNotification",
          targetId: run.id,
          /*
           * The period, the due date and how many notices. Never a figure and
           * never an apartment: the log is exempt from every purge, and this
           * entry outlives the rows it describes by design.
           */
          context: {
            from: formatLocalDay(period.from),
            to: formatLocalDay(period.to),
            dueOn: formatLocalDay(dueOn),
            notices: amounts.length,
            months: months.length,
          },
        },
        tx,
      );

      return {
        notificationId: run.id,
        from: formatLocalDay(period.from),
        to: formatLocalDay(period.to),
        dueOn: formatLocalDay(dueOn),
        issuedOn: formatLocalDay(localDayOf(run.issuedAt)),
        notices: amounts.length,
        total: sumAmounts(amounts.map((billed) => billed.amount)),
      };
    });

    this.logger.log(
      `Issued ${String(summary.notices)} fee notices for ${summary.from} to ${summary.to}`,
    );
    return summary;
  }

  /**
   * Produces one run's document, and records that it was produced.
   *
   * Through `withAuditedRead`, so the document and the entry that says it was
   * taken share a fate: a copy of named apartments' amounts leaving the
   * association is a disclosure somebody chose to make, and a document produced
   * without an entry would leave no trace of it.
   */
  async produce(input: {
    actorPersonId: string;
    notificationId: string;
    now?: Date;
  }): Promise<FeeNoticeExport> {
    const now = input.now ?? new Date();

    const document = await this.audit.withAuditedRead<FeeNoticeDocument>(
      {
        action: "FEE_NOTIFICATION_EXPORTED",
        channel: "WEB",
        actorPersonId: input.actorPersonId,
        targetKind: "feeNotification",
        targetId: input.notificationId,
        // Which run was taken and nothing it held. This entry says who took a
        // copy of what, which is the question a supervisory authority asks, and
        // the copy itself is the document rather than the log.
        context: { notificationId: input.notificationId },
      },
      async (tx) => this.build(tx, input.notificationId, now),
    );

    return {
      document,
      fileName: feeNoticeListFileName(document.from, document.to),
      csv: writeFeeNoticeList(document),
    };
  }

  /**
   * What each apartment owes for the period, in the order the run numbers them.
   *
   * One query over the rates that touch the period, then the months counted per
   * apartment in this process. A month is billed at the rate in force on its
   * first day, which is stated in `fee-period.ts` and is what keeps the
   * arithmetic to a multiplication.
   *
   * The ordering is the register's own - the house, then the apartment number -
   * so a run numbers its notices the way a board reads them, and two runs over
   * the same apartments number them the same way.
   */
  private async amountPerApartment(
    tx: Prisma.TransactionClient,
    months: readonly LocalDay[],
  ): Promise<{ apartmentId: string; amount: string }[]> {
    const first = months.at(0);
    const last = months.at(-1);
    if (first === undefined || last === undefined) {
      return [];
    }

    const rates = await tx.fee.findMany({
      where: {
        appliesFrom: { lte: dateColumnOf(last) },
        OR: [
          { appliesUntil: null },
          { appliesUntil: { gte: dateColumnOf(first) } },
        ],
      },
      orderBy: [
        { apartment: { address: { sortOrder: "asc" } } },
        { apartment: { address: { street: "asc" } } },
        { apartment: { address: { number: "asc" } } },
        { apartment: { number: "asc" } },
        { kind: "asc" },
        { appliesFrom: "asc" },
      ],
      select: {
        apartmentId: true,
        appliesFrom: true,
        appliesUntil: true,
        monthlyAmount: true,
      },
    });

    // A Map keeps the query's order, which is the register's, so the run's
    // numbering follows from the read rather than from a second sort.
    const perApartment = new Map<string, string[]>();
    for (const rate of rates) {
      const billableMonths = months.filter((month) => {
        const column = dateColumnOf(month).getTime();
        return (
          rate.appliesFrom.getTime() <= column &&
          (rate.appliesUntil === null || rate.appliesUntil.getTime() >= column)
        );
      }).length;
      if (billableMonths === 0) {
        continue;
      }
      const amounts = perApartment.get(rate.apartmentId) ?? [];
      amounts.push(
        amountForMonths(rate.monthlyAmount.toFixed(2), billableMonths),
      );
      perApartment.set(rate.apartmentId, amounts);
    }

    return [...perApartment.entries()].map(([apartmentId, amounts]) => ({
      apartmentId,
      amount: sumAmounts(amounts),
    }));
  }

  /** One run as the document states it. */
  private async build(
    tx: Prisma.TransactionClient,
    notificationId: string,
    now: Date,
  ): Promise<FeeNoticeDocument> {
    const association = await tx.association.findUnique({
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

    const run = await tx.feeNotification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        periodFrom: true,
        periodTo: true,
        dueOn: true,
        issuedAt: true,
        notices: {
          orderBy: [{ paymentReference: "asc" }],
          select: {
            id: true,
            amount: true,
            paymentReference: true,
            apartmentId: true,
            apartment: {
              select: {
                number: true,
                address: { select: { street: true, number: true } },
              },
            },
          },
        },
      },
    });
    if (run === null) {
      throw new FeeError("No such fee notification.", "not-found");
    }

    /*
     * Who held each flat when the period closed, which is who the notice is
     * for. Read through the register rather than off the notice, because the
     * notice records the money and the register records who holds what - a name
     * copied onto a notice would be a second answer the day the flat changed
     * hands, and the notice is preserved for seven years.
     *
     * MEMBER only: the arsavgift is the bostadsrattshavare's to pay under BRL
     * 7 kap. 14 §, and a partner or a tenant living there holds none of it.
     *
     * A second query rather than a nested one, because the period it is asked
     * about is on the row the first query returns.
     */
    const holders = await tx.residency.findMany({
      where: {
        apartmentId: { in: run.notices.map((notice) => notice.apartmentId) },
        role: "MEMBER",
        movedInOn: { lte: run.periodTo },
        OR: [{ movedOutOn: null }, { movedOutOn: { gte: run.periodTo } }],
      },
      orderBy: [{ movedInOn: "asc" }],
      select: {
        apartmentId: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            protectedPersonalData: true,
          },
        },
      },
    });

    const byApartment = new Map<string, typeof holders>();
    for (const holder of holders) {
      byApartment.set(holder.apartmentId, [
        ...(byApartment.get(holder.apartmentId) ?? []),
        holder,
      ]);
    }

    const rows: FeeNoticeRow[] = run.notices.map((notice) => ({
      noticeId: notice.id,
      apartment: `${notice.apartment.address.street} ${notice.apartment.address.number} ${notice.apartment.number}`,
      apartmentNumber: notice.apartment.number,
      holders: holdersOf(byApartment.get(notice.apartmentId) ?? []),
      amount: notice.amount.toFixed(2),
      paymentReference: notice.paymentReference,
    }));

    return {
      housingCooperative: association,
      notificationId: run.id,
      from: formatDateColumn(run.periodFrom),
      to: formatDateColumn(run.periodTo),
      dueOn: formatDateColumn(run.dueOn),
      issuedOn: formatLocalDay(localDayOf(run.issuedAt)),
      generatedOn: formatLocalDay(localDayOf(now)),
      rows,
      total: totalOf(rows),
    };
  }

  /** A period the board stated, bounded to whole calendar months. */
  private readPeriod(
    from: string,
    to: string,
  ): { from: LocalDay; to: LocalDay } {
    const start = this.readDate(from);
    const end = this.readDate(to);
    if (!isWholeMonths(start, end)) {
      throw new FeeError(
        "A period runs from the first of a month to the last of one.",
        "period-not-whole-months",
      );
    }
    return { from: start, to: end };
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
}

/**
 * Who a notice names, or the statement that the names are withheld.
 *
 * The other end of the debiting list's masking rule. There the person is the
 * charged party and their apartment is withheld; here the apartment is the
 * party the fee is fixed on and cannot be withheld without emptying the row, so
 * it is the name that goes. What protection exists to withhold is the link
 * between a name and a door, either way.
 *
 * One protected holder withholds the whole household's names rather than their
 * own, because naming the others on a flat of two is naming the household, and
 * the link the masking removes would be back in place.
 */
function holdersOf(
  residencies: readonly {
    person: {
      firstName: string;
      lastName: string;
      protectedPersonalData: boolean;
    };
  }[],
): FeeNoticeRow["holders"] {
  if (residencies.some((residency) => residency.person.protectedPersonalData)) {
    return { state: "withheld" };
  }
  return {
    state: "visible",
    names: residencies.map((residency) =>
      `${residency.person.firstName} ${residency.person.lastName}`.trim(),
    ),
  };
}
