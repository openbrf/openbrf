import { useId, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
} from "../ui/controls";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import type { ApiResult } from "../api/client";
import {
  MENU_GENERATED_KEYS,
  MENU_ITEM_KINDS,
  MENU_LABEL_LIMIT,
  type MenuGeneratedKey,
  type MenuItem,
  type MenuItemFields,
  type MenuItemKind,
  type MenuPage,
} from "./menu-api";

/**
 * The form that writes one menu entry, whether it is new or being corrected.
 *
 * One component for both because the fields are the same question either way,
 * and a second form for editing is how the two would quietly come to disagree
 * about what a menu entry may be.
 *
 * What the board picks first is what the entry points at, because that decides
 * everything else on the form: a page is chosen from the association's own, a
 * generated page from the ones the platform makes, and an address is typed.
 * The label follows, and for a page it may be left empty - the page's own
 * title is the sensible name for it, and asking twice for the same words is
 * how a menu ends up with two of them.
 */

/** The server's refusals, each as one sentence the board can act on. */
const REASONS: Readonly<Record<string, TranslationKey>> = {
  "not-found": "siteAdmin.menu.errors.notFound",
  "page-not-found": "siteAdmin.menu.errors.pageNotFound",
  "parent-not-found": "siteAdmin.menu.errors.parentNotFound",
  "unknown-generated-key": "siteAdmin.menu.errors.unknownGeneratedKey",
  "invalid-url": "siteAdmin.menu.errors.invalidUrl",
  "label-required": "siteAdmin.menu.errors.labelRequired",
  "label-too-long": "siteAdmin.menu.errors.labelTooLong",
  "target-required": "siteAdmin.menu.errors.targetRequired",
  "nesting-too-deep": "siteAdmin.menu.errors.nestingTooDeep",
};

const KIND_LABELS: Readonly<Record<MenuItemKind, TranslationKey>> = {
  PAGE: "siteAdmin.menu.kind.page",
  GENERATED: "siteAdmin.menu.kind.generated",
  EXTERNAL: "siteAdmin.menu.kind.external",
};

const GENERATED_LABELS: Readonly<Record<MenuGeneratedKey, TranslationKey>> = {
  news: "siteAdmin.menu.generated.news",
  calendar: "siteAdmin.menu.generated.calendar",
  broker: "siteAdmin.menu.generated.broker",
  requestAccount: "siteAdmin.menu.generated.requestAccount",
};

/** The translated name of a generated destination. */
export function generatedLabelKey(key: string): TranslationKey | null {
  return key in GENERATED_LABELS
    ? GENERATED_LABELS[key as MenuGeneratedKey]
    : null;
}

export interface MenuEntryFormProps {
  /** The entry being corrected, or nothing while one is being added. */
  entry?: MenuItem;
  pages: readonly MenuPage[];
  /** The entries an item may hang under: the top level, minus this one. */
  parents: readonly MenuItem[];
  save: (fields: MenuItemFields) => Promise<ApiResult<MenuItem>>;
  onSaved: () => void;
  onCancel?: (() => void) | undefined;
}

