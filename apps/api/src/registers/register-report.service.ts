import { Injectable } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma, RegisterReportKind } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { formatLocalDay, localDayOf } from "../bookings/stockholm-calendar";
import {
  compareByDeadline,
  daysUntilDue,
  type ReportState,
  reportState,
} from "./report-state";
import { statutoryDate } from "./statutory-date";

/**
 * What the association still owes the cooperative housing register.
 *
 * The obligation ledger records a deadline per reportable event. This is the
 * question a board actually asks of it: which of those deadlines is still
 * running, which has passed, and which has been dealt with.
 *
 * ## Where "reported" lives, and why it is not on the ledger
 *
 * `register_report_obligation` is statutory tier and append-only on both of that
 * tier's mechanisms - a BEFORE UPDATE OR DELETE trigger that stops every caller
 * including the schema owner, and a REVOKE of UPDATE and DELETE from the runtime
 * role, because a trigger is switched off by a table's owner and the application
 * connects as a role that owns nothing. A `reportedOn` column would need every
 * one of those guarantees relaxed for one field, and the model's own comment
 * already draws the line: the event a row reports cannot change and neither can
 * the day the statute counts the window from, so discharging the duty is a
 * separate later fact about a report that was made rather than an edit to the
 * row.
 *
 * The audit log is where that fact goes, and it is not a weaker home. It carries
 * the same two mechanisms - the same append-only trigger and its own REVOKE line
 * in prisma/sql/harden-runtime-role.sql - so a discharge is exactly as
 * tamper-evident as the deadline it discharges, and it already records the three
 * things the act consists of: who stated it, which duty it was about, and when
 * they stated it. What it adds is the day stated, which is the day Lag (2026:484)
 * 3 kap. 2 and 3 §§ make operative: a registration is made "vid den tidpunkt da
 * en fullstandig anmalan kom in till Lantmateriet".
 *
 * It also records the act as what it is. The anmalan is made to Lantmateriet
 * outside this platform - the technical interface is not published - so nothing
 * here observes it arriving. A column would read as a fact the system knows; an
 * entry reads as a statement a named board member made, which is what it is.
 *
 * Two statements about one anmalan are therefore two entries rather than a
 * conflict, and the queue reads the earliest. The write below refuses a second
 * one for the board's benefit, and that refusal is a read rather than a claim:
 * there is nothing on an append-only log to claim conditionally, so two
 * simultaneous statements both land, both are true records of what was said, and
 * the earliest is the one the queue shows.
 *
 * ## Reading the queue is not audited
 *
 * Deliberately, and the ledger's writes are. A duty carries an apartment
 * designation and two statutory dates and no personal data at all: no name, no
 * address, no personal identity number. The acts it is about each have an entry
 * of their own already - the register write, the deadline being entered, and the
 * report being made - so an entry here would record none of them a second time.
 * And this is the screen a board opens every time it meets, so one entry per
 * read would bury the disclosures the log exists to record, which is the
 * reasoning MEDIA_ACCESSED states about images.
 *
 * ## No personal data reaches this service
 *
 * It is not given {@link FieldEncryptionService} and reads no person row, which
 * is what makes the paragraph above structural rather than a promise. The one
 * operation in this module that decrypts a personal identity number is the
 * initial supply, and it is a separate service behind a capability of its own.
 */

export type RegisterReportErrorReason =
  | "obligation-not-found"
  | "report-already-recorded"
  | "report-before-the-window-opened"
  | "date-not-a-calendar-date"
  | "date-in-the-future";

/**
 * Which reasons are a conflict, which an absence and which a bad request.
 *
 * A map rather than a chain of ternaries, for the reason the apartment
 * register's own list gives: a reason added without a status here is a compile
 * error, where a fall-through default would answer 404 to a refusal that is
 * nothing of the kind.
 */
const ERROR_STATUS = {
  "obligation-not-found": 404,
  "report-already-recorded": 409,
  "report-before-the-window-opened": 400,
  "date-not-a-calendar-date": 400,
  "date-in-the-future": 400,
} as const satisfies Record<RegisterReportErrorReason, number>;

export class RegisterReportError extends DomainError {
  override readonly status: number;
  override readonly reason: RegisterReportErrorReason;

  constructor(message: string, reason: RegisterReportErrorReason) {
    super(message);
    this.reason = reason;
    this.status = ERROR_STATUS[reason];
  }
}

