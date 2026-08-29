import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChangeEvent, ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { AudienceField } from "./AudienceField";
import { audienceForBinder, isMinutesBinder } from "./document-shelf";
import {
  type ArchivedDocument,
  type DocumentAudience,
  fileDocument,
} from "./documents-api";

/**
 * The binders the interface suggests.
 *
 * Suggestions, not a list to choose from: a category is free text, because
 * associations name their own binders and an enum would have the product argue
 * with a board about what its own archive is called.
 */
const SUGGESTED_BINDERS: readonly TranslationKey[] = [
  "documents.categories.bylaws",
  "documents.categories.minutes",
  "documents.categories.houseRules",
  "documents.categories.annualReport",
];

/**
 * What the file picker offers.
 *
 * A courtesy, not a control: the API identifies a file from its own bytes and
 * refuses anything else, because an accept attribute is a hint to a dialog and
 * a request can be made without one.
 */
const ACCEPTED_TYPES = "application/pdf";

const FILING_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "unsupported-type": "documents.errors.unsupportedType",
  "too-large": "documents.errors.tooLarge",
  "empty-file": "documents.errors.empty",
  "no-file": "documents.errors.noFile",
  "invalid-body": "documents.errors.unknown",
};

export interface FileDocumentPanelProps {
  onFiled: (document: ArchivedDocument) => void;
}

/**
 * Filing a document: what it is called, which binder it goes in, who it is
 * for, and the file itself.
 *
 * The audience is the field that matters and it defaults to the members, not
 * to the public. Publishing is the deliberate act here, in both directions: a
 * board that means to put the bylaws on the website says so, and choosing the
 * minutes binder takes a document back off the public shelf and says why.
 */
export function FileDocumentPanel({
  onFiled,
}: FileDocumentPanelProps): ReactElement {
  const { t } = useTranslation();
  const fieldId = useId();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [audience, setAudience] = useState<DocumentAudience>("MEMBER");
  const [file, setFile] = useState<File | null>(null);
  /**
   * Whether the minutes rule has just moved the audience.
   *
   * Held apart from the audience itself so the sentence appears when the rule
   * acts and not merely whenever minutes are member-only, which is the
   * ordinary case and needs no explaining.
   */
  const [guarded, setGuarded] = useState(false);

  const run = useCallback(
    (chosen: File) => fileDocument({ title, category, audience }, chosen),
    [title, category, audience],
  );

  const save = useSaveAction(run, (document: ArchivedDocument) => {
    setTitle("");
    setCategory("");
    setAudience("MEMBER");
    setFile(null);
    setGuarded(false);
    onFiled(document);
  });

  const onBinderChange = (value: string): void => {
    setCategory(value);
    const narrowed = audienceForBinder(value, audience);
    setGuarded(narrowed !== audience);
    setAudience(narrowed);
  };

  const onAudienceChange = (value: DocumentAudience): void => {
    setAudience(value);
    // The board answering the guard is the deliberate act it asks for, so the
    // sentence goes once they have.
    setGuarded(false);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0] ?? null;
    // Cleared so choosing the same file twice still fires a change event,
    // which is what happens after a failed upload the board wants to retry.
    event.target.value = "";
    setFile(chosen);
    save.reset();
  };

  const complete =
    title.trim() !== "" && category.trim() !== "" && file !== null;

  return (
    <Panel
      title={t("documents.upload.heading")}
      description={t("documents.upload.description")}
      actions={
        <>
          <button
            type="button"
            disabled={!complete || save.state.kind === "saving"}
            onClick={() => {
              if (file !== null) {
                void save.submit(file);
              }
            }}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("documents.upload.working")
              : t("documents.upload.submit")}
          </button>

          {save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("documents.upload.saved")}
            </Notice>
          ) : null}

          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  FILING_FAILURES,
                  "documents.errors.unknown",
                ),
              )}
            </Notice>
          ) : null}
        </>
      }
    >
      <label className={LABEL}>
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
        <span className={HINT}>{t("documents.upload.titleHint")}</span>
      </label>

      <label className={LABEL}>
        {t("documents.upload.category")}
        <input
          type="text"
          value={category}
          maxLength={80}
          list={`${fieldId}-binders`}
          onChange={(event) => {
            onBinderChange(event.target.value);
          }}
          className={FIELD}
        />
        <span className={HINT}>{t("documents.upload.categoryHint")}</span>
      </label>
      {/*
       * A suggestion list rather than a select: the four ordinary binders are
       * one keystroke away and anything else is still typed straight in.
       */}
      <datalist id={`${fieldId}-binders`}>
        {SUGGESTED_BINDERS.map((key) => (
          <option key={key} value={t(key)} />
        ))}
      </datalist>

      <AudienceField
        name={`${fieldId}-audience`}
        value={audience}
        onChange={onAudienceChange}
      />

      {guarded || (isMinutesBinder(category) && audience !== "PUBLIC") ? (
        <Notice tone="warn" live={guarded}>
          {t("documents.upload.minutesGuard")}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className={`${SECONDARY_BUTTON} cursor-pointer`}>
          {t("documents.upload.choose")}
          <input
            type="file"
            accept={ACCEPTED_TYPES}
            disabled={save.state.kind === "saving"}
            aria-label={t("documents.upload.file")}
            className="sr-only"
            onChange={onPick}
          />
        </label>

        {file === null ? null : (
          <span className="min-w-0 truncate text-small text-ink">
            {t("documents.upload.chosen", { fileName: file.name })}
          </span>
        )}
      </div>
    </Panel>
  );
}