export function MenuEntryForm({
  entry,
  pages,
  parents,
  save,
  onSaved,
  onCancel,
}: MenuEntryFormProps): ReactElement {
  const { t } = useTranslation();
  const kindName = useId();
  const labelId = useId();
  const pageId = useId();
  const generatedId = useId();
  const urlId = useId();
  const parentId = useId();

  const [kind, setKind] = useState<MenuItemKind>(entry?.kind ?? "PAGE");
  const [label, setLabel] = useState(entry?.label ?? "");
  const [page, setPage] = useState(entry?.pageId ?? "");
  const [generated, setGenerated] = useState<string>(
    entry?.generatedKey ?? "news",
  );
  const [url, setUrl] = useState(entry?.url ?? "");
  const [parent, setParent] = useState(entry?.parentId ?? "");

  /*
   * The pages arrive after the first render, so the chosen page is settled
   * here rather than in the initial state: a select whose value defaulted at
   * mount would submit an empty choice for anyone who did not touch it.
   */
  const chosenPage = page === "" ? (pages[0]?.id ?? "") : page;

  const { state, submit } = useSaveAction(save, () => {
    onSaved();
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void submit({
      kind,
      label,
      parentId: parent === "" ? null : parent,
      ...(kind === "PAGE" ? { pageId: chosenPage } : {}),
      ...(kind === "GENERATED" ? { generatedKey: generated } : {}),
      ...(kind === "EXTERNAL" ? { url } : {}),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label text-ink-muted uppercase">
          {t("siteAdmin.menu.kind.legend")}
        </legend>
        {MENU_ITEM_KINDS.map((candidate) => (
          <label
            className="flex min-h-11 items-center gap-2 text-body text-ink"
            key={candidate}
          >
            <input
              checked={kind === candidate}
              className="size-4 accent-trust"
              name={kindName}
              onChange={() => {
                setKind(candidate);
              }}
              type="radio"
              value={candidate}
            />
            {t(KIND_LABELS[candidate])}
          </label>
        ))}
      </fieldset>

      {kind === "PAGE" ? (
        pages.length === 0 ? (
          <Notice tone="info">{t("siteAdmin.menu.noPages")}</Notice>
        ) : (
          <label className={LABEL} htmlFor={pageId}>
            {t("siteAdmin.menu.fields.page")}
            <select
              className={FIELD}
              id={pageId}
              onChange={(event) => {
                setPage(event.target.value);
              }}
              value={chosenPage}
            >
              {pages.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </select>
          </label>
        )
      ) : null}

      {kind === "GENERATED" ? (
        <label className={LABEL} htmlFor={generatedId}>
          {t("siteAdmin.menu.generated.field")}
          <select
            className={FIELD}
            id={generatedId}
            onChange={(event) => {
              setGenerated(event.target.value);
            }}
            value={generated}
          >
            {MENU_GENERATED_KEYS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(GENERATED_LABELS[candidate])}
              </option>
            ))}
          </select>
          <span className={HINT}>
            {t("siteAdmin.menu.generated.unavailable")}
          </span>
        </label>
      ) : null}

      {kind === "EXTERNAL" ? (
        <label className={LABEL} htmlFor={urlId}>
          {t("siteAdmin.menu.fields.url")}
          <input
            className={FIELD}
            id={urlId}
            inputMode="url"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            type="text"
            value={url}
          />
          <span className={HINT}>{t("siteAdmin.menu.fields.urlHint")}</span>
        </label>
      ) : null}

      <label className={LABEL} htmlFor={labelId}>
        {t("siteAdmin.menu.fields.label")}
        <input
          className={FIELD}
          id={labelId}
          maxLength={MENU_LABEL_LIMIT}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          type="text"
          value={label}
        />
        <span className={HINT}>{t("siteAdmin.menu.fields.labelHint")}</span>
      </label>

      <label className={LABEL} htmlFor={parentId}>
        {t("siteAdmin.menu.fields.parent")}
        <select
          className={FIELD}
          id={parentId}
          onChange={(event) => {
            setParent(event.target.value);
          }}
          value={parent}
        >
          <option value="">{t("siteAdmin.menu.topLevel")}</option>
          {parents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>

      {state.kind === "failed" ? (
        <Notice live tone="danger">
          {t(
            failureMessageKey(
              state.failure,
              REASONS,
              "siteAdmin.menu.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {/*
         * An instance with no pages yet cannot have a page entry, and the
         * notice above says so. Refused rather than sent: the form would
         * otherwise submit an entry naming no page and answer the board with
         * the server's refusal to something they were never offered a way to
         * get right. The other two kinds stay selectable, so the way out is
         * the one the form already shows.
         */}
        <button
          className={PRIMARY_BUTTON}
          disabled={
            state.kind === "saving" || (kind === "PAGE" && pages.length === 0)
          }
          type="submit"
        >
          {state.kind === "saving"
            ? t(
                entry === undefined
                  ? "siteAdmin.menu.add.working"
                  : "siteAdmin.menu.edit.working",
              )
            : t(
                entry === undefined
                  ? "siteAdmin.menu.add.submit"
                  : "siteAdmin.menu.edit.submit",
              )}
        </button>
        {onCancel === undefined ? null : (
          <button className={QUIET_BUTTON} onClick={onCancel} type="button">
            {t("siteAdmin.menu.edit.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}
