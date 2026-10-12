import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import {
  CELL,
  DATA_CELL,
  DOCUMENT,
  DOCUMENT_ATTRIBUTE,
  HEAD_CELL,
  ROW,
  TABLE,
  TABLE_SCROLL,
} from "../registers/document";
import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { formatAmount } from "../ui/money";
import { NotRecorded } from "../ui/NotRecorded";
import type { FeeNoticeExport } from "./fees-api";

/**
 * A run's fee notices, as the document the board takes away.
 *
 * Its own section beside the fee register rather than inside the panel that
 * produced it. The panel is controls and does not print, and
 * `docs/fee-notice-contract.md` has the board take the notices away as the
 * printed page a browser writes a PDF from as well as the file. Both come from
 * the one answer the server gave, so they state the same rows.
 *
 * The bankgiro and the plusgiro are each printed under their own name, and both
 * where both are recorded: a number with no name on it is one a member may pay
 * as the wrong kind of giro.
 */

/** The file as something a browser will save. */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

export function FeeNoticeDocument({
  produced,
  onClose,
}: {
  produced: FeeNoticeExport;
  /** Takes the document off the screen, and so off the printed page. */
  onClose: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const { document } = produced;
  const { name, organizationNumber, bankgiro, plusgiro } =
    document.housingCooperative;

  return (
    <section {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
      <header className="flex flex-col gap-1">
        <h2 className="text-headline">{name}</h2>
        {organizationNumber === null ? null : (
          <p className="font-data text-data text-ink-muted">
            {`${t("registers.common.organizationNumber")} ${organizationNumber}`}
          </p>
        )}
        <p className="text-title">{t("fees.notification.documentTitle")}</p>
        <p className="font-data text-data text-ink">
          {t("fees.notification.documentPeriod", {
            from: document.from,
            to: document.to,
            issuedOn: document.issuedOn,
            dueOn: document.dueOn,
          })}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <a
          href={fileHref(produced.csv)}
          download={produced.fileName}
          className={SECONDARY_BUTTON}
        >
          {t("fees.notification.download")}
        </a>
        <button
          type="button"
          onClick={() => {
            window.print();
          }}
          className={SECONDARY_BUTTON}
        >
          {t("fees.notification.print")}
        </button>
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t("fees.notification.close")}
        </button>
      </div>

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
            {document.rows.map((row) => (
              <tr key={row.noticeId} className={ROW}>
                <td className={DATA_CELL}>{row.apartment}</td>
                <td className={`${CELL} text-body text-ink`}>
                  {row.holders.state === "visible" ? (
                    row.holders.names.join(", ")
                  ) : (
                    <NotRecorded meaning={t("fees.notice.withheldHolders")} />
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

      <div className="flex flex-col gap-1 font-data text-data text-ink">
        {bankgiro === null ? null : (
          <p>{t("fees.notification.payToBankgiro", { number: bankgiro })}</p>
        )}
        {plusgiro === null ? null : (
          <p>{t("fees.notification.payToPlusgiro", { number: plusgiro })}</p>
        )}
        {bankgiro === null && plusgiro === null ? (
          <p>{t("fees.notification.noGiro")}</p>
        ) : null}
      </div>
    </section>
  );
}
