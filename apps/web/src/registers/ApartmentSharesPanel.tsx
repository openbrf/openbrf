import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import {
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  type ApartmentRegisterRow,
  recordApartmentShares,
} from "./registers-api";
import {
  CELL,
  DATA_CELL,
  HEAD_CELL,
  ROW,
  TABLE,
  TABLE_SCROLL,
} from "./document";

export interface ApartmentSharesPanelProps {
  rows: readonly ApartmentRegisterRow[];
  /** The screen's own read, run again once the figures are stored. */
  onSaved: () => void;
}

/**
 * The apartments' participation shares and initial share capitals (andelstal
 * och insatser).
 *
 * Every apartment at once, because a board types eighty of them in one sitting
 * or none: the figures come off a stadgar annex or a spreadsheet the economic
 * manager sent, and a panel that took them one at a time would be eighty round
 * trips and eighty chances to stop halfway.
 *
 * ## Recorded and never applied
 *
 * The register holds both figures and nothing in this platform derives a fee
 * from either. The word andelstal occurs nowhere in bostadsrattslagen: BRL
 * 9 kap. 5 § forsta stycket 5 makes the basis for calculating the arsavgift a
 * matter for the stadgar, and 9 kap. 13 § makes fixing the avgifter the board's
 * own task. The fee screen offers the share as an aid the board accepts or
 * overwrites, and what is stored there is the amount the board stated.
 *
 * ## The insats stays in this register
 *
 * It is statutory tier and confidential to the apartment register, which is why
 * the panel is here rather than in the settings or on the fee screen, and why
 * it is behind the register's own capability.
 *
 * ## Closed until it is opened
 *
 * The panel is a button until somebody clicks it, like the property designation
 * and land tenure writes above it. A form of eighty pairs of fields standing
 * open on a document screen would be the first thing a board member met, and
 * the screen's job is the register rather than this one act.
 */
export function ApartmentSharesPanel({
  rows,
  onSaved,
}: ApartmentSharesPanelProps): ReactElement {
  const { t } = useTranslation();

  const [draft, setDraft] = useState<Record<
    string,
    { participationShare: string; initialShareCapital: string }
  > | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback((): void => {
    setFailed(false);
    setDraft(
      Object.fromEntries(
        rows.map((row) => [
          row.apartmentId,
          {
            participationShare: row.participationShare ?? "",
            initialShareCapital: row.initialShareCapital ?? "",
          },
        ]),
      ),
    );
  }, [rows]);

  const submit = useCallback(async (): Promise<void> => {
    if (draft === null) {
      return;
    }
    setFailed(false);
    setSaving(true);
    const result = await recordApartmentShares({
      apartments: rows.map((row) => {
        const entry = draft[row.apartmentId];
        return {
          apartmentId: row.apartmentId,
          // Cleared rather than stored empty: the register states a figure or
          // says none is recorded, and an empty string is neither.
          participationShare:
            (entry?.participationShare ?? "").trim() === ""
              ? null
              : (entry?.participationShare ?? "").trim(),
          initialShareCapital:
            (entry?.initialShareCapital ?? "").trim() === ""
              ? null
              : (entry?.initialShareCapital ?? "").trim(),
        };
      }),
    });
    setSaving(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setDraft(null);
    onSaved();
  }, [draft, onSaved, rows]);

  return (
    <section className={`flex flex-col gap-4 ${PANEL} print:hidden`}>
      <h2 className="text-title">{t("registers.apartment.shares.title")}</h2>
      <p className={HINT}>{t("registers.apartment.shares.description")}</p>
      <Notice tone="info">{t("registers.apartment.shares.notDerived")}</Notice>

      {failed ? (
        <Notice tone="danger" live>
          {t("registers.apartment.shares.failed")}
        </Notice>
      ) : null}

      {draft === null ? (
        <button type="button" onClick={open} className={SECONDARY_BUTTON}>
          {t("registers.apartment.shares.edit")}
        </button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <caption className="sr-only">
                {t("registers.apartment.shares.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.shares.column.apartment")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.participationShare")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.initialShareCapital")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.apartmentId} className={ROW}>
                    <td className={DATA_CELL}>{row.designation}</td>
                    <td className={CELL}>
                      <label className={LABEL}>
                        <span className="sr-only">
                          {t("registers.apartment.shares.shareFor", {
                            apartment: row.designation,
                          })}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={
                            draft[row.apartmentId]?.participationShare ?? ""
                          }
                          maxLength={32}
                          onChange={(event) => {
                            setDraft({
                              ...draft,
                              [row.apartmentId]: {
                                participationShare: event.target.value,
                                initialShareCapital:
                                  draft[row.apartmentId]?.initialShareCapital ??
                                  "",
                              },
                            });
                          }}
                          className={FIELD_DATA}
                        />
                      </label>
                    </td>
                    <td className={CELL}>
                      <label className={LABEL}>
                        <span className="sr-only">
                          {t("registers.apartment.shares.capitalFor", {
                            apartment: row.designation,
                          })}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={
                            draft[row.apartmentId]?.initialShareCapital ?? ""
                          }
                          maxLength={32}
                          onChange={(event) => {
                            setDraft({
                              ...draft,
                              [row.apartmentId]: {
                                participationShare:
                                  draft[row.apartmentId]?.participationShare ??
                                  "",
                                initialShareCapital: event.target.value,
                              },
                            });
                          }}
                          className={FIELD_DATA}
                        />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={SECONDARY_BUTTON}
              disabled={saving}
            >
              {t("registers.apartment.shares.submit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
              }}
              className={QUIET_BUTTON}
            >
              {t("registers.apartment.shares.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
