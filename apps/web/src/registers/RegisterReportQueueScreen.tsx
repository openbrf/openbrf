import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { ApiResult } from "../api/client";
import {
  FIELD_DATA,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  CELL,
  DATA_CELL,
  DOCUMENT,
  DOCUMENT_ATTRIBUTE,
  HEAD_CELL,
  ROW,
  STAMP,
  TABLE,
  TABLE_SCROLL,
} from "./document";
import {
  type RegisterReportDuty,
  type RegisterReportQueue,
  type RegisterReportState,
  fetchRegisterReportQueue,
  recordRegisterReportMade,
} from "./registers-api";

/**
 * What the association still owes the cooperative housing register.
 *
 * Its own screen and not a panel on the apartment register, because it is a
 * different document under a different act: the apartment register is the
 * association's own record under BRL 9 kap., and this is the queue of duties
 * Lag (2026:484) 3 kap. puts on it towards Lantmateriet.
 *
 * ## An overdue duty has to be unmistakable
 *
 * 3 kap. 10 § lets Lantmateriet order a late report in under penalty of a fine,
 * so a passed deadline is the only state on this screen that costs money. It is
 * marked four times over rather than once, because a single signal is a signal
 * somebody can miss: the duties are grouped under their own heading with a count,
 * that group leads the document, the state cell names the state in words, and a
 * notice above the document says how many there are. The colour is the fifth
 * signal and never the only one, which is the rule DESIGN.md states.
 *
 * ## The queue carries no personal data
 *
 * A duty names an apartment and two dates. Not the acquirer, not the former
 * holder, no address and no personal identity number - which is why this screen
 * sits behind the register's read capability alone, and why the initial supply,
 * which carries every holder's personal identity number, is a screen of its own
 * behind a capability of its own.
 */

/** The groups, in the order they lead the document. */
const GROUPS: readonly RegisterReportState[] = ["overdue", "due", "reported"];

/** What the board is stating about one duty. */
interface ReportDraft {
  obligationId: string;
  designation: string;
  reportedOn: string;
}

/**
 * Whole days between two ISO calendar dates, or null when either is absent.
 *
 * Both are `@db.Date` values the server rendered as `YYYY-MM-DD`, so they are
 * parsed as UTC and the difference is exact. Nothing here reads the browser's own
 * clock: the state and the day count both come from the server, and a second
 * clock would be a second opinion.
 */
function daysBetween(from: string, to: string | null): number | null {
  if (to === null || from === "") {
    return null;
  }
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / 86_400_000);
}

/** The state cell's colour. Never the only carrier of the state. */
function stateClass(state: RegisterReportState): string {
  if (state === "overdue") {
    return "text-danger";
  }
  return state === "due" ? "text-warn" : "text-ink-muted";
}

