import { useId, useState, type ReactElement } from "react";
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
 * Handing one post or one comment to the board.
 *
 * The note is optional: what was reported travels with the report, so somebody
 * who has nothing to add should not have to invent something. What the dialog
 * says out loud is what reporting does. Out of a group, the board reads this
 * one thing and the note, and nothing else about the group; in Alla, the board
 * reads everything already, and the report asks it to look.
 */
export function ReportDialog({
  subject,
  inGroup,
  author,
  sending,
  failureKey,
  onSend,
  onClose,
}: {
  subject: "post" | "comment";
  /** Whether it was said in a group rather than in Alla. */
  inGroup: boolean;
  /** Who wrote it, as one string, for the heading. */
  author: string;
  sending: boolean;
  /** The refusal of the last attempt, shown inside the dialog it belongs to. */
  failureKey: TranslationKey | null;
  onSend: (note: string) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const formId = useId();

  return (
    <Dialog
      title={
        subject === "post"
          ? t("feed.report.title", { author })
          : t("feed.report.commentTitle", { author })
      }
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
        <p className={HINT}>
          {inGroup ? t("feed.report.hintGroup") : t("feed.report.hintAll")}
        </p>
      </form>
    </Dialog>
  );
}
