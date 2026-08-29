import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { HINT, LABEL } from "../ui/controls";
import { type DocumentAudience, DOCUMENT_AUDIENCES } from "./documents-api";

/**
 * Who a document is for, as three named choices with what each one means.
 *
 * Radio buttons rather than a select, and every option carries its consequence
 * in a sentence beside it. This is the one field on the screen that decides
 * whether something reaches the street, and a board should not have to open a
 * dropdown and infer what "Published" does to a set of minutes.
 */

const LABEL_KEY: Readonly<Record<DocumentAudience, TranslationKey>> = {
  PUBLIC: "documents.audience.public",
  MEMBER: "documents.audience.member",
  BOARD: "documents.audience.board",
};

const HINT_KEY: Readonly<Record<DocumentAudience, TranslationKey>> = {
  PUBLIC: "documents.audienceHint.public",
  MEMBER: "documents.audienceHint.member",
  BOARD: "documents.audienceHint.board",
};

/** The chip that names a document's audience on the shelf. */
export function AudienceSign({
  audience,
}: {
  audience: DocumentAudience;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span className="inline-flex h-5.5 shrink-0 items-center rounded-control border border-line px-2 text-chip text-ink-muted uppercase">
      {t(LABEL_KEY[audience])}
    </span>
  );
}

export interface AudienceFieldProps {
  /** Distinct per form on the screen, so two of them stay separate groups. */
  name: string;
  value: DocumentAudience;
  onChange: (audience: DocumentAudience) => void;
}

export function AudienceField({
  name,
  value,
  onChange,
}: AudienceFieldProps): ReactElement {
  const { t } = useTranslation();

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={LABEL}>{t("documents.upload.audience")}</legend>

      {DOCUMENT_AUDIENCES.map((audience) => (
        <label
          key={audience}
          className="flex min-h-11 items-start gap-2 text-small text-ink"
        >
          <input
            type="radio"
            name={name}
            value={audience}
            checked={value === audience}
            onChange={() => {
              onChange(audience);
            }}
            className="mt-1 size-4 accent-trust"
          />
          <span className="flex flex-col gap-0.5">
            <span>{t(LABEL_KEY[audience])}</span>
            <span className={HINT}>{t(HINT_KEY[audience])}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
