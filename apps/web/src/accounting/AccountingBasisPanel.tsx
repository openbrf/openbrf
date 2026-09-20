import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { localDayNow } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { STAMP } from "../registers/document";
import { useViewerCapabilities } from "../shell/use-viewer-capabilities";
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
 * The accounting basis (bokforingsunderlag): the period's fee notices and
 * member charges as one file for whoever keeps the association's books.
 *
 * ## The same panel on both screens
 *
 * It stands on the fees screen and on the charges screen, because the file is
 * both halves of the period's money and a board member looking for it should
 * not have to know which half it was filed under. One component rather than
 * two, so the two screens cannot come to offer different things.
 *
 * ## Offered only to a seat that may take it
 *
 * The file is both halves of the money, so the endpoint requires `fees:manage`
 * and `memberCharges:manage` together. The two screens this panel stands on
 * each check one of those and no more, so without the check below a board
 * member holding one of them would be offered an export the server then
 * refuses. The panel therefore asks what this account may do and renders
 * nothing until both answers are in.
 *
 * It is courtesy and not authorization, for the reason
 * `useViewerCapabilities` gives: the guard refuses the request whatever this
 * decides. What it prevents is a control that cannot work.
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
 *
 * That summary describes the period it was taken for and not the period on the
 * form, so either date moving withdraws it along with the download. A board
 * that edited a date and read the totals still standing beneath would be
 * checking one period against another's figures, and the file it then handed on
 * would be the one it had already stopped looking at. The debiting list drops
 * its own file on the same event and for the same reason.
 */

/** The file as something a browser will save. */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

/**
 * What the endpoint requires, mirrored from its own `@RequireCapability`.
 *
 * Both, combined with AND: a seat holding one of them may take that half's own
 * document and not this file.
 */
const REQUIRED_CAPABILITIES = ["fees:manage", "memberCharges:manage"] as const;

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
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  const capabilities = useViewerCapabilities();
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

  /*
   * After the hooks and never before them: a component that returned early
   * above would call a different number of hooks on the render that answers,
   * which React refuses. The list is empty until the viewer endpoint answers
   * and on any failure, so the panel appears when the answer does rather than
   * appearing and then being withdrawn.
   */
  if (
    !REQUIRED_CAPABILITIES.every((capability) =>
      capabilities.includes(capability),
    )
  ) {
    return null;
  }

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
              setProduced(null);
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
              setProduced(null);
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
              <dd className="font-data text-data text-ink">
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
              <dd className="font-data text-data text-ink">
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
              <dd className="font-data text-data text-ink">
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
          <p className={STAMP}>
            {t("accounting.basis.stamp", {
              from: produced.basis.from,
              to: produced.basis.to,
              date: produced.basis.generatedOn,
            })}
          </p>
          <p className={HINT}>{t("accounting.basis.columnsAreDocumented")}</p>
          <p className={HINT}>{t("accounting.basis.feeVat")}</p>
        </div>
      )}
    </section>
  );
}