/** One dated duty, as the queue states it. */
export interface RegisterReportDuty {
  id: string;
  kind: RegisterReportKind;
  apartmentId: string;
  /** Address and apartment number, as the apartment register designates it. */
  designation: string;
  /** The register event the report is about. Exactly one of the two is set. */
  transferId: string | null;
  terminationId: string | null;
  /** The day the statutory window opened. */
  triggeredOn: string;
  /** The day it closes: `triggeredOn` plus fourteen days. */
  dueOn: string;
  state: ReportState;
  /**
   * Calendar days from today to the deadline. Zero on the last day of the
   * window, which is inside it, and negative once it has passed.
   *
   * On the payload rather than computed by the screen, so the count and the
   * state cannot disagree: both come from the same clock on the same read, and a
   * browser whose own clock is a day out would otherwise render a duty as due
   * with "1 day overdue" beside it.
   */
  daysUntilDue: number;
  /**
   * The day the anmalan was stated to have reached Lantmateriet, or null.
   *
   * Kept beside `dueOn` rather than folded into the state, so a duty reported
   * late still says so. The state answers "is anything owed"; these two dates
   * answer "was it in time", which is the question 3 kap. 10 § attaches a fine
   * to.
   */
  reportedOn: string | null;
}

export interface RegisterReportQueue {
  /** The association's calendar day the states were computed against. */
  generatedOn: string;
  counts: { overdue: number; due: number; reported: number };
  duties: RegisterReportDuty[];
}

/**
 * The shape a REGISTER_REPORT_MADE entry's context carries.
 *
 * Validated on the way out rather than trusted, because `context` is a JSON
 * column and this is the one place in the product that reads a fact back out of
 * one. An entry written by an older build, or by hand, has whatever it has; a
 * value that is not an ISO day is treated as no statement rather than rendered
 * onto a screen as a statutory date.
 */
function statedReportDay(context: Prisma.JsonValue | null): string | null {
  if (
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context)
  ) {
    return null;
  }
  const value = (context as Record<string, unknown>)["reportedOn"];
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

