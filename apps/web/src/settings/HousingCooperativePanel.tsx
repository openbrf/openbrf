import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { HousingCooperativeSettings } from "../api/instance";
import { saveHousingCooperative } from "../api/instance";
import { FIELD, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface HousingCooperativePanelProps {
  /** Null before the housing cooperative has been named at all. */
  value: HousingCooperativeSettings | null;
  onSaved?: (value: HousingCooperativeSettings) => void;
  /** Label of the submit button, so the wizard can say "Continue". */
  submitLabel?: string;
  /** False for a board member, who may read the settings but not change them. */
  editable?: boolean;
}

/**
 * The housing cooperative's identity.
 *
 * The one step of the wizard that cannot be skipped: the name goes on the
 * board, into every email and onto the register extracts, and every other
 * setting hangs off the row this creates.
 */
export function HousingCooperativePanel({
  value,
  onSaved,
  submitLabel,
  editable = true,
}: HousingCooperativePanelProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(value?.name ?? "");
  const [organizationNumber, setOrganizationNumber] = useState(
    value?.organizationNumber ?? "",
  );
  const [defaultLocale, setDefaultLocale] = useState(
    value?.defaultLocale ?? "sv",
  );

  const { state, submit } = useSaveAction(saveHousingCooperative, onSaved);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit({
      name: name.trim(),
      // Empty means "not recorded" rather than an empty string in a field
      // printed on statutory documents.
      organizationNumber:
        organizationNumber.trim() === "" ? null : organizationNumber.trim(),
      defaultLocale,
    });
  };

  return (
    <Panel
      title={t("settings.housingCooperative.title")}
      description={t("settings.housingCooperative.description")}
      notice={
        state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                state.failure,
                { "invalid-body": "settings.errors.unknown" },
                "settings.errors.unknown",
              ),
            )}
          </Notice>
        ) : state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : editable ? null : (
          <Notice tone="info">{t("settings.readOnlyNotice")}</Notice>
        )
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.housingCooperative.name")}
          <input
            type="text"
            name="housingCooperativeName"
            required
            disabled={!editable}
            autoComplete="organization"
            placeholder={t("settings.housingCooperative.namePlaceholder")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          {t("settings.housingCooperative.organizationNumber")}
          <input
            type="text"
            name="organizationNumber"
            disabled={!editable}
            /* Text, not numeric: a Swedish organisation number is written
               NNNNNN-NNNN, and a digits-only mobile keypad has no hyphen key.
               The value is stored as typed and printed on statutory extracts,
               so the field has to be able to produce the documented form. */
            inputMode="text"
            value={organizationNumber}
            onChange={(event) => {
              setOrganizationNumber(event.target.value);
            }}
            /* An organisation number is register data, so it sits on the mono
               grid like every other identifier. */
            className={`${FIELD} font-data`}
          />
          <span className={HINT}>
            {t("settings.housingCooperative.organizationNumberHint")}
          </span>
        </label>

        <label className={LABEL}>
          {t("settings.housingCooperative.defaultLocale")}
          <select
            name="defaultLocale"
            disabled={!editable}
            value={defaultLocale}
            onChange={(event) => {
              setDefaultLocale(event.target.value);
            }}
            className={FIELD}
          >
            <option value="sv">
              {t("settings.housingCooperative.locale.sv")}
            </option>
            <option value="en">
              {t("settings.housingCooperative.locale.en")}
            </option>
          </select>
        </label>

        {editable ? (
          <div>
            <button
              type="submit"
              disabled={state.kind === "saving" || name.trim() === ""}
              className={PRIMARY_BUTTON}
            >
              {state.kind === "saving"
                ? t("settings.saving")
                : (submitLabel ?? t("settings.save"))}
            </button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
