import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, PANEL, PRIMARY_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { AudienceField, AudienceSign } from "./AudienceField";
import { audienceForBinder, type FileSize } from "./document-shelf";
import {
  type ArchivedDocument,
  type DocumentAudience,
  editDocument,
  removeDocument,
} from "./documents-api";

/**
 * One document on the shelf: what it is, who it is for, and how to open it.
 *
 * The link points at the media route, which is where the file's own visibility
 * is enforced. Nothing on this row decides access; the audience beside the
 * title says what was decided.
 */

const CHANGE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-found": "documents.errors.notFound",
  "invalid-body": "documents.errors.unknown",
};

export interface DocumentRowProps {
  document: ArchivedDocument;
  size: FileSize;
  editable: boolean;
  /** Called when the row changed the archive, so the shelf is read again. */
  onChanged: () => void;
}

export function DocumentRow({
  document,
  size,
  editable,
  onChanged,
}: DocumentRowProps): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  return (
    <div className={`flex flex-col gap-3 ${PANEL}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <a
            href={document.url}
            /*
             * A new context, because a document is read beside the archive
             * rather than instead of it - and rel is not optional on a target:
             * without it the opened view can reach back through window.opener.
             */
            target="_blank"
            rel="noreferrer"
            aria-label={t("documents.openFile", { title: document.title })}
            className="text-body font-semibold text-ink underline decoration-line-strong underline-offset-4"
          >
            {document.title}
          </a>
          <span className="font-data text-small text-ink-muted">
            {t("documents.fileSummary", {
              fileName: document.fileName,
              size: t(`documents.size.${size.unit}`, { size: size.size }),
            })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AudienceSign audience={document.audience} />
          {editable ? (
            <button
              type="button"
              onClick={() => {
                setEditing((open) => !open);
              }}
              aria-expanded={editing}
              className={QUIET_BUTTON}
            >
              {editing ? t("documents.edit.cancel") : t("documents.edit.open")}
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <EditDocumentForm
          document={document}
          onChanged={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Changing a document: its title, its binder and its audience.
 *
 * The three travel together because the server takes them together: one
 * request states what the document now is, and the audience it states is
 * applied to the stored file in the same transaction. A form that sent only
 * the changed field would leave the API guessing at the rest.
 */
function EditDocumentForm({
  document,
  onChanged,
}: {
  document: ArchivedDocument;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const fieldId = useId();

  const [title, setTitle] = useState(document.title);
  const [category, setCategory] = useState(document.category);
  const [audience, setAudience] = useState<DocumentAudience>(document.audience);
  /**
   * Whether the minutes rule has just moved the audience.
   *
   * Held apart from the audience so the sentence appears when the rule acts.
   * Moving a document into the minutes binder is the moment it applies, and a
   * board that meant to leave it published has the answer one click away -
   * which is the only reason narrowing it here is honest rather than silent.
   */
  const [guarded, setGuarded] = useState(false);

  const run = useCallback(
    () => editDocument(document.id, { title, category, audience }),
    [document.id, title, category, audience],
  );
  const save = useSaveAction(run, onChanged);

  const drop = useCallback(() => removeDocument(document.id), [document.id]);
  const removal = useSaveAction(drop, onChanged);

  const busy = save.state.kind === "saving" || removal.state.kind === "saving";
  const failure =
    save.state.kind === "failed"
      ? save.state.failure
      : removal.state.kind === "failed"
        ? removal.state.failure
        : null;

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <h3 className="sr-only">
        {t("documents.edit.heading", { title: document.title })}
      </h3>

      <label className="flex flex-col gap-1.5 text-label text-ink-muted uppercase">
        {t("documents.upload.title")}
        <input
          type="text"
          value={title}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          className={FIELD}
        />
      </label>

      <label className="flex flex-col gap-1.5 text-label text-ink-muted uppercase">
        {t("documents.upload.category")}
        <input
          type="text"
          value={category}
          maxLength={80}
          onChange={(event) => {
            const value = event.target.value;
            setCategory(value);
            const narrowed = audienceForBinder(value, audience);
            setGuarded(narrowed !== audience);
            setAudience(narrowed);
          }}
          className={FIELD}
        />
      </label>

      <AudienceField
        name={`${fieldId}-audience`}
        value={audience}
        onChange={(chosen) => {
          setAudience(chosen);
          // The board answering the guard is the deliberate act it asks for.
          setGuarded(false);
        }}
      />

      {guarded ? (
        <Notice tone="warn" live>
          {t("documents.upload.minutesGuard")}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || title.trim() === "" || category.trim() === ""}
          onClick={() => {
            void save.submit();
          }}
          className={PRIMARY_BUTTON}
        >
          {save.state.kind === "saving"
            ? t("documents.edit.working")
            : t("documents.edit.submit")}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            // Confirmed because the bytes go with the row: nothing here puts a
            // removed document back.
            if (
              window.confirm(
                t("documents.edit.removeConfirm", { title: document.title }),
              )
            ) {
              void removal.submit();
            }
          }}
          className={QUIET_BUTTON}
        >
          {removal.state.kind === "saving"
            ? t("documents.edit.removing")
            : t("documents.edit.remove")}
        </button>
      </div>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              failure,
              CHANGE_FAILURES,
              "documents.errors.unknown",
            ),
          )}
        </Notice>
      )}
    </div>
  );
}
