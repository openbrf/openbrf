import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChangeEvent, ReactElement } from "react";

import type { ApiResult } from "../api/client";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import {
  type BinderAudience,
  BINDER_AUDIENCES,
  type BinderEntry,
  type BinderEntryFields,
  type BinderFiler,
  type BinderKind,
} from "./apartment-binder-api";
import {
  binderFailureKey,
  PART_SENTENCE,
  scannedBinderParts,
} from "./binder-failures";
import {
  AUDIENCE_HINT,
  AUDIENCE_LABEL,
  carriesItsDay,
  defaultAudienceFor,
  KIND_LABEL,
  kindsFiledBy,
} from "./binder-kinds";

/**
 * Filing one entry: what it is, what it is called, the day on it, who it is
 * for, and the file.
 *
 * One panel for both filers. What differs is the list of kinds - a permission
 * under BRL 7 kap. 7 § is the board's own decision and a tenant-owner is
 * offered no such option - and the sentence above the form, which says what
 * filing into somebody else's binder is. The server decides both again.
 *
 * What the form owes the person filing is two plain warnings and a refusal that
 * says which field was wrong. The file's own contents are never read: nothing
 * in the product opens a PDF, so a promise that a personal identity number
 * inside one would be caught is a promise the platform cannot keep, and the
 * form says so instead of implying otherwise by scanning the title alone in
 * silence.
 */

/**
 * What the file picker offers.
 *
 * A courtesy, not a control: the API identifies a file from its own bytes and
 * refuses anything else, because an accept attribute is a hint to a dialog and
 * a request can be made without one.
 */
const ACCEPTED_TYPES = "application/pdf";

export interface FileEntryPanelProps {
  apartmentId: string;
  /** In what capacity this panel files, which decides the kinds it offers. */
  filer: BinderFiler;
  /**
   * Files it. Held by the screen, because the two halves of it call two
   * different routes and the panel is not the place that knows which.
   */
  file: (
    apartmentId: string,
    fields: BinderEntryFields,
    chosen: File,
  ) => Promise<ApiResult<BinderEntry>>;
  onFiled: () => void;
}

