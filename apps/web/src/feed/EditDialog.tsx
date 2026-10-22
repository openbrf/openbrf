import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

/**
 * Editing the text of one's own post or comment.
 *
 * Opened with the text as it stands, and saved as a whole: what the server
 * answers with is what the card shows afterwards, marked as edited. The dialog
 * says out loud what an edit does - the text it replaces is kept, and the
 * writer and the board can read it - because somebody correcting a slip should
 * not believe the slip is gone.
 *
 * Text only. The images on a post are what they were when it was written.
 */
export function EditDialog({
  title,
  label,
  body,
  maxLength,
  saving,
  failureKey,
  onSave,
  onClose,
}: {
  /** The dialog's heading: which post or comment is being edited. */
  title: string;
  /** The field's label. */
  label: string;
  /** The text as it stands. */
  body: string;
  /** The longest text the API stores here. */
  maxLength: number;
  saving: boolean;
  /** The refusal of the last attempt, shown inside the dialog it belongs to. */
  failureKey: TranslationKey | null;
  onSave: (body: string) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(body);
  const formId = "edit-text";
  const unchanged = draft.trim() === body.trim();

  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t("feed.edit.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className={PRIMARY_BUTTON}
            disabled={saving || unchanged || draft.trim() === ""}
          >
            {saving ? t("feed.edit.saving") : t("feed.edit.save")}
          </button>
        </>
      }
    >
      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}
      <form
        id={formId}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && !unchanged && draft.trim() !== "") {
            onSave(draft.trim());
          }
        }}
      >
        <label className={LABEL}>
          {label}
          <textarea
            className={`${FIELD_MULTILINE} min-h-32`}
            value={draft}
            maxLength={maxLength}
            required
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <p className={HINT}>{t("feed.edit.hint")}</p>
      </form>
    </Dialog>
  );
}
