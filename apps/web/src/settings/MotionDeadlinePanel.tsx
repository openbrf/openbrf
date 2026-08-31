import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { saveMotionDeadline } from "../api/motions";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface MotionDeadlinePanelProps {
  /** The clause as stored, or null when the bylaws set none. */
  motionDeadline: { month: number; day: number } | null;
  onSaved?: (value: {
    motionDeadline: { month: number; day: number } | null;
  }) => void;
  editable?: boolean;
}

const DEADLINE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "motion-deadline-not-a-date": "settings.motionDeadline.errors.notADate",
  "invalid-body": "settings.motionDeadline.errors.notADate",
};

/**
 * The deadline the bylaws set for motions to the general meeting.
 *
 * Transcribed and never decided here. EFL 6 kap. 15 §, applied to a housing
 * cooperative by BRL 9 kap. 14 §, gives a member the right to have an item taken
 * up if they ask the board in writing in time for the notice, and adds that the
 * request is to be made in the manner and within the time the bylaws determine
 * where the bylaws say anything about it. So what this panel records is what the
 * association's own stadgar already say - which is why the field is empty on a
 * fresh instance and why leaving it empty is a complete answer rather than an
 * unfinished setting.
 *
 * A month and a day rather than a date, because a bylaws clause is a standing
 * rule: "senast den 31 januari" holds every year, and a stored 2027-01-31 would
 * be silently wrong for every season after the first.
 *
 * The notice says what the deadline does and, just as importantly, what it does
 * not: intake stays open past it, because the deadline is the condition on the
 * right to have an item taken up at a *particular* meeting and not a condition on
 * the association's ability to receive one. A board that read the field as a
 * shutter would expect late motions to be turned away and be surprised by the
 * queue.
 */
export function MotionDeadlinePanel({
  motionDeadline,
  onSaved,
  editable = true,
}: MotionDeadlinePanelProps): ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(
    motionDeadline === null ? "" : String(motionDeadline.month),
  );
  const [day, setDay] = useState(
    motionDeadline === null ? "" : String(motionDeadline.day),
  );

  const save = useSaveAction(saveMotionDeadline, onSaved);

  const bothEmpty = month.trim() === "" && day.trim() === "";
  const parsedMonth = Number.parseInt(month, 10);
  const parsedDay = Number.parseInt(day, 10);
  /*
   * Both or neither, refused in the form as well as at the API.
   *
   * Half a deadline is not one: a month without a day is a rule nothing can
   * resolve to a date, and a screen would then have to show a member a deadline
   * it could not name.
   */
  const incomplete =
    !bothEmpty && (Number.isNaN(parsedMonth) || Number.isNaN(parsedDay));

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (incomplete) {
      return;
    }
    void save.submit({
      motionDeadline: bothEmpty ? null : { month: parsedMonth, day: parsedDay },
    });
  };

  return (
    <Panel
      title={t("settings.motionDeadline.title")}
      description={t("settings.motionDeadline.description")}
      notice={
        <>
          <Notice tone="info">
            {t("settings.motionDeadline.statutoryNotice")}
          </Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  DEADLINE_FAILURES,
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
          <>
            <button
              type="submit"
              form="motion-deadline"
              className={PRIMARY_BUTTON}
              disabled={save.state.kind === "saving" || incomplete}
            >
              {save.state.kind === "saving"
                ? t("settings.saving")
                : t("settings.save")}
            </button>
            <p className={HINT}>{t("settings.motionDeadline.clearHint")}</p>
          </>
        ) : undefined
      }
    >
      <form
        id="motion-deadline"
        className="flex flex-wrap gap-4"
        onSubmit={onSubmit}
      >
        <label className={LABEL}>
          {t("settings.motionDeadline.month")}
          <input
            className={`${FIELD_DATA} w-24`}
            type="number"
            min={1}
            max={12}
            value={month}
            disabled={!editable}
            onChange={(event) => {
              setMonth(event.target.value);
            }}
          />
        </label>

        <label className={LABEL}>
          {t("settings.motionDeadline.day")}
          <input
            className={`${FIELD_DATA} w-24`}
            type="number"
            min={1}
            max={31}
            value={day}
            disabled={!editable}
            onChange={(event) => {
              setDay(event.target.value);
            }}
          />
        </label>
      </form>
    </Panel>
  );
}
