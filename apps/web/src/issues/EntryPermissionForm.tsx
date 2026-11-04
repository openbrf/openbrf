import {
  findDoorCode,
  ISSUE_ENTRY_ANSWERS,
  ISSUE_FIT_LIMITS,
  type IssueEntryAnswer,
} from "@openbrf/shared";
import { useId, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import type { IssueEntry, IssueEntryInput } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD_DATA,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "door-code": "issues.entry.errors.doorCode",
  "entry-until-past": "issues.entry.errors.untilPast",
  "entry-needs-apartment": "issues.entry.errors.needsApartment",
  "issue-closed": "issues.entry.errors.closed",
  "issue-not-found": "issues.entry.errors.notFound",
  "personal-identity-number": "issues.entry.errors.personalIdentityNumber",
  "date-invalid": "issues.entry.errors.dateInvalid",
  "invalid-body": "issues.entry.errors.unknown",
};

/** The refusals that mean what is on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-closed",
  "issue-not-found",
]);

export interface EntryPermissionFormProps {
  /** What the issue holds now, or null while nobody has answered. */
  entry: IssueEntry | null;
  /** Whose answer it is: the resident's own, or a handler recording it. */
  audience: "reporter" | "handler";
  answer: (
    input: IssueEntryInput,
  ) => Promise<ApiResult<{ entry: IssueEntry | null }>>;
  withdraw: () => Promise<ApiResult<{ entry: IssueEntry | null }>>;
  /** Told after a save or a withdrawal, and after a refusal that says the issue is out of date. */
  onChanged: () => void;
  /**
   * Told the answer the issue now holds, as the save answered it, before
   * `onChanged`. A caller whose list is read again after `onChanged` applies it,
   * so a re-read that fails does not leave the answer from before the save on
   * screen.
   */
  onSaved?: (entry: IssueEntry | null) => void;
}

/** One act on the answer, so a save and a withdrawal share one in flight. */
type Act = { kind: "answer"; input: IssueEntryInput } | { kind: "withdraw" };

/**
 * The resident's permission to enter their apartment (decision 29): yes or no,
 * and for a yes whether there are pets, whether the master key may be used, a
 * note on how to get in and the last day it stands.
 *
 * A door code is never stored. The note is checked as it is typed, with the
 * same reading the server refuses by (`findDoorCode`), and the form says why
 * and keeps the save back, so the resident is told while they can still
 * reword it. The server checks again: a request can be made without this form.
 *
 * What is answered here is cleared when the issue closes, and the form says so.
 */
export function EntryPermissionForm({
  entry,
  audience,
  answer,
  withdraw,
  onChanged,
  onSaved,
}: EntryPermissionFormProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{
    answer: IssueEntryAnswer | "";
    pets: boolean;
    masterKey: boolean;
    note: string;
    until: string;
  }>({
    answer: entry?.answer ?? "",
    pets: entry?.pets ?? false,
    masterKey: entry?.masterKey ?? false,
    note: entry?.note ?? "",
    until: entry?.until ?? "",
  });
  const noteId = useId();
  const noteHintId = useId();

  const save = useSaveAction(
    (act: Act) => (act.kind === "answer" ? answer(act.input) : withdraw()),
    (saved) => {
      onSaved?.(saved.entry);
      onChanged();
    },
    (failure) => {
      if (STALE_REASONS.has(failure.reason)) {
        onChanged();
      }
    },
  );
  const busy = save.pending;
  const onDraftChanged = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  const yes = draft.answer === "YES";
  const note = draft.note.trim();
  const doorCode = yes && note !== "" && findDoorCode(note) !== null;
  const changed =
    draft.answer !== (entry?.answer ?? "") ||
    (yes &&
      (draft.pets !== (entry?.pets ?? false) ||
        draft.masterKey !== (entry?.masterKey ?? false) ||
        note !== (entry?.note ?? "") ||
        draft.until !== (entry?.until ?? "")));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.answer === "" || !changed || doorCode) {
          return;
        }
        void save.submit({
          kind: "answer",
          input:
            draft.answer === "NO"
              ? { answer: "NO" }
              : {
                  answer: "YES",
                  pets: draft.pets,
                  masterKey: draft.masterKey,
                  note: note === "" ? null : note,
                  until: draft.until === "" ? null : draft.until,
                },
        });
      }}
    >
      <p className={HINT}>
        {audience === "reporter"
          ? t("issues.entry.intro")
          : t("issues.entry.introHandler")}
      </p>

      {entry !== null && entry.expired && entry.until !== null ? (
        <Notice tone="warn">
          <Trans
            i18nKey="issues.entry.expired"
            values={{ date: entry.until }}
            components={DATA_TAGS}
          />
        </Notice>
      ) : null}

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              FAILURES,
              "issues.entry.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}

      <fieldset className="flex flex-col gap-1" disabled={busy}>
        <legend className="text-label text-ink-muted uppercase">
          {t("issues.entry.answerLabel")}
        </legend>
        {ISSUE_ENTRY_ANSWERS.map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="entryAnswer"
              value={value}
              checked={draft.answer === value}
              onChange={() => {
                setDraft({ ...draft, answer: value });
                onDraftChanged();
              }}
              className="size-4"
            />
            {t(
              value === "YES"
                ? "issues.entry.answerYes"
                : "issues.entry.answerNo",
            )}
          </label>
        ))}
      </fieldset>

      {yes ? (
        <>
          <label className="flex min-h-11 items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={draft.pets}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, pets: event.target.checked });
                onDraftChanged();
              }}
              className="size-4"
            />
            {t("issues.entry.petsLabel")}
          </label>
          <label className="flex min-h-11 items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={draft.masterKey}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, masterKey: event.target.checked });
                onDraftChanged();
              }}
              className="size-4"
            />
            {t("issues.entry.masterKeyLabel")}
          </label>

          <div className={LABEL}>
            <label htmlFor={noteId}>{t("issues.entry.noteLabel")}</label>
            <textarea
              id={noteId}
              rows={3}
              maxLength={ISSUE_FIT_LIMITS.entryNote}
              value={draft.note}
              disabled={busy}
              aria-describedby={noteHintId}
              aria-invalid={doorCode ? true : undefined}
              onChange={(event) => {
                setDraft({ ...draft, note: event.target.value });
                onDraftChanged();
              }}
              className={FIELD_MULTILINE}
            />
            <span id={noteHintId} className={HINT}>
              {t("issues.entry.noteHint")}
            </span>
          </div>
          {doorCode ? (
            <Notice tone="warn" live>
              {t("issues.entry.doorCodeWarning")}
            </Notice>
          ) : null}

          <label className={`${LABEL} max-w-60`}>
            {t("issues.entry.untilLabel")}
            <input
              type="date"
              value={draft.until}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, until: event.target.value });
                onDraftChanged();
              }}
              className={FIELD_DATA}
            />
          </label>
        </>
      ) : null}

      <p className={HINT}>{t("issues.entry.clearedAtClosing")}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || draft.answer === "" || !changed || doorCode}
          className={SECONDARY_BUTTON}
        >
          {busy ? t("issues.entry.saving") : t("issues.entry.save")}
        </button>
        {entry === null ? null : (
          <button
            type="button"
            disabled={busy}
            className={QUIET_BUTTON}
            onClick={() => {
              void save.submit({ kind: "withdraw" });
            }}
          >
            {t("issues.entry.withdraw")}
          </button>
        )}
      </div>
    </form>
  );
}
