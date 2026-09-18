import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type FinanceSettings, saveFinances } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface FinancesPanelProps {
  /** The three fields as stored. Never null: the month defaults to January. */
  finances: FinanceSettings;
  onSaved?: (value: FinanceSettings) => void;
  editable?: boolean;
}

const FINANCE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "financial-year-start-not-a-month":
    "settings.finances.errors.startMonthInvalid",
  "giro-not-a-number": "settings.finances.errors.giroInvalid",
  "invalid-body": "settings.finances.errors.giroInvalid",
};

/** The months, as the select offers them. */
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

const MONTH_LABEL: Readonly<Record<number, TranslationKey>> = {
  1: "settings.finances.month.1",
  2: "settings.finances.month.2",
  3: "settings.finances.month.3",
  4: "settings.finances.month.4",
  5: "settings.finances.month.5",
  6: "settings.finances.month.6",
  7: "settings.finances.month.7",
  8: "settings.finances.month.8",
  9: "settings.finances.month.9",
  10: "settings.finances.month.10",
  11: "settings.finances.month.11",
  12: "settings.finances.month.12",
};

/**
 * The association's financial year, and where it is paid.
 *
 * ## The month is not cosmetic
 *
 * It decides when every charge and every fee this instance holds becomes
 * erasable. Bokforingslagen (1999:1078) 7 kap. 2 § preserves
 * rakenskapsinformation through the seventh year after the calendar year the
 * financial year closed, so on a year running from the 1st of May a charge
 * dated in June is kept a full year longer than one dated in March. A data
 * subject access report states that date to a named person, which is why the
 * notice here says plainly what changing the month moves - and why the write is
 * audited.
 *
 * The default is January, the calendar year, which is what every instance
 * recorded before this setting existed had assumed and what most cooperatives
 * run. Changing it can only move an erasure date later and never earlier, so
 * nothing already promised is brought forward.
 *
 * ## A giro number is checked for shape and never for existence
 *
 * Whether a number is live is the bank's answer and this platform has no way to
 * ask it. The notice says so, because the cost of getting it wrong is four
 * hundred notices carrying a number nobody can pay to.
 */
export function FinancesPanel({
  finances,
  onSaved,
  editable = true,
}: FinancesPanelProps): ReactElement {
  const { t } = useTranslation();
  const [startMonth, setStartMonth] = useState(
    String(finances.financialYearStartMonth),
  );
  const [bankgiro, setBankgiro] = useState(finances.bankgiro ?? "");
  const [plusgiro, setPlusgiro] = useState(finances.plusgiro ?? "");

  const save = useSaveAction(saveFinances, onSaved);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.submit({
      financialYearStartMonth: Number(startMonth),
      // Cleared rather than stored empty: the notice states a giro number or
      // says none is recorded, and an empty string is neither.
      bankgiro: bankgiro.trim() === "" ? null : bankgiro.trim(),
      plusgiro: plusgiro.trim() === "" ? null : plusgiro.trim(),
    });
  };

  return (
    <Panel
      title={t("settings.finances.title")}
      description={t("settings.finances.description")}
      notice={
        <>
          <Notice tone="info">{t("settings.finances.retentionNotice")}</Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  FINANCE_FAILURES,
                  "settings.errors.unknown",
                ),
              )}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("settings.saved")}
            </Notice>
          ) : editable ? null : (
            <Notice tone="info">{t("settings.readOnlyNotice")}</Notice>
          )}
        </>
      }
      actions={
        editable ? (
          <button
            type="submit"
            form="finances"
            className={PRIMARY_BUTTON}
            disabled={save.state.kind === "saving"}
          >
            {save.state.kind === "saving"
              ? t("settings.saving")
              : t("settings.save")}
          </button>
        ) : undefined
      }
    >
      <form id="finances" className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.finances.startMonth")}
          <select
            value={startMonth}
            disabled={!editable}
            onChange={(event) => {
              setStartMonth(event.target.value);
            }}
            className={FIELD}
          >
            {MONTHS.map((month) => (
              <option key={month} value={String(month)}>
                {t(MONTH_LABEL[month] ?? "settings.finances.month.1")}
              </option>
            ))}
          </select>
        </label>
        <p className={HINT}>{t("settings.finances.startMonthHint")}</p>

        <label className={LABEL}>
          {t("settings.finances.bankgiro")}
          <input
            type="text"
            value={bankgiro}
            maxLength={20}
            disabled={!editable}
            onChange={(event) => {
              setBankgiro(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>

        <label className={LABEL}>
          {t("settings.finances.plusgiro")}
          <input
            type="text"
            value={plusgiro}
            maxLength={20}
            disabled={!editable}
            onChange={(event) => {
              setPlusgiro(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>
        <p className={HINT}>{t("settings.finances.giroHint")}</p>
      </form>
    </Panel>
  );
}
