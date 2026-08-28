import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { saveRetention } from "../api/instance";
import { FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface RetentionPanelProps {
  daysAfterMoveOut: number;
  onSaved?: (value: { daysAfterMoveOut: number }) => void;
  editable?: boolean;
}

/** Mirrors the bounds the API enforces, so the form refuses the same values. */
const MIN_DAYS = 30;
const MAX_DAYS = 3650;

/**
 * How long service data is kept after a move-out.
 *
 * The statutory notice is not a disclaimer. The member register and the access
 * log are append-only in the database and exempt from purging, because the law
 * requires the member register to be retained (EFL 5 kap. via BRL 9 kap.). A
 * board reading this screen has to understand that this setting reaches service
 * data only, or they will assume they have a delete button they do not have -
 * and answer a resident's erasure request wrongly.
 */
export function RetentionPanel({
  daysAfterMoveOut,
  onSaved,
  editable = true,
}: RetentionPanelProps): ReactElement {
  const { t } = useTranslation();
  const [days, setDays] = useState(String(daysAfterMoveOut));

  const save = useSaveAction(saveRetention, onSaved);

  const parsed = Number.parseInt(days, 10);
  const outOfRange =
    Number.isNaN(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (outOfRange) {
      return;
    }
    void save.submit({ daysAfterMoveOut: parsed });
  };

  return (
    <Panel
      title={t("settings.retention.title")}
      description={t("settings.retention.description")}
      notice={
        /*
         * The statutory notice stands, and the outcome joins it. It used to be
         * the last branch of a chain, so a successful save replaced it - and
         * nothing here remounts the panel, so it stayed gone for the rest of the
         * session. A board answering an erasure request right after changing
         * this value is exactly who needs to read that the member register and
         * the audit log are out of its reach.
         */
        <>
          <Notice tone="info">{t("settings.retention.statutoryNotice")}</Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  { "invalid-body": "settings.retention.errors.range" },
                  "settings.errors.unknown",
                ),
              )}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("settings.saved")}
            </Notice>
          ) : null}
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.retention.days")}
          <input
            type="number"
            name="retentionDays"
            min={MIN_DAYS}
            max={MAX_DAYS}
            disabled={!editable}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>{t("settings.retention.daysHint")}</span>
        </label>

        {outOfRange ? (
          <Notice tone="warn" live>
            {t("settings.retention.errors.range")}
          </Notice>
        ) : null}

        {editable ? (
          <div>
            <button
              type="submit"
              disabled={outOfRange || save.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("settings.saving")
                : t("settings.save")}
            </button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
