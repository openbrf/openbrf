import {
  BUILT_IN_PAGES,
  BUTTON_STYLES,
  IMAGE_SIDES,
  PAGE_CONTENT_LIMITS,
} from "@openbrf/shared";
import { lazy, Suspense, useId } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type {
  BannerBlock,
  BuiltInPage,
  ButtonBlock,
  ButtonLink,
  ButtonStyle,
  ColumnsBlock,
  HeadingBlock,
  ImageSide,
  ImageTextBlock,
  LinkTarget,
  NestedBlock,
  TextRun,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import {
  addParagraph,
  addToColumn,
  blockLabel,
  type EditorBlock,
  moveInColumn,
  NESTED_INSERTABLE,
  nestedInsertLabel,
  removeFromColumn,
  removeParagraph,
  replaceInColumn,
  replaceInColumnWith,
  replaceParagraphWith,
  runsToText,
  textToRuns,
  withBlock,
  withColumnCount,
} from "./page-blocks";
import type { Caret } from "./RichText";

/**
 * The fields of the blocks that arrange a page: a button, a banner, a picture
 * beside text, and columns.
 *
 * Plain fields in a list, like every other block in today's editor, so each of
 * them can be built, filled in and reordered with a keyboard and a screen
 * reader before the visual editor replaces this screen. What they write is the
 * stored block and nothing else; the website decides what it becomes.
 */

/** Loaded on demand, as in the page editor: the one heavy thing in the client. */
const RichText = lazy(async () => import("./RichText"));

/** A page a button may lead to, as the editor names it. */
export interface LinkablePage {
  id: string;
  title: string;
}

/**
 * What the page editor lends the fields: its pages, its pictures and its
 * keyboard bookkeeping.
 *
 * Handed down rather than kept here, because each of these is the page's and
 * not a block's: one upload at a time, one declaration per picture by its
 * identity, one announcement and one restored focus after a move.
 */
export interface BlockFieldsContext {
  pages: readonly LinkablePage[];
  busy: boolean;
  /** The pictures declared to show identifiable persons, by identity. */
  declared: ReadonlySet<string>;
  declare: (id: string, shows: boolean) => void;
  /** Uploads a picture for the block or the block in a column with this identity. */
  upload: (id: string, file: File) => void;
  /** Hands a move button its place, so the focus can come back to it. */
  moveButton: (key: string) => (element: HTMLButtonElement | null) => void;
  /** Says where a moved block went, and puts the focus back on the button. */
  moved: (key: string, announcement: string) => void;
  /** The paragraph a return has just split off, and where its caret goes. */
  splitFocus: { id: string; offset: number } | null;
  focusSplit: (id: string, offset: number) => void;
}

const TARGET_KINDS = ["page", "builtIn", "url"] as const;

type TargetKind = (typeof TARGET_KINDS)[number];

const TARGET_KIND_LABELS = {
  page: "siteAdmin.editor.buttonTargetPage",
  builtIn: "siteAdmin.editor.buttonTargetBuiltIn",
  url: "siteAdmin.editor.buttonTargetUrl",
} as const satisfies Record<TargetKind, TranslationKey>;

/** The menu's own names for the pages the product builds. */
const BUILT_IN_LABELS = {
  news: "siteAdmin.menu.generated.news",
  calendar: "siteAdmin.menu.generated.calendar",
  broker: "siteAdmin.menu.generated.broker",
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

/** A label and where it leads: what a button and a banner's button share. */
function ButtonLinkFields({
  link,
  onChange,
  pages,
}: {
  link: ButtonLink;
  onChange: (link: ButtonLink) => void;
  pages: readonly LinkablePage[];
}): ReactElement {
  const { t } = useTranslation();
  const kindName = useId();
  const target = link.target;

  return (
    <div className="flex flex-col gap-3">
      <label className={LABEL}>
        {t("siteAdmin.editor.buttonLabel")}
        <input
          className={FIELD}
          maxLength={PAGE_CONTENT_LIMITS.buttonLabel}
          value={link.label}
          onChange={(event) => {
            onChange({ ...link, label: event.target.value });
          }}
        />
      </label>
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
                onChange({ ...link, target: emptyTarget(kind) });
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
              onChange({
                ...link,
                target: { kind: "page", pageId: event.target.value },
              });
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
                onChange({ ...link, target: { kind: "builtIn", page } });
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
              onChange({
                ...link,
                target: { kind: "url", url: event.target.value },
              });
            }}
          />
          <span className={HINT}>{t("siteAdmin.editor.buttonUrlHint")}</span>
        </label>
      ) : null}
    </div>
  );
}