export function FileEntryPanel({
  apartmentId,
  filer,
  file,
  onFiled,
}: FileEntryPanelProps): ReactElement {
  const { t } = useTranslation();
  const fieldId = useId();
  const kinds = kindsFiledBy(filer);
  const first = kinds[0] ?? "OTHER";

  const [kind, setKind] = useState<BinderKind>(first);
  const [title, setTitle] = useState("");
  const [datedOn, setDatedOn] = useState("");
  const [audience, setAudience] = useState<BinderAudience>(
    defaultAudienceFor(first),
  );
  const [chosen, setChosen] = useState<File | null>(null);

  const run = useCallback(
    (picked: File) =>
      file(apartmentId, { kind, audience, title, datedOn }, picked),
    [file, apartmentId, kind, audience, title, datedOn],
  );

  const save = useSaveAction(run, () => {
    setKind(first);
    setTitle("");
    setDatedOn("");
    setAudience(defaultAudienceFor(first));
    setChosen(null);
    onFiled();
  });

  /*
   * The kind decides who the entry is for until the filer says otherwise. A
   * permission is the tenant-owners' own and a drawing is the household's, and
   * a form that kept the audience from the previous kind would file the one
   * under the other's answer.
   */
  const onKindChange = (value: BinderKind): void => {
    setKind(value);
    setAudience(defaultAudienceFor(value));
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null;
    // Cleared so choosing the same file twice still fires a change event,
    // which is what happens after a refusal the person wants to retry.
    event.target.value = "";
    setChosen(picked);
    save.reset();
  };

  const dayRequired = carriesItsDay(kind);
  const complete =
    title.trim() !== "" &&
    chosen !== null &&
    (!dayRequired || datedOn.trim() !== "");

  const failure = save.state.kind === "failed" ? save.state.failure : null;
  const scanned = failure === null ? [] : scannedBinderParts(failure);

  return (
    <Panel
      title={t(
        filer === "BOARD"
          ? "apartmentBinder.file.headingBoard"
          : "apartmentBinder.file.heading",
      )}
      description={t(
        filer === "BOARD"
          ? "apartmentBinder.file.descriptionBoard"
          : "apartmentBinder.file.description",
      )}
      actions={
        <>
          <button
            type="button"
            disabled={!complete || save.state.kind === "saving"}
            onClick={() => {
              if (chosen !== null) {
                void save.submit(chosen);
              }
            }}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("apartmentBinder.file.working")
              : t("apartmentBinder.file.submit")}
          </button>

          {save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("apartmentBinder.file.saved")}
            </Notice>
          ) : null}

          {/*
           * The refusal stands with the control that caused it, inside this
           * panel: what was refused is this filing, and the two things the
           * person can do about it - retype the title, choose the file again -
           * are both in the fields above.
           */}
          {failure === null ? null : (
            <Notice tone="danger" live>
              {t(binderFailureKey(failure))}
              {scanned.map((part) => ` ${t(PART_SENTENCE[part])}`).join("")}
            </Notice>
          )}
        </>
      }
    >
      <label className={LABEL} htmlFor={`${fieldId}-kind`}>
        {t("apartmentBinder.file.kind")}
        <select
          id={`${fieldId}-kind`}
          value={kind}
          onChange={(event) => {
            onKindChange(event.target.value as BinderKind);
          }}
          className={FIELD}
        >
          {kinds.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(KIND_LABEL[candidate])}
            </option>
          ))}
        </select>
      </label>
      {/*
       * Every hint on this form sits under its field rather than inside its
       * label, as the subletting and key order forms already place theirs: a
       * label is set in the board's own lettering, which is uppercase, and a
       * sentence inherits it and stops reading as help.
       */}
      <p className={HINT}>{t("apartmentBinder.file.transferNote")}</p>

      <label className={LABEL}>
        {t("apartmentBinder.file.title")}
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
      <p className={HINT}>{t("apartmentBinder.file.titleHint")}</p>

      <label className={LABEL}>
        {t(
          dayRequired
            ? "apartmentBinder.file.datedOnRequired"
            : "apartmentBinder.file.datedOn",
        )}
        <input
          type="date"
          value={datedOn}
          onChange={(event) => {
            setDatedOn(event.target.value);
          }}
          className={`${FIELD_DATA} max-w-48`}
        />
      </label>
      <p className={HINT}>
        {t(
          dayRequired
            ? "apartmentBinder.file.datedOnHintRequired"
            : "apartmentBinder.file.datedOnHint",
        )}
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className={LABEL}>{t("apartmentBinder.file.audience")}</legend>
        {BINDER_AUDIENCES.map((candidate) => (
          <label
            key={candidate}
            className="flex min-h-11 items-start gap-2 text-small text-ink"
          >
            <input
              type="radio"
              name={`${fieldId}-audience`}
              value={candidate}
              checked={audience === candidate}
              onChange={() => {
                setAudience(candidate);
              }}
              className="mt-1 size-4 accent-trust"
            />
            <span className="flex flex-col gap-0.5">
              <span>{t(AUDIENCE_LABEL[candidate])}</span>
              <span className={HINT}>{t(AUDIENCE_HINT[candidate])}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer">
          <input
            type="file"
            accept={ACCEPTED_TYPES}
            disabled={save.state.kind === "saving"}
            aria-label={t("apartmentBinder.file.file")}
            className="peer sr-only"
            onChange={onPick}
          />
          {/*
           * The input is visually hidden, so the focus ring and the disabled
           * state both have to be drawn on the part the viewer can see.
           */}
          <span
            className={[
              SECONDARY_BUTTON,
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
              "peer-focus-visible:outline-trust",
              "peer-disabled:opacity-60",
            ].join(" ")}
          >
            {t("apartmentBinder.file.choose")}
          </span>
        </label>

        {chosen === null ? null : (
          <span className="min-w-0 truncate text-small text-ink">
            {t("apartmentBinder.file.chosen", { fileName: chosen.name })}
          </span>
        )}
      </div>

      <Notice tone="info">{t("apartmentBinder.file.notScanned")}</Notice>

      <p className={HINT}>
        {t(
          filer === "BOARD"
            ? "apartmentBinder.file.staysBoard"
            : "apartmentBinder.file.stays",
        )}
      </p>
    </Panel>
  );
}
