import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * The longest note a report may carry.
 *
 * The same figure the API enforces. It is on the field so a reporter is
 * stopped by the box rather than by a refusal after they have written the
 * paragraph.
 */
const REPORT_NOTE_MAX_LENGTH = 500;

/**
 * Handing one post to the board.
 *
 * The note is optional: the post travels with the report, so somebody who has
 * nothing to add should not have to invent something. What the dialog says out
 * loud is what reporting does - the board reads this post and the note, and
 * nothing else about the group.
 */
export function ReportDialog({
  author,
  sending,
  failureKey,
  onSend,
  onClose,
}: {
  /** Who wrote the post, as one string, for the heading. */
  author: string;
  sending: boolean;
  /** The refusal of the last attempt, shown inside the dialog it belongs to. */
  failureKey: TranslationKey | null;
  onSend: (note: string) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const formId = "report-post";

  return (
    <Dialog
      title={t("feed.report.title", { author })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t("feed.report.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className={PRIMARY_BUTTON}
            disabled={sending}
          >
            {sending ? t("feed.report.sending") : t("feed.report.submit")}
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
          if (!sending) {
            onSend(note);
          }
        }}
      >
        <label className={LABEL}>
          {t("feed.report.note")}
          <textarea
            className={`${FIELD_MULTILINE} min-h-24`}
            value={note}
            maxLength={REPORT_NOTE_MAX_LENGTH}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </label>
        <p className={HINT}>{t("feed.report.hint")}</p>
      </form>
    </Dialog>
  );
}
