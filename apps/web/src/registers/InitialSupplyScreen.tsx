import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
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
  type InitialSupply,
  type SupplyRecordType,
  produceInitialSupply,
} from "./registers-api";

/**
 * The initial supply to the cooperative housing register (Lag (2026:485) 3 §).
 *
 * Its own screen, and not a panel on the reporting queue, for the reason
 * `registers/document.ts` gives about the two register extracts: two documents
 * may share the measurements that make a table print correctly and must not
 * share a screen. Here the difference is not only editorial - the queue carries
 * no personal data at all and this document carries a personal identity number
 * for every current holder, so one screen showing both would put a print button
 * on top of two documents with different rules about who may hold them.
 *
 * ## Nothing is produced until somebody asks
 *
 * The screen loads with no document on it. Producing one decrypts every current
 * holder's personal identity number and writes an audit entry naming them, so it
 * is a button and never a page load: an audited disclosure has to be an act
 * somebody chose to take, and a screen that fetched on mount would make it a
 * consequence of following a link.
 *
 * A refusal is the ordinary answer rather than a fault. The supply sits behind a
 * capability of its own, so a board member who may read the register and not
 * supply it gets a 403, and the message says that rather than reporting a
 * failure.
 *
 * ## Not on the screenshot walk
 *
 * Deliberately, and it must stay off it. The end-to-end screenshot suite
 * photographs screens into images that go into public pull requests, and it
 * scans each one for anything shaped like a personal identity number first; a
 * document whose whole content is those numbers is the one screen that should
 * never be pointed at a camera, however good the scanner is.
 *
 * ## The document is the file
 *
 * What prints is the rows the file contains, column by column, rather than a
 * prettier rendering of them. A board member signing off on what goes to
 * Lantmateriet should be checking the file, and a summary would be a second
 * thing to get right whose correctness nobody would notice being wrong.
 */

/** The record types, in the order the file states them. */
const RECORD_TYPES: readonly SupplyRecordType[] = [
  "ASSOCIATION",
  "APARTMENT",
  "HOLDER",
  "LIEN",
];

/**
 * The file as something a browser will save.
 *
 * A data URL rather than the plain `<a href download>` the import template uses,
 * and the difference is what the two carry. That template is a GET that writes
 * nothing and holds no personal data, so a link to it is safe for a browser to
 * follow on its own. This file holds a personal identity number for every
 * current holder and producing it writes the audit entry, so it comes back on the
 * POST that was asked for and the link is made from bytes already in the page.
 * Nothing here fetches, and following the link discloses nothing that was not
 * already disclosed.
 */
function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

/**
 * Which refusal a board member is looking at.
 *
 * Three different things to do about it, so three messages rather than one. A
 * permission the seat does not hold is somebody else's to grant; a missing
 * association record or organisation number is theirs to fix, on a screen they
 * can reach; anything else is a failure to report rather than to act on.
 */
type SupplyRefusal =
  | "forbidden"
  | "association-not-set-up"
  | "association-organization-number-missing"
  | "unexpected";

function refusalOf(failure: {
  status: number;
  reason?: string;
}): SupplyRefusal {
  if (failure.status === 403) {
    return "forbidden";
  }
  return failure.reason === "association-not-set-up" ||
    failure.reason === "association-organization-number-missing"
    ? failure.reason
    : "unexpected";
}

export function InitialSupplyScreen(): ReactElement {
  const { t } = useTranslation();
  const [supply, setSupply] = useState<InitialSupply | null>(null);
  const [producing, setProducing] = useState(false);
  const [refused, setRefused] = useState<SupplyRefusal | null>(null);

  const produce = useCallback(async (): Promise<void> => {
    setProducing(true);
    setRefused(null);
    const result = await produceInitialSupply();
    setProducing(false);
    if (result.ok) {
      setSupply(result.value);
    } else {
      setRefused(refusalOf(result.failure));
    }
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-col gap-2">
          <h1 className="text-display">
            {t("registers.reports.supply.heading")}
          </h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("registers.reports.supply.description")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link to="/registers/reports" className={SECONDARY_BUTTON}>
            {t("registers.reports.backToQueue")}
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

        <Notice tone="info">
          {t("registers.reports.supply.ownShapeNotice")}
        </Notice>

        {supply === null ? (
          <Notice tone="warn">
            {t("registers.reports.supply.disclosureNotice")}
          </Notice>
        ) : (
          <Notice tone="warn" live>
            {t("registers.reports.supply.produced")}
          </Notice>
        )}

        {supply === null ? (
          <button
            type="button"
            onClick={() => {
              void produce();
            }}
            disabled={producing}
            className={SECONDARY_BUTTON}
          >
            {producing
              ? t("registers.reports.supply.producing")
              : t("registers.reports.supply.produce")}
          </button>
        ) : (
          <a
            href={fileHref(supply.csv)}
            download={supply.fileName}
            className={SECONDARY_BUTTON}
          >
            {t("registers.reports.supply.download")}
          </a>
        )}

        {refused === null ? null : (
          <Notice tone="danger" live>
            {t(`registers.reports.supply.refused.${refused}`)}
          </Notice>
        )}
      </div>

      {supply === null ? null : (
        <section {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
          <header className="flex flex-col gap-1">
            <h2 className="text-headline">
              {t("registers.reports.supply.heading")}
            </h2>
            <p className={STAMP}>
              {t("registers.reports.supply.counts", {
                apartments: supply.counts.APARTMENT,
                holders: supply.counts.HOLDER,
                liens: supply.counts.LIEN,
              })}
            </p>
          </header>

          <p className="text-small text-ink-muted">
            {t("registers.reports.supply.notHeld")}
          </p>

          {RECORD_TYPES.map((recordType) => {
            const rows = supply.rows.filter(
              (row) => row.recordType === recordType,
            );
            if (rows.length === 0) {
              return null;
            }
            /*
             * Only the columns this record type actually fills. The file keeps
             * every column on every row, because a delimited file is read by
             * position; a printed page of mostly empty cells would be unreadable,
             * and what a reader has to check is the values that are there.
             */
            const columns = supply.columns.filter(
              (column) =>
                column !== "recordType" &&
                rows.some((row) => (row[column] ?? "") !== ""),
            );

            return (
              <section
                key={recordType}
                className="flex break-inside-avoid flex-col gap-2"
              >
                <h3 className="text-title">
                  {t(`registers.reports.supply.recordType.${recordType}`)}
                </h3>

                <div className={TABLE_SCROLL}>
                  <table className={TABLE}>
                    <caption className="sr-only">
                      {t(`registers.reports.supply.recordType.${recordType}`)}
                    </caption>
                    <thead>
                      <tr>
                        {/*
                         * The column names verbatim, and untranslated on
                         * purpose. They are the contract - the header line of
                         * the file itself - and a printed page that named them
                         * differently from the file would be a page a board
                         * member could not check the file against.
                         */}
                        {columns.map((column) => (
                          <th key={column} scope="col" className={HEAD_CELL}>
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr
                          // The file has no identifier of its own for a row, and
                          // it should not: an identifier would be a field
                          // Lantmateriet did not ask for. The position in the
                          // file is what a row is, and it is stable for as long
                          // as this document is on the screen.
                          key={`${recordType}-${String(index)}`}
                          className={ROW}
                        >
                          {columns.map((column) => (
                            <td key={column} className={DATA_CELL}>
                              {row[column] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className={STAMP}>{supply.fileName}</p>
            <p className={STAMP}>
              {t("registers.reports.supply.stamp", {
                date: supply.generatedOn,
              })}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}
