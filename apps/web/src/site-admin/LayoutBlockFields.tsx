import {
  BUILT_IN_PAGES,
  type BuiltInPage,
  BUTTON_STYLES,
  IMAGE_SIDES,
  PAGE_CONTENT_LIMITS,
} from "@openbrf/shared";
import { useId } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type {
  BannerBlock,
  ButtonBlock,
  ButtonStyle,
  ColumnsBlock,
  HeadingBlock,
  ImageSide,
  ImageTextBlock,
  LinkTarget,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import {
  addParagraph,
  type EditorBlock,
  removeParagraph,
  withBlock,
  withColumnCount,
} from "./page-blocks";

/**
 * The settings of a block, in the panel beside the page.
 *
 * What a block says is written on the page itself, where it is shown; what is
 * here is everything about a block that is not words on the page: which
 * picture, what it shows, where a button leads, how a heading ranks, how many
 * columns. Plain fields, so each of them is filled in with a keyboard and a
 * screen reader like any other form. What they write is the stored block and
 * nothing else; the website decides what it becomes.
 */

/** A page a button may lead to, as the editor names it. */
export interface LinkablePage {
  id: string;
  title: string;
}

/**
 * What the page editor lends the fields: its pages and its pictures.
 *
 * Handed down rather than kept here, because each of these is the page's and
 * not a block's: one upload at a time, and one declaration per picture by its
 * identity.
 */
export interface BlockFieldsContext {
  pages: readonly LinkablePage[];
  busy: boolean;
  /** The pictures declared to show identifiable persons, by identity. */
  declared: ReadonlySet<string>;
  declare: (id: string, shows: boolean) => void;
  /** Uploads a picture for the block or the block in a column with this identity. */
  upload: (id: string, file: File) => void;
}

const TARGET_KINDS = ["page", "builtIn", "url"] as const;

type TargetKind = (typeof TARGET_KINDS)[number];

const TARGET_KIND_LABELS = {
  page: "siteAdmin.editor.buttonTargetPage",
  builtIn: "siteAdmin.editor.buttonTargetBuiltIn",
  url: "siteAdmin.editor.buttonTargetUrl",
} as const satisfies Record<TargetKind, TranslationKey>;

/** The names the built-in pages are given when they are written. */
const BUILT_IN_LABELS = {
  news: "site.builtInPages.news",
  calendar: "site.builtInPages.calendar",
  broker: "site.builtInPages.brokerInformation",
} as const satisfies Record<BuiltInPage, TranslationKey>;

const STYLE_LABELS = {
  primary: "siteAdmin.editor.buttonStylePrimary",
  secondary: "siteAdmin.editor.buttonStyleSecondary",
} as const satisfies Record<ButtonStyle, TranslationKey>;

const SIDE_LABELS = {
  left: "siteAdmin.editor.imageSideLeft",
  right: "siteAdmin.editor.imageSideRight",
} as const satisfies Record<ImageSide, TranslationKey>;

/**
 * A destination of a new kind, started empty.
 *
 * The built-in kind starts on the news, because there is nothing to type for
 * it; the other two start on nothing chosen, which the write path refuses and
 * names if the board saves without choosing.
 */
function emptyTarget(kind: TargetKind): LinkTarget {
  switch (kind) {
    case "page":
      return { kind: "page", pageId: "" };
    case "builtIn":
      return { kind: "builtIn", page: "news" };
    case "url":
      return { kind: "url", url: "" };
  }
}

/** Where a button leads: what a button and a banner's button share. */
function ButtonTargetFields({
  target,
  onChange,
  pages,
}: {
  target: LinkTarget;
  onChange: (target: LinkTarget) => void;
  pages: readonly LinkablePage[];
}): ReactElement {
  const { t } = useTranslation();
  const kindName = useId();

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-label text-ink-muted uppercase">
          {t("siteAdmin.editor.buttonTarget")}
        </legend>
        {TARGET_KINDS.map((kind) => (
          <label
            className="flex min-h-11 items-center gap-2 text-body text-ink"
            key={kind}
          >
            <input
              type="radio"
              className="size-4 accent-trust"
              name={kindName}
              value={kind}
              checked={target.kind === kind}
              onChange={() => {
                onChange(emptyTarget(kind));
              }}
            />
            {t(TARGET_KIND_LABELS[kind])}
          </label>
        ))}
      </fieldset>
      {target.kind === "page" ? (
        <label className={LABEL}>
          {t("siteAdmin.editor.buttonPage")}
          <select
            className={FIELD}
            value={target.pageId}
            onChange={(event) => {
              onChange({ kind: "page", pageId: event.target.value });
            }}
          >
            <option value="">{t("siteAdmin.editor.buttonPageChoose")}</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {target.kind === "builtIn" ? (
        <label className={LABEL}>
          {t("siteAdmin.editor.buttonBuiltIn")}
          <select
            className={FIELD}
            value={target.page}
            onChange={(event) => {
              const page = BUILT_IN_PAGES.find(
                (candidate) => candidate === event.target.value,
              );
              if (page !== undefined) {
                onChange({ kind: "builtIn", page });
              }
            }}
          >
            {BUILT_IN_PAGES.map((page) => (
              <option key={page} value={page}>
                {t(BUILT_IN_LABELS[page])}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {target.kind === "url" ? (
        <label className={LABEL}>
          {t("siteAdmin.editor.buttonUrl")}
          <input
            className={FIELD}
            type="url"
            inputMode="url"
            maxLength={PAGE_CONTENT_LIMITS.link}
            value={target.url}
            onChange={(event) => {
              onChange({ kind: "url", url: event.target.value });
            }}
          />
          <span className={HINT}>{t("siteAdmin.editor.buttonUrlHint")}</span>
        </label>
      ) : null}
    </div>
  );
}

/** A button block: where it leads, and how it stands out. */
export function ButtonSettings({
  block,
  onChange,
  pages,
}: {
  block: ButtonBlock;
  onChange: (block: ButtonBlock) => void;
  pages: readonly LinkablePage[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <ButtonTargetFields
        target={block.target}
        pages={pages}
        onChange={(target) => {
          onChange({ ...block, target });
        }}
      />
      <label className={LABEL}>
        {t("siteAdmin.editor.buttonStyle")}
        <select
          className={FIELD}
          value={block.style}
          onChange={(event) => {
            const style = BUTTON_STYLES.find(
              (candidate) => candidate === event.target.value,
            );
            if (style !== undefined) {
              onChange({ ...block, style });
            }
          }}
        >
          {BUTTON_STYLES.map((style) => (
            <option key={style} value={style}>
              {t(STYLE_LABELS[style])}
            </option>
          ))}
        </select>
      </label>
      <p className={HINT}>{t("siteAdmin.editor.buttonHint")}</p>
    </div>
  );
}

/**
 * A picture: whether it shows anybody, the file, and its description.
 *
 * The declaration is answered before the file is chosen, as on an image block,
 * because it travels with the bytes and is recorded on the stored file. A
 * description is required on a banner and a picture beside text, and the field
 * says so in words rather than only by marking it.
 */
export function PictureFields({
  id,
  alt,
  onAlt,
  required,
  context,
}: {
  id: string;
  alt: string;
  onAlt: (alt: string) => void;
  required: boolean;
  context: BlockFieldsContext;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <label className="flex min-h-11 items-start gap-3 text-small text-ink">
        <input
          type="checkbox"
          checked={context.declared.has(id)}
          onChange={(event) => {
            context.declare(id, event.target.checked);
          }}
          className="mt-1 size-4 accent-trust"
        />
        {t("siteAdmin.editor.identifiable")}
      </label>
      <label className={LABEL}>
        {t("siteAdmin.editor.picture")}
        <input
          className={FIELD}
          type="file"
          accept="image/*"
          disabled={context.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              context.upload(id, file);
            }
          }}
        />
        <span className={HINT}>{t("siteAdmin.editor.pictureHint")}</span>
      </label>
      <label className={LABEL}>
        {required
          ? t("siteAdmin.editor.altRequired")
          : t("siteAdmin.editor.alt")}
        <input
          className={FIELD}
          maxLength={PAGE_CONTENT_LIMITS.alt}
          required={required}
          value={alt}
          onChange={(event) => {
            onAlt(event.target.value);
          }}
        />
        <span className={HINT}>
          {required
            ? t("siteAdmin.editor.altRequiredHint")
            : t("siteAdmin.editor.altHint")}
        </span>
      </label>
    </div>
  );
}

/** A heading's rank: a heading, or a sub-heading under one. */
export function HeadingSettings({
  block,
  onChange,
}: {
  block: HeadingBlock;
  onChange: (block: HeadingBlock) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <label className={LABEL}>
      {t("siteAdmin.editor.headingLevel")}
      <select
        className={FIELD}
        value={String(block.level)}
        onChange={(event) => {
          onChange({ ...block, level: event.target.value === "3" ? 3 : 2 });
        }}
      >
        <option value="2">{t("siteAdmin.editor.headingLevelTwo")}</option>
        <option value="3">{t("siteAdmin.editor.headingLevelThree")}</option>
      </select>
    </label>
  );
}

/** A banner: its picture, and whether it has a button and where that leads. */
export function BannerSettings({
  entry,
  block,
  onChange,
  context,
}: {
  entry: EditorBlock;
  block: BannerBlock;
  onChange: (block: BannerBlock) => void;
  context: BlockFieldsContext;
}): ReactElement {
  const { t } = useTranslation();
  const button = block.button;
  return (
    <div className="flex flex-col gap-3">
      <PictureFields
        id={entry.id}
        alt={block.alt}
        required
        context={context}
        onAlt={(alt) => {
          onChange({ ...block, alt });
        }}
      />
      {button === undefined ? (
        <div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              onChange({
                ...block,
                button: { label: "", target: { kind: "page", pageId: "" } },
              });
            }}
          >
            {t("siteAdmin.editor.bannerAddButton")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 border-l-2 border-line pl-3">
          <ButtonTargetFields
            target={button.target}
            pages={context.pages}
            onChange={(target) => {
              onChange({ ...block, button: { ...button, target } });
            }}
          />
          <div>
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                const { button: _removed, ...rest } = block;
                onChange(rest);
              }}
            >
              {t("siteAdmin.editor.bannerRemoveButton")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A picture beside text: the picture, the side it stands on, and how many
 * paragraphs the text has.
 */
export function ImageTextSettings({
  entry,
  block,
  onEntry,
  context,
}: {
  entry: EditorBlock;
  block: ImageTextBlock;
  onEntry: (entry: EditorBlock) => void;
  context: BlockFieldsContext;
}): ReactElement {
  const { t } = useTranslation();
  const room =
    PAGE_CONTENT_LIMITS.imageTextParagraphs - block.paragraphs.length;
  const update = (next: ImageTextBlock): void => {
    onEntry(withBlock(entry, next));
  };

  return (
    <div className="flex flex-col gap-3">
      <PictureFields
        id={entry.id}
        alt={block.alt}
        required
        context={context}
        onAlt={(alt) => {
          update({ ...block, alt });
        }}
      />
      <label className={LABEL}>
        {t("siteAdmin.editor.imageSide")}
        <select
          className={FIELD}
          value={block.side}
          onChange={(event) => {
            const side = IMAGE_SIDES.find(
              (candidate) => candidate === event.target.value,
            );
            if (side !== undefined) {
              update({ ...block, side });
            }
          }}
        >
          {IMAGE_SIDES.map((side) => (
            <option key={side} value={side}>
              {t(SIDE_LABELS[side])}
            </option>
          ))}
        </select>
        <span className={HINT}>{t("siteAdmin.editor.imageSideHint")}</span>
      </label>
      {block.paragraphs.length > 1 ? (
        <ul className="flex flex-col gap-2">
          {block.paragraphs.map((_, at) => (
            <li key={entry.nested?.[0]?.[at] ?? at}>
              <button
                type="button"
                className={QUIET_BUTTON}
                onClick={() => {
                  onEntry(removeParagraph(entry, at));
                }}
              >
                {t("siteAdmin.editor.imageTextRemoveParagraph", {
                  number: at + 1,
                })}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={room <= 0}
          onClick={() => {
            onEntry(addParagraph(entry));
          }}
        >
          {t("siteAdmin.editor.imageTextAddParagraph")}
        </button>
      </div>
    </div>
  );
}

/**
 * Columns: how many.
 *
 * The blocks in them are on the page, where they are written and dragged
 * between the columns like any other block.
 */
export function ColumnsSettings({
  entry,
  block,
  onEntry,
}: {
  entry: EditorBlock;
  block: ColumnsBlock;
  onEntry: (entry: EditorBlock) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <label className={LABEL}>
      {t("siteAdmin.editor.columnsCount")}
      <select
        className={FIELD}
        value={String(block.columns.length)}
        onChange={(event) => {
          onEntry(withColumnCount(entry, event.target.value === "3" ? 3 : 2));
        }}
      >
        <option value="2">{t("siteAdmin.editor.columnsTwo")}</option>
        <option value="3">{t("siteAdmin.editor.columnsThree")}</option>
      </select>
      <span className={HINT}>{t("siteAdmin.editor.columnsHint")}</span>
    </label>
  );
}