@Injectable()
export class RegisterReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Every duty in the ledger, deadline first. */
  async queue(now: Date = new Date()): Promise<RegisterReportQueue> {
    const obligations = await this.prisma.registerReportObligation.findMany({
      orderBy: [{ dueOn: "asc" }],
      select: {
        id: true,
        kind: true,
        apartmentId: true,
        transferId: true,
        terminationId: true,
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

    const reported = await this.reportedDays(
      obligations.map((obligation) => obligation.id),
    );

    /*
     * Ordered twice, and both are load-bearing. The database orders by dueOn so
     * the read walks the index the ledger carries for exactly this question;
     * the sort adds the tie-break, so two duties falling due on one day - a
     * transfer and a termination recorded in one board meeting - come back in
     * the same order on every read rather than in whichever order the scan
     * happened to produce.
     */
    const duties = obligations
      .slice()
      .sort(compareByDeadline)
      .map((obligation): RegisterReportDuty => {
        const reportedOn = reported.get(obligation.id) ?? null;
        return {
          id: obligation.id,
          kind: obligation.kind,
          apartmentId: obligation.apartmentId,
          designation: `${obligation.apartment.address.street} ${obligation.apartment.address.number} ${obligation.apartment.number}`,
          transferId: obligation.transferId,
          terminationId: obligation.terminationId,
          triggeredOn: isoDate(obligation.triggeredOn) ?? "",
          dueOn: isoDate(obligation.dueOn) ?? "",
          state: reportState({
            dueOn: obligation.dueOn,
            reportedOn: reportedOn === null ? null : new Date(reportedOn),
            now,
          }),
          daysUntilDue: daysUntilDue(obligation.dueOn, now),
          reportedOn,
        };
      });

    return {
      /*
       * The association's own calendar day, not the UTC one. Every state on this
       * queue was computed against that day, and slicing the instant would put a
       * stamp one day behind on the document for the two hours after midnight in
       * summer - a document about deadlines, dated a day before the deadlines it
       * states were measured.
       */
      generatedOn: formatLocalDay(localDayOf(now)),
      counts: {
        overdue: duties.filter((duty) => duty.state === "overdue").length,
        due: duties.filter((duty) => duty.state === "due").length,
        reported: duties.filter((duty) => duty.state === "reported").length,
      },
      duties,
    };
  }

  /**
   * A board member states that the anmalan for one duty reached Lantmateriet.
   *
   * The whole act is the audit entry. Nothing is written to the ledger - it
   * cannot be, and should not be - so this method's own guarantee is that the
   * entry says everything the fact consists of: the duty, the day stated, and
   * the two dates that make the lateness readable afterwards without a second
   * lookup, since a duty is one row on a table nothing can correct.
   *
   * Refused where a statement already stands, and where the day stated falls
   * before the window opened. The second is an input guard rather than a rule
   * out of the statute: a report dated before the day the register's own record
   * of the event begins is a mistyped date, and this is a statement that cannot
   * be taken back.
   */
  async recordReportMade(input: {
    actorPersonId: string;
    obligationId: string;
    reportedOn: string;
    now?: Date;
  }): Promise<RegisterReportDuty> {
    const now = input.now ?? new Date();

    const obligation = await this.prisma.registerReportObligation.findUnique({
      where: { id: input.obligationId },
      select: {
        id: true,
        kind: true,
        apartmentId: true,
        transferId: true,
        terminationId: true,
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
    if (obligation === null) {
      throw new RegisterReportError(
        "No such reporting obligation.",
        "obligation-not-found",
      );
    }

    const existing = await this.reportedDays([obligation.id]);
    if (existing.has(obligation.id)) {
      throw new RegisterReportError(
        "That obligation already carries a report date.",
        "report-already-recorded",
      );
    }

    const parsed = statutoryDate(input.reportedOn, now);
    if (!parsed.ok) {
      throw new RegisterReportError(
        parsed.problem === "date-not-a-calendar-date"
          ? "That is not a calendar date."
          : "That date has not arrived yet.",
        parsed.problem,
      );
    }
    const reportedOn = isoDate(parsed.column) ?? "";
    if (reportedOn < (isoDate(obligation.triggeredOn) ?? "")) {
      throw new RegisterReportError(
        "The report cannot be dated before the day the window opened.",
        "report-before-the-window-opened",
      );
    }

    await this.audit.record({
      action: "REGISTER_REPORT_MADE",
      actorPersonId: input.actorPersonId,
      targetKind: "registerReportObligation",
      targetId: obligation.id,
      context: {
        kind: obligation.kind,
        apartmentId: obligation.apartmentId,
        transferId: obligation.transferId,
        terminationId: obligation.terminationId,
        // The day stated, which is the whole content of the act, and the two
        // dates it is measured against. Carried here as well as on the ledger
        // row because this entry is the only record of the discharge, and
        // whether it was in time should be answerable from the entry itself.
        reportedOn,
        triggeredOn: isoDate(obligation.triggeredOn),
        dueOn: isoDate(obligation.dueOn),
      },
    });

    return {
      id: obligation.id,
      kind: obligation.kind,
      apartmentId: obligation.apartmentId,
      designation: `${obligation.apartment.address.street} ${obligation.apartment.address.number} ${obligation.apartment.number}`,
      transferId: obligation.transferId,
      terminationId: obligation.terminationId,
      triggeredOn: isoDate(obligation.triggeredOn) ?? "",
      dueOn: isoDate(obligation.dueOn) ?? "",
      state: "reported",
      daysUntilDue: daysUntilDue(obligation.dueOn, now),
      reportedOn,
    };
  }

  /**
   * The day stated for each of these duties, where one was stated.
   *
   * The earliest entry per duty wins, which is why the query is ordered and the
   * map is filled with the first value it sees rather than the last. An
   * append-only log records every statement that was made and corrects none of
   * them, so "when was this reported" is answered by the first person who said
   * so.
   */
  private async reportedDays(
    obligationIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (obligationIds.length === 0) {
      return new Map();
    }

    const entries = await this.prisma.auditLogEntry.findMany({
      where: {
        action: "REGISTER_REPORT_MADE",
        targetKind: "registerReportObligation",
        targetId: { in: [...obligationIds] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { targetId: true, context: true },
    });

    const days = new Map<string, string>();
    for (const entry of entries) {
      const day = statedReportDay(entry.context);
      if (entry.targetId === null || day === null || days.has(entry.targetId)) {
        continue;
      }
      days.set(entry.targetId, day);
    }
    return days;
  }
}

function isoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
