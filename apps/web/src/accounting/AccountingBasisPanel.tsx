import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { localDayNow } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { formatAmount } from "../ui/money";
import { Notice } from "../ui/Notice";
import {
  type AccountingBasisExport,
  exportAccountingBasis,
} from "./accounting-api";
import { accountingFailureKey } from "./accounting-failures";

/**
 * The accounting basis (bokforingsunderlag): the period's fees and charges as
 * one file for whoever keeps the association's books.
 *
 * ## The same panel on both screens
 *
 * It stands on the fees screen and on the charges screen, because the file is
 * both halves of the period's money and a board member looking for it should
 * not have to know which half it was filed under. One component rather than
 * two, so the two screens cannot come to offer different things.
 *
 * ## Produced, and then taken
 *
 * The file is fetched on a POST and offered as bytes already in the page:
 * producing it writes the audit entry that records the disclosure, and a link a
 * browser could follow on its own would be an unaudited one. That is the
 * debiting list's and the register supply screen's own reasoning.
 *
 * ## What is shown afterwards
 *
 * The counts and the two halves' totals, and not the rows. Each screen already
 * prints its own half in full beneath this panel, and a third table of the same
 * figures would be a third place to keep in step. What the summary is for is
 * the check a board makes before handing the file on: how many rows, how much
 * in each half, and do the two add up to what they expected.
 */

/** The file as something a browser will save. */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

/**
 * The period a board opens the panel on: the calendar year in progress.
 *
 * The year on the association's own calendar rather than on the reader's
 * clock, so a board member abroad on New Year's Eve is offered the year the
 * building is in.
 */
function defaultPeriod(): { from: string; to: string } {
  const year = localDayNow().slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export function AccountingBasisPanel({
  onRefused,
}: {
  /** The screen owns the refusal banner, so every act reports through one place. */
  onRefused: (key: TranslationKey | null) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const initial = defaultPeriod();

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [producing, setProducing] = useState(false);
  const [produced, setProduced] = useState<AccountingBasisExport | null>(null);

  const onProduce = useCallback(async (): Promise<void> => {
    onRefused(null);
    setProducing(true);
    const result = await exportAccountingBasis({ from, to });
    setProducing(false);
    if (!result.ok) {
      setProduced(null);
      onRefused(accountingFailureKey(result.failure));
      return;
    }
    setProduced(result.value);
  }, [from, onRefused, to]);

  const counts =
    produced === null
      ? null
      : {
          fees: produced.basis.rows.filter((row) => row.kind === "FEE_NOTICE")
            .length,
          charges: produced.basis.rows.filter(
            (row) => row.kind === "MEMBER_CHARGE",
          ).length,
        };

  return (
    <section className={`flex flex-col gap-4 ${PANEL}`}>
      <h2 className="text-title">{t("accounting.basis.title")}</h2>
      <p className={HINT}>{t("accounting.basis.description")}</p>
      <Notice tone="info">{t("accounting.basis.notALedger")}</Notice>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onProduce();
        }}
      >
        <label className={LABEL}>
          {t("accounting.basis.from")}
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
          {t("accounting.basis.to")}
          <input
            type="date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>
        <button
          type="submit"
          className={SECONDARY_BUTTON}
          disabled={producing || from === "" || to === ""}
        >
          {t("accounting.basis.produce")}
        </button>
      </form>
      <p className={HINT}>{t("accounting.basis.runsAreWhole")}</p>

      {produced === null || counts === null ? null : (
        <div className="flex flex-col gap-3">
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <div className="flex flex-col">
              <dt className="text-small text-ink-muted">
                {t("accounting.basis.feeRows")}
              </dt>
              <dd className="text-body text-ink">
                {t("accounting.basis.rowsWithTotal", {
                  count: counts.fees,
                  amount: formatAmount(produced.basis.feeTotal, i18n.language),
                })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-small text-ink-muted">
                {t("accounting.basis.chargeRows")}
              </dt>
              <dd className="text-body text-ink">
                {t("accounting.basis.rowsWithTotal", {
                  count: counts.charges,
                  amount: formatAmount(
                    produced.basis.chargeTotal,
                    i18n.language,
                  ),
                })}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-small text-ink-muted">
                {t("accounting.basis.total")}
              </dt>
              <dd className="text-body text-ink">
                {t("accounting.basis.amountWithUnit", {
                  amount: formatAmount(produced.basis.total, i18n.language),
                })}
              </dd>
            </div>
          </dl>

          <a
            href={fileHref(produced.csv)}
            download={produced.fileName}
            className={SECONDARY_BUTTON}
          >
            {t("accounting.basis.download")}
          </a>
          <p className={HINT}>{t("accounting.basis.columnsAreDocumented")}</p>
          <p className={HINT}>{t("accounting.basis.feeVat")}</p>
        </div>
      )}
    </section>
  );
}