export function RegisterReportQueueScreen(): ReactElement {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<RegisterReportQueue | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordFailed, setRecordFailed] = useState(false);
  const [recorded, setRecorded] = useState(false);

  /**
   * How long a duty has left, or how long it is late, in words.
   *
   * A sentence per case rather than one with a signed number in it. "Due today"
   * is not "0 days left", and "3 days past the deadline" is not "-3 days left":
   * the board reads this to decide what to do this week, and a negative number
   * is one more thing to work out.
   */
  const timing = (duty: RegisterReportDuty): string => {
    if (duty.state === "reported") {
      const late = daysBetween(duty.dueOn, duty.reportedOn);
      return late !== null && late > 0
        ? t("registers.reports.reportedLate", { count: late })
        : t("registers.reports.state.reported");
    }
    if (duty.daysUntilDue < 0) {
      return t("registers.reports.daysOverdue", { count: -duty.daysUntilDue });
    }
    return duty.daysUntilDue === 0
      ? t("registers.reports.dueToday")
      : t("registers.reports.daysLeft", { count: duty.daysUntilDue });
  };

  const apply = useCallback((result: ApiResult<RegisterReportQueue>): void => {
    setFailed(!result.ok);
    if (result.ok) {
      setQueue(result.value);
    }
    setLoading(false);
  }, []);

  /*
   * The previous queue stays on screen while the next one loads, and a request
   * whose answer arrives after the screen has moved on writes nothing. Both are
   * the shape the register extracts use, and both matter more here: this screen
   * re-reads after every recorded report, and a blanked document would hide the
   * overdue group at the moment somebody is working through it.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchRegisterReportQueue();
      if (!cancelled) {
        apply(result);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apply]);

  const load = useCallback(async (): Promise<void> => {
    apply(await fetchRegisterReportQueue());
  }, [apply]);

  const submit = useCallback(async (): Promise<void> => {
    if (draft === null) {
      return;
    }
    setRecording(true);
    setRecordFailed(false);
    const result = await recordRegisterReportMade({
      obligationId: draft.obligationId,
      reportedOn: draft.reportedOn,
    });
    setRecording(false);
    if (!result.ok) {
      setRecordFailed(true);
      return;
    }
    setDraft(null);
    setRecorded(true);
    // Re-read rather than patching the row in place: the state, the counts and
    // the group a duty belongs to are all the server's answer, and a screen that
    // moved the row itself would be computing them a second time.
    await load();
  }, [draft, load]);

  const duties = queue?.duties ?? [];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-col gap-2">
          <h1 className="text-display">{t("registers.reports.heading")}</h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("registers.reports.description")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link to="/registers/reports/supply" className={SECONDARY_BUTTON}>
            {t("registers.reports.openSupply")}
          </Link>
          <button
            type="button"
            onClick={() => {
              window.print();
            }}
            className={SECONDARY_BUTTON}
          >
            {t("registers.common.print")}
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 print:hidden">
        <p className={HINT}>{t("registers.common.printHint")}</p>

        {queue === null ? null : queue.counts.overdue > 0 ? (
          <Notice tone="danger">
            {t("registers.reports.overdueNotice", {
              count: queue.counts.overdue,
            })}
          </Notice>
        ) : (
          <Notice tone="ok">{t("registers.reports.noneOverdue")}</Notice>
        )}

        {failed ? (
          <Notice tone="danger" live>
            {t("registers.reports.error")}
          </Notice>
        ) : null}

        {recorded ? (
          <Notice tone="ok" live>
            {t("registers.reports.record.done")}
          </Notice>
        ) : null}

        {draft === null ? null : (
          <form
            className="flex flex-col gap-3 rounded-control border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-title">
              {t("registers.reports.record.heading", {
                apartment: draft.designation,
              })}
            </p>
            <p className={HINT}>{t("registers.reports.record.hint")}</p>
            <Notice tone="warn">
              {t("registers.reports.record.appendOnly")}
            </Notice>

            <label className={LABEL}>
              {t("registers.reports.record.reportedOn")}
              <input
                type="date"
                required
                value={draft.reportedOn}
                onChange={(event) => {
                  setDraft({ ...draft, reportedOn: event.target.value });
                }}
                className={FIELD_DATA}
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={recording}
                className={SECONDARY_BUTTON}
              >
                {recording
                  ? t("registers.reports.record.submitting")
                  : t("registers.reports.record.submit")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setRecordFailed(false);
                }}
                className={QUIET_BUTTON}
              >
                {t("registers.reports.record.cancel")}
              </button>
            </div>

            {recordFailed ? (
              <Notice tone="danger" live>
                {t("registers.reports.record.failed")}
              </Notice>
            ) : null}
          </form>
        )}
      </div>

      {loading && queue === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("registers.reports.loading")}
        </p>
      ) : null}

      {queue === null ? null : (
        <section {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
          <header className="flex flex-col gap-1">
            <h2 className="text-headline">{t("registers.reports.heading")}</h2>
          </header>

          {duties.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-title">{t("registers.reports.empty.title")}</p>
              <p className="text-body text-ink-muted">
                {t("registers.reports.empty.description")}
              </p>
            </div>
          ) : (
            GROUPS.map((group) => {
              const rows = duties.filter((duty) => duty.state === group);
              if (rows.length === 0) {
                return null;
              }
              return (
                <section key={group} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <h3 className="text-title">
                      {t(`registers.reports.group.${group}`)}
                    </h3>
                    <p className={STAMP}>
                      {t("registers.reports.groupCount", {
                        count: rows.length,
                      })}
                    </p>
                  </div>

                  <div className={TABLE_SCROLL}>
                    <table className={TABLE}>
                      <caption className="sr-only">
                        {t(`registers.reports.group.${group}`)}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.apartment")}
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.event")}
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.triggeredOn")}
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.dueOn")}
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.state")}
                          </th>
                          <th scope="col" className={HEAD_CELL}>
                            {t("registers.reports.column.reportedOn")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((duty) => (
                          <tr key={duty.id} className={ROW}>
                            <td className={DATA_CELL}>{duty.designation}</td>
                            <td className={`${CELL} text-body text-ink`}>
                              {t(`registers.reports.event.${duty.kind}`)}
                            </td>
                            <td className={DATA_CELL}>{duty.triggeredOn}</td>
                            <td className={DATA_CELL}>{duty.dueOn}</td>
                            <td
                              className={`${CELL} text-small ${stateClass(duty.state)}`}
                            >
                              {/*
                               * The state in words and then the timing, so a
                               * reader who cannot distinguish the colours reads
                               * the same thing.
                               */}
                              <span className="flex flex-col gap-0.5">
                                <span>
                                  {t(`registers.reports.state.${duty.state}`)}
                                </span>
                                <span>{timing(duty)}</span>
                              </span>
                            </td>
                            <td className={DATA_CELL}>
                              {duty.reportedOn ?? ""}
                              {duty.state === "reported" ? null : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRecorded(false);
                                    setRecordFailed(false);
                                    setDraft({
                                      obligationId: duty.id,
                                      designation: duty.designation,
                                      // Empty rather than today: the day a
                                      // complete anmalan reached Lantmateriet is
                                      // a statement, and a prefilled one is a
                                      // statement the board did not make.
                                      reportedOn: "",
                                    });
                                  }}
                                  aria-label={t(
                                    "registers.reports.record.openLabel",
                                    { apartment: duty.designation },
                                  )}
                                  className={`${QUIET_BUTTON} print:hidden`}
                                >
                                  {t("registers.reports.record.open")}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })
          )}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className={STAMP}>
              {t("registers.reports.groupCount", { count: duties.length })}
            </p>
            <p className={STAMP}>
              {t("registers.reports.stamp", { date: queue.generatedOn })}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}
