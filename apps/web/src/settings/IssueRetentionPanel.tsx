import { ISSUE_TEXT_RETENTION_YEARS } from "@openbrf/shared";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchIssueRetention, saveIssueRetention } from "../api/issues";
import { FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/** One finished read, and which read it answers for. */
interface Loaded {
  readonly read: number;
  readonly years: number | null;
  readonly failed: boolean;
}

/**
 * How many years after an issue closes its free text is kept (ADR 0057,
 * decision 33): the board's clock, from one to ten years, two by default.
 *
 * The panel says what the number reaches and what it does not. The building
 * record - what, where, when and the outcome - stays with the issue; the
 * description, the location, the conversation, the notes and the files go,
 * unless a legal hold stands on the issue. And it says that the purge reads
 * the number when it runs, so a board shortening it learns before saving that
 * the next night removes everything already past the new clock.
 */
export function IssueRetentionPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reads, setReads] = useState(0);
  /** The board's entry, or null while it shows what was read. */
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchIssueRetention().then((result) => {
      if (!active) {
        return;
      }
      setLoaded((previous) => ({
        read: reads,
        years: result.ok ? result.value.years : (previous?.years ?? null),
        failed: !result.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const save = useSaveAction(saveIssueRetention, (saved) => {
    setLoaded((previous) => ({
      read: previous?.read ?? reads,
      years: saved.years,
      failed: false,
    }));
    setDraft(null);
  });

  const stored = loaded?.years ?? null;
  const readFailed = loaded !== null && loaded.read === reads && loaded.failed;
  const typed = draft ?? (stored === null ? "" : String(stored));
  // The whole entry or nothing, as the retention policy reads its number.
  const parsed = typed.trim() === "" ? Number.NaN : Number(typed);
  const outOfRange =
    !Number.isInteger(parsed) ||
    parsed < ISSUE_TEXT_RETENTION_YEARS.min ||
    parsed > ISSUE_TEXT_RETENTION_YEARS.max;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (outOfRange || save.pending) {
      return;
    }
    void save.submit({ years: parsed });
  };

  return (
    <Panel
      title={t("settings.issueRetention.title")}
      description={t("settings.issueRetention.description")}
      notice={
        <>
          <Notice tone="info">{t("settings.issueRetention.purgeJob")}</Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  { "invalid-body": "settings.issueRetention.errors.range" },
                  "settings.issueRetention.errors.unknown",
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
      {readFailed ? (
        <LoadFailure
          messageKey="settings.issueRetention.loadFailed"
          onRetry={() => {
            setReads((count) => count + 1);
          }}
        />
      ) : null}
      {stored === null ? (
        readFailed ? null : (
          <p role="status" className={HINT}>
            {t("settings.issueRetention.loading")}
          </p>
        )
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <label className={LABEL}>
            {t("settings.issueRetention.years")}
            <input
              type="number"
              name="issueRetentionYears"
              min={ISSUE_TEXT_RETENTION_YEARS.min}
              max={ISSUE_TEXT_RETENTION_YEARS.max}
              step={1}
              value={typed}
              onChange={(event) => {
                setDraft(event.target.value);
                // A refusal or a confirmation is about the number that was
                // sent; a new entry clears it.
                if (save.state.kind !== "idle" && !save.pending) {
                  save.reset();
                }
              }}
              className={FIELD_DATA}
            />
            <span className={HINT}>
              {t("settings.issueRetention.yearsHint")}
            </span>
          </label>

          {outOfRange ? (
            <Notice tone="warn" live>
              {t("settings.issueRetention.errors.range")}
            </Notice>
          ) : null}

          <div>
            <button
              type="submit"
              disabled={outOfRange || save.pending}
              className={PRIMARY_BUTTON}
            >
              {save.pending ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
