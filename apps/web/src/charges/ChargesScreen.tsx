import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

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
} from "../registers/document";
import {
  FIELD_DATA,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import type { TranslationKey } from "../i18n/translation-key";
import { chargeFailureKey } from "./charge-failures";
import { type ChargeParties, loadChargeParties } from "./charge-parties";
import {
  type ChargeRow,
  type DebitingList,
  exportDebitingList,
  fetchDebitingList,
  removeCharge,
} from "./charges-api";
import { RecordChargePanel } from "./RecordChargePanel";

/**
 * Charges to members (debiteringar mot medlem), and the debiting list.
 *
 * ## The list is a document
 *
 * It is printed and handed over, so it sits on a light surface with the print
 * measurements the register extracts use, and `window.print()` is the PDF: the
 * browser's own print dialogue writes one, and a generator in the application
 * would be a second renderer of the same rows to keep in step with this one.
 * Those measurements are imported from `registers/document.ts` rather than
 * copied, which is what that module's own comment provides for - sharing the
 * measurements that make a table print correctly is not sharing a screen, and
 * this document is neither of the two registers.
 *
 * The CSV is the other half of the same act and is produced by the server, so
 * the file and the page state the same rows. It is fetched on a POST and offered
 * as bytes already in the page: producing it writes the audit entry that records
 * the disclosure, and a link a browser could follow on its own would be an
 * unaudited one. That is the register supply screen's own reasoning.
 *
 * ## What is not here
 *
 * No payment, no balance, no reminder and no "send to the manager" control. Open
 * BRF holds the basis for a charge; the accounting system holds the debt and is
 * where a charge is settled and chased. `handedToManagerOn` is recorded because
 * it says when the basis left the association, and the screen says as much where
 * it is offered.
 */

/** The day, on the reader's own clock, for the period defaults. */
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The period a board opens the screen on: the calendar year in progress. */
function defaultPeriod(): { from: string; to: string } {
  const year = new Date().getFullYear();
  return { from: `${String(year)}-01-01`, to: `${String(year)}-12-31` };
}

/** The file as something a browser will save, per the module comment. */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

export function ChargesScreen(): ReactElement {
  const { t } = useTranslation();
  const initial = defaultPeriod();

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [list, setList] = useState<DebitingList | null>(null);
  const [parties, setParties] = useState<ChargeParties | null>(null);
  const [failed, setFailed] = useState(false);
  /*
   * The seat, decided by the server rather than guessed from the session. The
   * route is signed-in-only and this module is the board's, so a resident who
   * types the address reaches a screen that has to say so - and offer nothing.
   * A control the server would refuse is the one thing a screen in this product
   * may not show, which is why the period, the export and the form are all
   * behind this rather than only the list.
   */
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  /*
   * The refusal as a key rather than as a sentence, and translated where it is
   * rendered.
   *
   * Not a nicety: `t` is a new function on some renders, so an effect or a
   * callback that closed over it would have to name it as a dependency - and a
   * read effect that re-runs whenever `t` changes runs on every render, which is
   * a fetch loop that takes the tab down with it rather than a slow screen.
   * Nothing below this line calls `t` outside the render.
   */
  const [refusal, setRefusal] = useState<TranslationKey | null>(null);
  const [file, setFile] = useState<{ fileName: string; csv: string } | null>(
    null,
  );
  const [reload, setReload] = useState(0);

  /*
   * The parties are read once and the list on every period change, so changing
   * the period does not re-read the address book. Both are needed before the
   * screen can offer anything, which is why one failure state covers them.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const loaded = await loadChargeParties(controller.signal);
        if (!controller.signal.aborted) {
          setParties(loaded);
        }
      } catch {
        /*
         * Not reported on its own. A seat that may not read the charges may not
         * read the address book either, so this fails for the same reason and
         * the list's own answer is the one that says which reason it is.
         */
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [reload]);

  /*
   * Which read the list on the screen came from. The period cannot say it on
   * its own: recording or removing a charge reads the same period again, so an
   * export in flight across that would answer with rows the screen no longer
   * shows and satisfy a check that compared only the dates. The file is a
   * disclosure with an audit entry behind it, so handing back the wrong rows is
   * worse than handing back none.
   */
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    generation.current += 1;

    void (async () => {
      const result = await fetchDebitingList(from, to);
      if (cancelled) {
        return;
      }
      setLoading(false);
      if (result.ok) {
        setList(result.value);
        setFailed(false);
        setForbidden(false);
        return;
      }
      if (result.failure.status === 403) {
        /*
         * The list goes with the permission. A seat that held
         * `memberCharges:manage` and has it no longer must not go on reading
         * other members' charges off a document the last permitted read left
         * behind, and the file produced from that period is a copy of the same
         * rows.
         */
        setForbidden(true);
        setFailed(false);
        setList(null);
        setFile(null);
        return;
      }
      /*
       * A period the server refuses is not a failed read: the board stated
       * something it can correct on the controls above. Anything else is the
       * read failing, which is the state the retry is for.
       */
      if (result.failure.status === 422) {
        setRefusal(chargeFailureKey(result.failure));
        return;
      }
      setFailed(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [from, to, reload]);

  /*
   * The document the server answered for, and only while it is still the period
   * the controls name. The answer carries its own `from` and `to`, so this is
   * read off the data rather than cleared on every transition: a stale document
   * would sit under controls naming another period, and the remove button
   * beside a row acts on the charge that row is - so a board reading one period
   * could take a charge out of another. The file is a copy of the same rows and
   * goes with it.
   */
  const shown =
    list !== null && list.from === from && list.to === to ? list : null;
  const shownFile = shown === null ? null : file;

  const retry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    setReload((count) => count + 1);
  }, []);

  const refresh = useCallback(() => {
    // The file is from the period as it stood; a charge recorded or removed
    // since would make it a copy of something that is no longer true.
    setFile(null);
    setReload((count) => count + 1);
  }, []);

  const onExport = useCallback(async () => {
    const requestedAt = generation.current;
    const result = await exportDebitingList(from, to);
    // A read that started while this was in flight answers for rows this file
    // does not carry, so the file is dropped rather than offered against them.
    if (generation.current !== requestedAt) {
      return;
    }
    if (result.ok) {
      setFile({ fileName: result.value.fileName, csv: result.value.csv });
      setRefusal(null);
      return;
    }
    setRefusal(chargeFailureKey(result.failure));
  }, [from, to]);

  const onRemove = useCallback(
    async (chargeId: string) => {
      const result = await removeCharge(chargeId);
      if (result.ok) {
        refresh();
        return;
      }
      setRefusal(chargeFailureKey(result.failure));
    },
    [refresh],
  );

  const onRecorded = useCallback(
    (_row: ChargeRow) => {
      refresh();
    },
    [refresh],
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2 print:hidden">
        <h1 className="text-display">{t("charges.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("charges.description")}
        </p>
        <p className="max-w-2xl text-small text-ink-muted">
          {t("charges.notALedger")}
        </p>
      </header>

      {forbidden ? <Notice tone="info">{t("charges.forbidden")}</Notice> : null}

      {failed && !forbidden ? (
        <LoadFailure messageKey="charges.loadFailed" onRetry={retry} />
      ) : null}

      {parties === null || failed || forbidden ? null : (
        <RecordChargePanel
          parties={parties}
          today={today()}
          onRecorded={onRecorded}
        />
      )}

      {forbidden ? null : (
        <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
          <div className="flex flex-wrap items-end gap-3">
            <label className={LABEL}>
              {t("charges.period.from")}
              <input
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setFile(null);
                }}
                className={FIELD_DATA}
              />
            </label>
            <label className={LABEL}>
              {t("charges.period.to")}
              <input
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setFile(null);
                }}
                className={FIELD_DATA}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {shownFile === null ? (
              <button
                type="button"
                onClick={() => {
                  void onExport();
                }}
                className={SECONDARY_BUTTON}
              >
                {t("charges.export.produce")}
              </button>
            ) : (
              <a
                href={fileHref(shownFile.csv)}
                download={shownFile.fileName}
                className={SECONDARY_BUTTON}
              >
                {t("charges.export.download")}
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                window.print();
              }}
              className={SECONDARY_BUTTON}
            >
              {t("charges.print")}
            </button>
          </div>
        </div>
      )}

      {forbidden ? null : (
        <p className="text-small text-ink-muted print:hidden">
          {t("charges.printHint")}
        </p>
      )}

      {refusal === null ? null : (
        <Notice tone="danger" live>
          {t(refusal)}
        </Notice>
      )}

      {loading && shown === null && !forbidden ? (
        <p role="status" className="text-body text-ink-muted">
          {t("charges.loading")}
        </p>
      ) : null}

      {shown === null ? null : (
        <section {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
          <header className="flex flex-col gap-1">
            <h2 className="text-headline">{shown.housingCooperative.name}</h2>
            {shown.housingCooperative.organizationNumber === null ? null : (
              <p className="font-data text-data text-ink-muted">
                {`${t("registers.common.organizationNumber")} ${shown.housingCooperative.organizationNumber}`}
              </p>
            )}
            <p className="text-title">{t("charges.documentTitle")}</p>
          </header>

          {/*
            Said out loud on the document itself. Whoever keeps the books is
            reading a list of what was charged, and a reader who took it for a
            statement of what is owed would be reading it as the one thing it is
            not.
          */}
          <p className="text-small text-ink-muted">{t("charges.basisOnly")}</p>

          {shown.rows.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-title">{t("charges.empty.title")}</p>
              <p className="text-body text-ink-muted">
                {t("charges.empty.description")}
              </p>
            </div>
          ) : (
            <div className={TABLE_SCROLL}>
              <table className={TABLE}>
                <caption className="sr-only">
                  {t("charges.documentTitle")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.chargedOn")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.chargedTo")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.apartment")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.reason")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.vat")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.amount")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("charges.column.handedToManagerOn")}
                    </th>
                    <th scope="col" className={`${HEAD_CELL} print:hidden`}>
                      <span className="sr-only">
                        {t("charges.column.actions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((row) => (
                    <tr key={row.chargeId} className={ROW}>
                      <td className={DATA_CELL}>{row.chargedOn}</td>
                      <td className={`${CELL} text-body text-ink`}>
                        {row.chargedTo.kind === "person"
                          ? row.chargedTo.name
                          : t("charges.apartmentItself")}
                      </td>
                      <td className={DATA_CELL}>
                        {row.chargedTo.apartment.state === "masked" ? (
                          t("charges.maskedApartment")
                        ) : row.chargedTo.apartment.label === null ? (
                          <NotRecorded
                            meaning={t("charges.noValue.apartment")}
                          />
                        ) : (
                          row.chargedTo.apartment.label
                        )}
                      </td>
                      <td className={`${CELL} text-body text-ink`}>
                        {row.reason}
                      </td>
                      <td className={DATA_CELL}>
                        {row.vatTreatment === "EXEMPT"
                          ? t("charges.vat.EXEMPT")
                          : t("charges.vat.rateOf", {
                              percent: row.vatRatePercent ?? 0,
                            })}
                      </td>
                      <td className={DATA_CELL}>{row.amount}</td>
                      <td className={DATA_CELL}>
                        {row.handedToManagerOn ?? (
                          <NotRecorded
                            meaning={t("charges.noValue.handedToManagerOn")}
                          />
                        )}
                      </td>
                      <td className={`${CELL} print:hidden`}>
                        <button
                          type="button"
                          onClick={() => {
                            void onRemove(row.chargeId);
                          }}
                          className={QUIET_BUTTON}
                        >
                          {t("charges.remove")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className={STAMP}>
              {t("charges.stamp", {
                from: shown.from,
                to: shown.to,
                date: shown.generatedOn,
              })}
            </p>
            <p className="font-data text-data text-ink">
              {t("charges.total", { total: shown.total })}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