/** A button block: its label, where it leads, and how it stands out. */
export function ButtonFields({
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
      <ButtonLinkFields
        link={block}
        pages={pages}
        onChange={(link) => {
          onChange({ ...block, ...link });
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

/** A heading's level and text, on the page or in a column. */
export function HeadingFields({
  block,
  onChange,
}: {
  block: HeadingBlock;
  onChange: (block: HeadingBlock) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-end gap-3">
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
      <label className={`${LABEL} flex-1`}>
        {t("siteAdmin.editor.headingText")}
        <input
          className={FIELD}
          maxLength={PAGE_CONTENT_LIMITS.runText}
          value={runsToText(block.runs)}
          onChange={(event) => {
            onChange({ ...block, runs: textToRuns(event.target.value) });
          }}
        />
      </label>
    </div>
  );
}

/** A banner: the picture, the heading, a short text and an optional button. */
export function BannerFields({
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
      <label className={LABEL}>
        {t("siteAdmin.editor.bannerHeading")}
        <input
          className={FIELD}
          maxLength={PAGE_CONTENT_LIMITS.bannerHeading}
          required
          value={block.heading}
          onChange={(event) => {
            onChange({ ...block, heading: event.target.value });
          }}
        />
      </label>
      <label className={LABEL}>
        {t("siteAdmin.editor.bannerText")}
        <textarea
          className={FIELD_MULTILINE}
          maxLength={PAGE_CONTENT_LIMITS.bannerText}
          rows={2}
          value={block.text ?? ""}
          onChange={(event) => {
            onChange({ ...block, text: event.target.value });
          }}
        />
      </label>
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
          <ButtonLinkFields
            link={button}
            pages={context.pages}
            onChange={(link) => {
              onChange({ ...block, button: link });
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

/** A picture beside text: the picture, its side, and the text. */
export function ImageTextFields({
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
  const ids = entry.nested?.[0] ?? [];
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
      {block.paragraphs.map((runs, at) => {
        const id = ids[at] ?? `${entry.id}:${String(at)}`;
        return (
          <div className="flex flex-col gap-2" key={id}>
            <Suspense
              fallback={
                <p className={HINT} role="status">
                  {t("siteAdmin.editor.loadingEditor")}
                </p>
              }
            >
              <RichText
                label={t("siteAdmin.editor.imageTextParagraph", {
                  number: at + 1,
                })}
                runs={runs}
                focusAt={
                  context.splitFocus?.id === id
                    ? context.splitFocus.offset
                    : undefined
                }
                maxParagraphs={1 + room}
                onChange={(paragraphs, caret) => {
                  const result = replaceParagraphWith(entry, at, paragraphs);
                  onEntry(result.entry);
                  const target = result.added[caret.paragraph - 1];
                  if (target !== undefined) {
                    context.focusSplit(target, caret.offset);
                  }
                }}
              />
            </Suspense>
            {block.paragraphs.length > 1 ? (
              <div>
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
              </div>
            ) : null}
          </div>
        );
      })}
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
 * Columns: how many, and the blocks in each.
 *
 * Every column is a group named by its number, with its blocks in a list, and
 * every block in it has the same move and remove buttons a block on the page
 * has - named for the screen reader by the block, its place and its column, so
 * "move up" is never read out without saying what moves.
 */
export function ColumnsFields({
  entry,
  block,
  onEntry,
  context,
}: {
  entry: EditorBlock;
  block: ColumnsBlock;
  onEntry: (entry: EditorBlock) => void;
  context: BlockFieldsContext;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
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

      {block.columns.map((column, columnAt) => {
        const ids = entry.nested?.[columnAt] ?? [];
        const columnNumber = columnAt + 1;
        const full = column.blocks.length >= PAGE_CONTENT_LIMITS.columnBlocks;
        return (
          <fieldset
            className="flex flex-col gap-3 rounded-control border border-line p-3"
            key={columnAt}
          >
            <legend className="px-1 text-label text-ink-muted uppercase">
              {t("siteAdmin.editor.column", { number: columnNumber })}
            </legend>
            {column.blocks.length === 0 ? (
              <p className={HINT}>{t("siteAdmin.editor.columnEmpty")}</p>
            ) : (
              <ol className="flex flex-col gap-4">
                {column.blocks.map((nested, at) => {
                  const id =
                    ids[at] ?? `${entry.id}:${String(columnAt)}:${String(at)}`;
                  const named = {
                    kind: t(blockLabel(nested.type)),
                    number: at + 1,
                    column: columnNumber,
                  };
                  const move = (direction: -1 | 1): void => {
                    const next = moveInColumn(entry, columnAt, at, direction);
                    onEntry(next);
                    const position = next.nested?.[columnAt]?.indexOf(id) ?? at;
                    context.moved(
                      `${id}:${String(direction)}`,
                      t("siteAdmin.editor.columnMovedTo", {
                        kind: named.kind,
                        number: position + 1,
                        count: column.blocks.length,
                        column: columnNumber,
                      }),
                    );
                  };
                  return (
                    <li className="flex flex-col gap-2" key={id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-label text-ink-muted uppercase">
                          {t("siteAdmin.editor.columnBlock", named)}
                        </span>
                        <button
                          type="button"
                          className={QUIET_BUTTON}
                          aria-label={t(
                            "siteAdmin.editor.columnMoveUpNamed",
                            named,
                          )}
                          ref={context.moveButton(`${id}:-1`)}
                          onClick={() => {
                            move(-1);
                          }}
                        >
                          {t("siteAdmin.editor.moveUp")}
                        </button>
                        <button
                          type="button"
                          className={QUIET_BUTTON}
                          aria-label={t(
                            "siteAdmin.editor.columnMoveDownNamed",
                            named,
                          )}
                          ref={context.moveButton(`${id}:1`)}
                          onClick={() => {
                            move(1);
                          }}
                        >
                          {t("siteAdmin.editor.moveDown")}
                        </button>
                        <button
                          type="button"
                          className={QUIET_BUTTON}
                          aria-label={t(
                            "siteAdmin.editor.columnRemoveNamed",
                            named,
                          )}
                          onClick={() => {
                            onEntry(removeFromColumn(entry, columnAt, at));
                          }}
                        >
                          {t("siteAdmin.editor.removeBlock")}
                        </button>
                      </div>
                      <NestedFields
                        id={id}
                        block={nested}
                        label={t("siteAdmin.editor.columnParagraphLabel", {
                          column: columnNumber,
                          number: at + 1,
                        })}
                        room={
                          PAGE_CONTENT_LIMITS.columnBlocks -
                          column.blocks.length
                        }
                        context={context}
                        onChange={(next) => {
                          onEntry(replaceInColumn(entry, columnAt, at, next));
                        }}
                        onSplit={(paragraphs, caret) => {
                          const result = replaceInColumnWith(
                            entry,
                            columnAt,
                            at,
                            paragraphs.map((runs) => ({
                              type: "paragraph" as const,
                              runs,
                            })),
                          );
                          onEntry(result.entry);
                          const target = result.added[caret.paragraph - 1];
                          if (target !== undefined) {
                            context.focusSplit(target, caret.offset);
                          }
                        }}
                      />
                    </li>
                  );
                })}
              </ol>
            )}
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label={t("siteAdmin.editor.columnAdd", {
                column: columnNumber,
              })}
            >
              {NESTED_INSERTABLE.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={full}
                  onClick={() => {
                    onEntry(addToColumn(entry, columnAt, kind));
                  }}
                >
                  {t(nestedInsertLabel(kind))}
                </button>
              ))}
            </div>
            {full ? (
              <p className={HINT}>
                {t("siteAdmin.editor.columnFull", {
                  count: PAGE_CONTENT_LIMITS.columnBlocks,
                })}
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

/** The fields of one block inside a column. */
function NestedFields({
  id,
  block,
  label,
  room,
  context,
  onChange,
  onSplit,
}: {
  id: string;
  block: NestedBlock;
  label: string;
  /** How many more blocks the column has room for. */
  room: number;
  context: BlockFieldsContext;
  onChange: (block: NestedBlock) => void;
  onSplit: (paragraphs: TextRun[][], caret: Caret) => void;
}): ReactElement {
  const { t } = useTranslation();

  switch (block.type) {
    case "paragraph":
      return (
        <Suspense
          fallback={
            <p className={HINT} role="status">
              {t("siteAdmin.editor.loadingEditor")}
            </p>
          }
        >
          <RichText
            label={label}
            runs={block.runs}
            focusAt={
              context.splitFocus?.id === id
                ? context.splitFocus.offset
                : undefined
            }
            maxParagraphs={1 + Math.max(room, 0)}
            onChange={(paragraphs, caret) => {
              if (paragraphs.length <= 1) {
                onChange({ type: "paragraph", runs: paragraphs[0] ?? [] });
                return;
              }
              onSplit(paragraphs, caret);
            }}
          />
        </Suspense>
      );
    case "heading":
      return <HeadingFields block={block} onChange={onChange} />;
    case "image":
      return (
        <div className="flex flex-col gap-3">
          <PictureFields
            id={id}
            alt={block.alt}
            required={false}
            context={context}
            onAlt={(alt) => {
              onChange({ ...block, alt });
            }}
          />
          <label className={LABEL}>
            {t("siteAdmin.editor.caption")}
            <input
              className={FIELD}
              maxLength={PAGE_CONTENT_LIMITS.caption}
              value={block.caption ?? ""}
              onChange={(event) => {
                onChange({ ...block, caption: event.target.value });
              }}
            />
          </label>
        </div>
      );
    case "button":
      return (
        <ButtonFields block={block} onChange={onChange} pages={context.pages} />
      );
  }
}
