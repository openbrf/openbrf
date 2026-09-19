import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { localDayNow } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  CELL,
  DATA_CELL,
  HEAD_CELL,
  ROW,
  TABLE,
  TABLE_SCROLL,
} from "../registers/document";
import {
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { formatAmount } from "../ui/money";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { feeFailureKey } from "./fee-failures";
import {
  type FeeNoticeExport,
  type FeeNotificationSummary,
  fetchFeeNotifications,
  issueFeeNotification,
  produceFeeNotices,
} from "./fees-api";

/**
 * Issuing a period's notices, and producing the document (avisering).
 *
 * ## Produced, not sent
 *
 * The board issues the run and takes the document away. Nothing here sends
 * anything, and there is no delivery state on a row: sending is its own act and
 * lands later, and a half-true "sent" column in the meantime would be exactly
 * the second answer this module refuses to hold.
 *
 * ## The due date is stated and nothing reads it
 *
 * BRL 7 kap. 18 § makes an arsavgift unpaid more than a week after the
 * forfallodag a ground for forverkande of the nyttjanderatt, and 7 kap. 23 §
 * then requires a served notice and a message to socialnamnden. A platform that
 * counted those days would be running a forfeiture procedure, so the date is a
 * field on a document and the panel says so.
 *
 * ## The file and the printed page state the same rows
 *
 * Both come from the one document the server produced, so the CSV a board hands
 * on and the page a browser writes a PDF from cannot disagree. Producing it is
 * a POST rather than a GET because it is an audited disclosure: named
 * apartments' amounts leaving the association is an act somebody chose to take.
 */

/** The file as something a browser will save. */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

/**
 * The first day of this month on the association's own calendar - the day a
 * period most often opens on.
 *
 * Read in the association's time zone and never off the UTC instant, which is
 * still last month for the first hour or two of the first of every month.
 */
function firstOfThisMonth(): string {
  return `${localDayNow().slice(0, 7)}-01`;
}

export function FeeNotificationsPanel({
  onRefused,
}: {
  /** The screen owns the refusal banner, so every act reports through one place. */
  onRefused: (key: TranslationKey | null) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();

  const [runs, setRuns] = useState<FeeNotificationSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [from, setFrom] = useState(firstOfThisMonth);
  const [to, setTo] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [produced, setProduced] = useState<FeeNoticeExport | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchFeeNotifications();
      if (cancelled) {
        return;
      }
      /*
       * A failed read is reported as one and never as an empty list. "No
       * notices have been produced yet" is a statement about the association's
       * books, and a board reading it after a dropped request would issue a
       * period that has already been issued - and only then meet the refusal.
       */
      setFailed(!result.ok);
      setRuns(result.ok ? result.value : null);
    })();

    return () => {
      cancelled = true;
    };
  }, [reload]);

  const onIssue = useCallback(async (): Promise<void> => {
    onRefused(null);
    setIssuing(true);
    const result = await issueFeeNotification({ from, to, dueOn });
    setIssuing(false);
    if (!result.ok) {
      onRefused(feeFailureKey(result.failure));
      return;
    }
    setReload((generation) => generation + 1);
  }, [dueOn, from, onRefused, to]);

  const onProduce = useCallback(
    async (notificationId: string): Promise<void> => {
      onRefused(null);
      const result = await produceFeeNotices(notificationId);
      if (!result.ok) {
        onRefused(feeFailureKey(result.failure));
        return;
      }
      setProduced(result.value);
    },
    [onRefused],
  );

  return (
    <section className={`flex flex-col gap-4 ${PANEL}`}>
      <h2 className="text-title">{t("fees.notification.title")}</h2>
      <p className={HINT}>{t("fees.notification.description")}</p>
      <Notice tone="info">{t("fees.notification.producedNotSent")}</Notice>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onIssue();
        }}
      >
        <label className={LABEL}>
          {t("fees.notification.from")}
          <input
            type="date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>
        <label className={LABEL}>
          {t("fees.notification.to")}
          <input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>
        <label className={LABEL}>
          {t("fees.notification.dueOn")}
          <input
            type="date"
            value={dueOn}
            onChange={(event) => {
              setDueOn(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>
        <button
          type="submit"
          className={SECONDARY_BUTTON}
          disabled={issuing || to === "" || dueOn === ""}
        >
          {t("fees.notification.issue")}
        </button>
      </form>
      <p className={HINT}>{t("fees.notification.wholeMonths")}</p>

      {failed ? (
        <LoadFailure
          messageKey="fees.notification.loadFailed"
          onRetry={() => {
            setReload((generation) => generation + 1);
          }}
        />
      ) : runs === null ? null : runs.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("fees.notification.none")}
        </p>
      ) : (
        <div className={TABLE_SCROLL}>
          <table className={TABLE}>
            <caption className="sr-only">
              {t("fees.notification.title")}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={HEAD_CELL}>
                  {t("fees.notification.column.period")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("fees.notification.column.dueOn")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("fees.notification.column.notices")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("fees.notification.column.total")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  <span className="sr-only">
                    {t("fees.notification.column.actions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.notificationId} className={ROW}>
                  <td className={DATA_CELL}>
                    {t("fees.notification.period", {
                      from: run.from,
                      to: run.to,
                    })}
                  </td>
                  <td className={DATA_CELL}>{run.dueOn}</td>
                  <td className={DATA_CELL}>{String(run.notices)}</td>
                  <td className={DATA_CELL}>
                    {t("fees.amountWithUnit", {
                      amount: formatAmount(run.total, i18n.language),
                    })}
                  </td>
                  <td className={CELL}>
                    <button
                      type="button"
                      onClick={() => {
                        void onProduce(run.notificationId);
                      }}
                      className={QUIET_BUTTON}
                      aria-label={t("fees.notification.produceNamed", {
                        from: run.from,
                        to: run.to,
                      })}
                    >
                      {t("fees.notification.produce")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {produced === null ? null : (
        <div className="flex flex-col gap-3">
          <a
            href={fileHref(produced.csv)}
            download={produced.fileName}
            className={SECONDARY_BUTTON}
          >
            {t("fees.notification.download")}
          </a>
          <p className={HINT}>{t("fees.notification.notAnInvoice")}</p>
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <caption className="sr-only">
                {t("fees.notification.documentTitle")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD_CELL}>
                    {t("fees.notice.column.apartment")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("fees.notice.column.holders")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("fees.notice.column.amount")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("fees.notice.column.paymentReference")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {produced.document.rows.map((row) => (
                  <tr key={row.noticeId} className={ROW}>
                    <td className={DATA_CELL}>{row.apartment}</td>
                    <td className={`${CELL} text-body text-ink`}>
                      {row.holders.state === "visible" ? (
                        row.holders.names.join(", ")
                      ) : (
                        <NotRecorded
                          meaning={t("fees.notice.withheldHolders")}
                        />
                      )}
                    </td>
                    <td className={DATA_CELL}>
                      {t("fees.amountWithUnit", {
                        amount: formatAmount(row.amount, i18n.language),
                      })}
                    </td>
                    <td className={DATA_CELL}>{row.paymentReference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={HINT}>
            {t("fees.notification.payTo", {
              bankgiro:
                produced.document.housingCooperative.bankgiro ??
                produced.document.housingCooperative.plusgiro ??
                t("fees.notification.noGiro"),
            })}
          </p>
        </div>
      )}
    </section>
  );
}
