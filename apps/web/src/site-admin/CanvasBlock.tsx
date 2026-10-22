import { useDraggable, useDroppable } from "@dnd-kit/core";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import { lazy, memo, Suspense, useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type BannerBlock,
  type ButtonBlock,
  type ColumnsBlock,
  type FaqBlock,
  type HeadingBlock,
  type ImageBlock,
  type ImageTextBlock,
  mediaPath,
  type PageBlock,
} from "../api/site";
import { HINT, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { type BlockPlace, isNestable, samePlace } from "./block-tree";
import { BlockInserter } from "./BlockInserter";
import { useCanvasActions, useCanvasState } from "./canvas-context";
import { EditorIcon } from "./EditorIcon";
import {
  type EditorBlock,
  emptyFaqItem,
  pluginBlockOf,
  removeFaqItem,
  replaceParagraphWith,
  runsToText,
  textToRuns,
  withFaqItem,
} from "./page-blocks";

/**
 * One block on the page, as the page shows it, and the tools to arrange it.
 *
 * The block is drawn in the markup the website renders it in, under the
 * website's own rules (canvas-stylesheet.ts), and what it says is written
 * where it stands: a paragraph in the text editor, a heading or a button's
 * label in a field drawn as the heading or the button. Everything about a
 * block that is not words on the page is in the settings beside it.
 *
 * Its tools stand over it while it is selected - by a click, or by the focus
 * reaching anything inside it - so the page reads as the page the rest of the
 * time. Each tool is an ordinary button named for the block it acts on, and
 * the handle that drags the block is also how it is moved from the keyboard.
 */

/** Loaded on demand: the one heavy thing in the client. */
const RichText = lazy(async () => import("./RichText"));

/** How a block is named where it stands: on the page, or in a column. */
type Named =
  | { kind: string; number: number }
  | { kind: string; number: number; column: number };

function namedAt(kind: string, place: BlockPlace): Named {
  return place.list === "page"
    ? { kind, number: place.at + 1 }
    : { kind, number: place.at + 1, column: place.column + 1 };
}

interface CanvasBlockProps {
  entry: EditorBlock;
  place: BlockPlace;
}

/**
 * Drawn again only when its own content or place changes, or the part of the
 * page's state it shows: typing in one block of two hundred redraws one.
 */
export const CanvasBlock = memo(
  CanvasBlockView,
  (before: CanvasBlockProps, after: CanvasBlockProps) =>
    before.entry.id === after.entry.id &&
    before.entry.block === after.entry.block &&
    before.entry.nested === after.entry.nested &&
    before.entry.stored === after.entry.stored &&
    samePlace(before.place, after.place),
);

function CanvasBlockView({ entry, place }: CanvasBlockProps): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const { id, block } = entry;
  const nested = place.list === "column";
  const kindOf = useCanvasState((state) => state.kindOf);
  const named = namedAt(kindOf(block), place);
  const inColumn = "column" in named;

  const selected = useCanvasState((state) => state.selected === id);
  const lifted = useCanvasState((state) => state.lifted === id);
  const dragged = useCanvasState((state) => state.dragging === id);
  const drop = useCanvasState((state) =>
    state.dropAt !== null && "id" in state.dropAt && state.dropAt.id === id
      ? state.dropAt.edge
      : undefined,
  );
  const pageFull = useCanvasState((state) => state.room <= 0);
  const choices = useCanvasState((state) =>
    nested ? state.columnChoices : state.pageChoices,
  );

  const draggable = useDraggable({ id, data: { nestable: isNestable(block) } });
  const droppable = useDroppable({
    id,
    data: {
      kind: "block",
      parent: place.list === "column" ? place.parent : null,
    },
  });

  const after: BlockPlace = { ...place, at: place.at + 1 };
  const full =
    place.list === "page" && pageFull
      ? t("siteAdmin.editor.pageFullShort", {
          count: PAGE_CONTENT_LIMITS.blocks,
        })
      : null;

  return (
    <div
      ref={(element) => {
        draggable.setNodeRef(element);
        droppable.setNodeRef(element);
      }}
      data-canvas-block=""
      data-block-id={id}
      data-drop={drop}
      className={[
        "relative outline-offset-4",
        selected || lifted ? "outline-2 outline-trust" : "",
        lifted ? "shadow-raised" : "",
        dragged ? "opacity-40" : "",
        // Where a dragged block would land: a line in the accent at the edge.
        "data-[drop]:before:pointer-events-none data-[drop]:before:absolute data-[drop]:before:inset-x-0 data-[drop]:before:z-30 data-[drop]:before:h-1 data-[drop]:before:rounded-control data-[drop]:before:bg-trust data-[drop]:before:content-['']",
        "data-[drop=after]:before:-bottom-2 data-[drop=before]:before:-top-2",
      ].join(" ")}
      onFocus={(event) => {
        // The innermost block takes it: a block in a column, not its columns.
        event.stopPropagation();
        actions.select(id);
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
        actions.select(id);
      }}
    >
      <div
        role="toolbar"
        aria-label={t(
          inColumn
            ? "siteAdmin.editor.columnBlockTools"
            : "siteAdmin.editor.blockTools",
          named,
        )}
        className={[
          "absolute bottom-full left-0 z-20 mb-2 flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-line bg-raised p-0.5 text-ink shadow-raised",
          selected || lifted
            ? ""
            : "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="px-2 text-label whitespace-nowrap text-ink-muted uppercase"
        >
          {named.kind}
        </span>
        <button
          type="button"
          ref={(element) => {
            draggable.setActivatorNodeRef(element);
            actions.control(`${id}:handle`)(element);
          }}
          {...draggable.listeners}
          aria-label={t(
            inColumn
              ? "siteAdmin.editor.columnDragNamed"
              : "siteAdmin.editor.dragNamed",
            named,
          )}
          aria-describedby={actions.instructionsId}
          aria-pressed={lifted}
          data-canvas-handle={id}
          title={t("siteAdmin.editor.drag")}
          className={`${TOOL} cursor-grab touch-none aria-pressed:bg-trust-soft aria-pressed:text-ink`}
          onKeyDown={(event) => {
            actions.handleKey(id, event);
          }}
        >
          <EditorIcon name="drag" />
        </button>
        <ToolButton
          icon="moveUp"
          label={t(
            inColumn
              ? "siteAdmin.editor.columnMoveUpNamed"
              : "siteAdmin.editor.moveUpNamed",
            named,
          )}
          title={t("siteAdmin.editor.moveUp")}
          control={actions.control(`${id}:-1`)}
          onPress={() => {
            actions.step(id, -1);
          }}
        />
        <ToolButton
          icon="moveDown"
          label={t(
            inColumn
              ? "siteAdmin.editor.columnMoveDownNamed"
              : "siteAdmin.editor.moveDownNamed",
            named,
          )}
          title={t("siteAdmin.editor.moveDown")}
          control={actions.control(`${id}:1`)}
          onPress={() => {
            actions.step(id, 1);
          }}
        />
        <ToolButton
          icon="duplicate"
          label={t(
            inColumn
              ? "siteAdmin.editor.columnDuplicateNamed"
              : "siteAdmin.editor.duplicateNamed",
            named,
          )}
          title={t("siteAdmin.editor.duplicate")}
          control={actions.control(`${id}:duplicate`)}
          onPress={() => {
            actions.duplicate(id);
          }}
        />
        <ToolButton
          icon="remove"
          label={t(
            inColumn
              ? "siteAdmin.editor.columnRemoveNamed"
              : "siteAdmin.editor.removeBlockNamed",
            named,
          )}
          title={t("siteAdmin.editor.removeBlock")}
          onPress={() => {
            actions.remove(id);
          }}
        />
        <BlockInserter
          look="tool"
          label={t(
            inColumn
              ? "siteAdmin.editor.inserter.afterInColumn"
              : "siteAdmin.editor.inserter.after",
            named,
          )}
          choices={choices}
          full={full}
          onChoose={(type) => {
            actions.insert(after, type);
          }}
        />
      </div>

      <div data-canvas-content="">
        <BlockContent entry={entry} place={place} named={named} />
      </div>
    </div>
  );
}

/** A tool over a block: a picture, and its name for a screen reader. */
const TOOL =
  "inline-flex size-11 items-center justify-center rounded-control text-ink-muted transition-colors duration-150 ease-out hover:bg-sunken hover:text-ink";

function ToolButton({
  icon,
  label,
  title,
  control,
  onPress,
}: {
  icon: "moveUp" | "moveDown" | "duplicate" | "remove";
  label: string;
  title: string;
  control?: (element: HTMLElement | null) => void;
  onPress: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      ref={control}
      aria-label={label}
      title={title}
      className={TOOL}
      onClick={onPress}
    >
      <EditorIcon name={icon} />
    </button>
  );
}

/** What a block shows, by its type. */
function BlockContent({
  entry,
  place,
  named,
}: {
  entry: EditorBlock;
  place: BlockPlace;
  named: Named;
}): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const { id, block } = entry;
  const fieldLabel = (field: string): string =>
    "column" in named
      ? t("siteAdmin.editor.columnFieldLabel", { ...named, field })
      : t("siteAdmin.editor.fieldLabel", { ...named, field });
  const set = (next: PageBlock): void => {
    actions.update(id, next);
  };

  switch (block.type) {
    case "paragraph":
      return (
        <PageParagraph
          id={id}
          runs={(block as { runs: { text: string }[] }).runs}
          label={
            "column" in named
              ? t("siteAdmin.editor.columnParagraphLabel", named)
              : t("siteAdmin.editor.paragraphLabel", named)
          }
          place={place}
        />
      );

    case "heading": {
      const heading = block as HeadingBlock;
      const Tag = heading.level === 3 ? "h3" : "h2";
      return (
        <Tag>
          <PlainText
            label={fieldLabel(t("siteAdmin.editor.headingText"))}
            placeholder={t("siteAdmin.editor.canvas.heading")}
            maxLength={PAGE_CONTENT_LIMITS.runText}
            value={runsToText(heading.runs)}
            onChange={(text) => {
              set({ ...heading, runs: textToRuns(text) });
            }}
          />
        </Tag>
      );
    }

    case "image": {
      const image = block as ImageBlock;
      return (
        <figure className="site-figure">
          {image.mediaFileId === "" ? (
            <NoPicture />
          ) : (
            <img src={mediaPath(image.mediaFileId)} alt={image.alt} />
          )}
          <figcaption>
            <PlainText
              label={fieldLabel(t("siteAdmin.editor.caption"))}
              placeholder={t("siteAdmin.editor.canvas.caption")}
              maxLength={PAGE_CONTENT_LIMITS.caption}
              value={image.caption ?? ""}
              onChange={(caption) => {
                set({ ...image, caption });
              }}
            />
          </figcaption>
        </figure>
      );
    }

    case "button": {
      const button = block as ButtonBlock;
      return (
        <p className="site-button-row">
          <span className={`site-button site-button-${button.style}`}>
            <ButtonLabel
              label={fieldLabel(t("siteAdmin.editor.buttonLabel"))}
              value={button.label}
              onChange={(label) => {
                set({ ...button, label });
              }}
            />
          </span>
        </p>
      );
    }

    case "banner": {
      const banner = block as BannerBlock;
      return (
        <div className="site-banner">
          {banner.mediaFileId === "" ? (
            <NoPicture />
          ) : (
            <img
              className="site-banner-image"
              src={mediaPath(banner.mediaFileId)}
              alt={banner.alt}
            />
          )}
          <div className="site-banner-body">
            <h2>
              <PlainText
                label={fieldLabel(t("siteAdmin.editor.bannerHeading"))}
                placeholder={t("siteAdmin.editor.canvas.heading")}
                maxLength={PAGE_CONTENT_LIMITS.bannerHeading}
                value={banner.heading}
                onChange={(heading) => {
                  set({ ...banner, heading });
                }}
              />
            </h2>
            <p>
              <PlainText
                multiline
                label={fieldLabel(t("siteAdmin.editor.bannerText"))}
                placeholder={t("siteAdmin.editor.canvas.bannerText")}
                maxLength={PAGE_CONTENT_LIMITS.bannerText}
                value={banner.text ?? ""}
                onChange={(text) => {
                  set({ ...banner, text });
                }}
              />
            </p>
            {banner.button === undefined ? null : (
              <p className="site-button-row">
                <span className="site-button site-button-primary">
                  <ButtonLabel
                    label={fieldLabel(t("siteAdmin.editor.buttonLabel"))}
                    value={banner.button.label}
                    onChange={(label) => {
                      set({
                        ...banner,
                        button: {
                          ...(banner.button as NonNullable<
                            BannerBlock["button"]
                          >),
                          label,
                        },
                      });
                    }}
                  />
                </span>
              </p>
            )}
          </div>
        </div>
      );
    }

    case "imageText":
      return <PageImageText entry={entry} block={block as ImageTextBlock} />;

    case "columns":
      return <PageColumns entry={entry} block={block as ColumnsBlock} />;

    case "faq":
      return <PageFaq id={id} block={block as FaqBlock} named={named} />;

    default:
      return <Elsewhere entry={entry} />;
  }
}

/** A paragraph, in the text editor, with what held its text back said under it. */
function PageParagraph({
  id,
  runs,
  label,
  place,
}: {
  id: string;
  runs: readonly { text: string }[];
  label: string;
  place: BlockPlace;
}): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  /*
   * How many paragraphs a return may make of this one: one, and one more for
   * each block the list it stands in still has room for.
   */
  const room = useCanvasState((state) => {
    if (place.list === "page") {
      return state.room;
    }
    const parent = state.entries.find((entry) => entry.id === place.parent);
    const column = (parent?.block as ColumnsBlock | undefined)?.columns[
      place.column
    ];
    return PAGE_CONTENT_LIMITS.columnBlocks - (column?.blocks.length ?? 0);
  });
  const splitAt = useCanvasState((state) =>
    state.splitFocus?.id === id ? state.splitFocus.offset : undefined,
  );
  const long = useCanvasState((state) => state.longAt.includes(id));
  const held = useCanvasState((state) => state.heldAt === id);
  const inColumn = place.list === "column";

  return (
    <Suspense
      fallback={
        <p className={HINT} role="status">
          {t("siteAdmin.editor.loadingEditor")}
        </p>
      }
    >
      <RichText
        look="page"
        label={label}
        placeholder={t("siteAdmin.editor.canvas.paragraph")}
        runs={runs}
        focusAt={splitAt}
        maxParagraphs={1 + Math.max(room, 0)}
        onFull={() => {
          actions.heldFull(id);
        }}
        onLong={(blocks, refused) => {
          actions.heldLong(id, blocks, refused);
        }}
        onChange={(paragraphs, caret) => {
          actions.writeParagraph(id, paragraphs, caret);
        }}
      />
      {long ? (
        <Notice tone="warn" live>
          {t(
            room <= 0
              ? inColumn
                ? "siteAdmin.editor.paragraphFullColumnFull"
                : "siteAdmin.editor.paragraphFullPageFull"
              : "siteAdmin.editor.paragraphFull",
            { count: PAGE_CONTENT_LIMITS.runText },
          )}
        </Notice>
      ) : null}
      {room <= 0 && held ? (
        <Notice tone="warn" live>
          {t(
            inColumn
              ? "siteAdmin.editor.columnFull"
              : "siteAdmin.editor.pageFull",
            {
              count: inColumn
                ? PAGE_CONTENT_LIMITS.columnBlocks
                : PAGE_CONTENT_LIMITS.blocks,
            },
          )}
        </Notice>
      ) : null}
    </Suspense>
  );
}

/** A picture beside text, its paragraphs written in place. */
function PageImageText({
  entry,
  block,
}: {
  entry: EditorBlock;
  block: ImageTextBlock;
}): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const split = useCanvasState((state) => state.splitFocus);
  const ids = entry.nested?.[0] ?? [];
  const room =
    PAGE_CONTENT_LIMITS.imageTextParagraphs - block.paragraphs.length;

  return (
    <div className={`site-image-text site-image-text-${block.side}`}>
      {block.mediaFileId === "" ? (
        <NoPicture className="site-image-text-image" />
      ) : (
        <img
          className="site-image-text-image"
          src={mediaPath(block.mediaFileId)}
          alt={block.alt}
        />
      )}
      <div className="site-image-text-body">
        {block.paragraphs.map((runs, at) => {
          const id = ids[at] ?? `${entry.id}:${String(at)}`;
          return (
            <Suspense
              key={id}
              fallback={
                <p className={HINT} role="status">
                  {t("siteAdmin.editor.loadingEditor")}
                </p>
              }
            >
              <RichText
                look="page"
                label={t("siteAdmin.editor.imageTextParagraph", {
                  number: at + 1,
                })}
                placeholder={t("siteAdmin.editor.canvas.paragraph")}
                runs={runs}
                focusAt={split?.id === id ? split.offset : undefined}
                maxParagraphs={1 + room}
                onChange={(paragraphs, caret) => {
                  const current = actions.entry(entry.id) ?? entry;
                  const result = replaceParagraphWith(current, at, paragraphs);
                  actions.updateEntry(entry.id, result.entry);
                  const target = result.added[caret.paragraph - 1];
                  if (target !== undefined) {
                    actions.focusSplit(target, caret.offset);
                  }
                }}
              />
            </Suspense>
          );
        })}
      </div>
    </div>
  );
}

/** Columns, each a list of blocks drawn and arranged like the page's own. */
function PageColumns({
  entry,
  block,
}: {
  entry: EditorBlock;
  block: ColumnsBlock;
}): ReactElement {
  return (
    <div
      className={`site-columns site-columns-${String(block.columns.length)}`}
    >
      {block.columns.map((column, at) => (
        <PageColumn
          key={at}
          parent={entry}
          column={at}
          blocks={column.blocks}
        />
      ))}
    </div>
  );
}

function PageColumn({
  parent,
  column,
  blocks,
}: {
  parent: EditorBlock;
  column: number;
  blocks: readonly PageBlock[];
}): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const choices = useCanvasState((state) => state.columnChoices);
  const droppable = useDroppable({
    id: `column:${parent.id}:${String(column)}`,
    data: { kind: "column", parent: parent.id, column },
  });
  const ids = parent.nested?.[column] ?? [];
  const drop = useCanvasState(
    (state) =>
      state.dropAt !== null &&
      "parent" in state.dropAt &&
      state.dropAt.parent === parent.id &&
      state.dropAt.column === column,
  );

  return (
    <div
      ref={(element) => {
        droppable.setNodeRef(element);
      }}
      role="group"
      aria-label={t("siteAdmin.editor.column", { number: column + 1 })}
      className={`site-column relative min-h-11 ${drop ? "outline-2 outline-offset-4 outline-trust" : ""}`}
    >
      {blocks.map((nested, at) => {
        const id = ids[at] ?? `${parent.id}:${String(column)}:${String(at)}`;
        return (
          <CanvasBlock
            key={id}
            entry={{ id, block: nested, stored: parent.stored }}
            place={{ list: "column", parent: parent.id, column, at }}
          />
        );
      })}
      {blocks.length === 0 ? (
        <BlockInserter
          look="end"
          label={t("siteAdmin.editor.columnAdd", { column: column + 1 })}
          choices={choices}
          full={null}
          ref={actions.control(`${parent.id}:${String(column)}:add`)}
          onChoose={(type) => {
            actions.insert(
              { list: "column", parent: parent.id, column, at: 0 },
              type,
            );
          }}
        />
      ) : null}
    </div>
  );
}

/** Questions and answers, written where the website shows them. */
function PageFaq({
  id,
  block,
  named,
}: {
  id: string;
  block: FaqBlock;
  named: Named;
}): ReactElement {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const set = (items: FaqBlock["items"]): void => {
    actions.update(id, { type: "faq", items });
  };

  return (
    <section className="site-faq">
      <h2>{t("site.faq.heading")}</h2>
      <dl className="site-faq-list">
        {block.items.map((item, at) => (
          // By position, as before: two plain fields whose value is read from
          // the props on every render, so a reordered list shows the right
          // text rather than the document an editor was built from.
          <div key={at}>
            <dt>
              <PlainText
                label={t("siteAdmin.editor.faqQuestionNamed", {
                  ...named,
                  question: at + 1,
                })}
                placeholder={t("siteAdmin.editor.canvas.question")}
                maxLength={PAGE_CONTENT_LIMITS.faqQuestion}
                value={item.question}
                onChange={(question) => {
                  set(withFaqItem(block.items, at, { ...item, question }));
                }}
              />
            </dt>
            <dd>
              <p>
                <PlainText
                  multiline
                  label={t("siteAdmin.editor.faqAnswerNamed", {
                    ...named,
                    question: at + 1,
                  })}
                  placeholder={t("siteAdmin.editor.canvas.answer")}
                  maxLength={PAGE_CONTENT_LIMITS.runText}
                  value={runsToText(item.answer)}
                  onChange={(answer) => {
                    set(
                      withFaqItem(block.items, at, {
                        ...item,
                        answer: textToRuns(answer),
                      }),
                    );
                  }}
                />
              </p>
              <button
                type="button"
                className={QUIET_BUTTON}
                onClick={() => {
                  set(removeFaqItem(block.items, at));
                }}
              >
                {t("siteAdmin.editor.faqRemoveItemNamed", { number: at + 1 })}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className={SECONDARY_BUTTON}
        // A page the write path would refuse is not a page the board should
        // be able to build and only be told about when they press save.
        disabled={block.items.length >= PAGE_CONTENT_LIMITS.faqItems}
        onClick={() => {
          set([...block.items, emptyFaqItem()]);
        }}
      >
        {t("siteAdmin.editor.faqAddItem")}
      </button>
    </section>
  );
}

/**
 * A block whose content is not written on the page: the association's own
 * news, calendar, documents, board or facts, a form, or a plugin's block.
 *
 * What it shows is read when the page is served, and can be different for
 * each reader, so the page stands it in as a card that names it and says
 * where what it shows comes from. Its settings are beside the page.
 */
function Elsewhere({ entry }: { entry: EditorBlock }): ReactElement {
  const { t } = useTranslation();
  const { block } = entry;
  const definition = useCanvasState((state) =>
    state.registry.definition(block.type),
  );
  const plugin = useCanvasState((state) => pluginBlockOf(block, state.plugins));
  const known = useCanvasState((state) => state.pluginsKnown);
  const kindOf = useCanvasState((state) => state.kindOf);
  const unfinished = useCanvasState((state) =>
    state.unfinished.includes(
      state.entries.findIndex((one) => one.id === entry.id),
    ),
  );

  let hint: string;
  if (definition === undefined) {
    hint = t(UNREGISTERED_HINT[known]);
  } else if (plugin !== undefined) {
    hint = t("siteAdmin.editor.pluginBlockHint");
  } else {
    hint = t("siteAdmin.editor.canvas.elsewhere");
  }

  return (
    <div className="my-8 flex items-start gap-3 rounded-panel border border-line bg-raised p-4 text-ink">
      <EditorIcon name={definition?.editor.icon ?? "plugin"} />
      <span className="flex flex-col gap-1">
        <span className="font-semibold">{kindOf(block)}</span>
        <span className="text-small text-ink-muted">{hint}</span>
        {unfinished ? (
          <span className="text-small text-warn">
            {t("siteAdmin.editor.pluginBlockUnfinished")}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** What the editor can say about a block it has no declaration for. */
export const UNREGISTERED_HINT = {
  loading: "siteAdmin.editor.unregisteredLoadingHint",
  failed: "siteAdmin.editor.unregisteredUnknownHint",
  known: "siteAdmin.editor.unregisteredHint",
} as const;

/** Where a picture will be, before one is chosen. */
function NoPicture({ className = "" }: { className?: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={`${className} flex aspect-[16/7] w-full flex-col items-center justify-center gap-2 rounded-control border border-line-strong bg-sunken p-4 text-center text-small text-ink-muted`}
    >
      <EditorIcon name="image" />
      {t("siteAdmin.editor.canvas.noPicture")}
    </span>
  );
}

/**
 * Words written where they are shown: a field with no frame of its own, in
 * the type of whatever it stands in - a heading, a caption, a banner.
 *
 * A text area that grows with what is written, so a long heading wraps as it
 * will on the website rather than scrolling inside one line. A return ends
 * nothing in a field that holds one line; it is not a way to start a second.
 */
export function PlainText({
  label,
  placeholder,
  value,
  onChange,
  maxLength,
  multiline = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  multiline?: boolean;
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      value={value}
      data-canvas-focus=""
      className="block w-full resize-none overflow-hidden placeholder:text-ink-muted"
      onKeyDown={(event) => {
        if (!multiline && event.key === "Enter") {
          event.preventDefault();
        }
      }}
      onChange={(event) => {
        onChange(
          multiline
            ? event.target.value
            : event.target.value.replaceAll(/[\r\n]+/g, " "),
        );
      }}
    />
  );
}

/** A button's label, written on the button. */
function ButtonLabel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const placeholder = t("siteAdmin.editor.canvas.button");
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      maxLength={PAGE_CONTENT_LIMITS.buttonLabel}
      size={Math.max(value.length, placeholder.length, 4)}
      value={value}
      data-canvas-focus=""
      className="text-center placeholder:text-current placeholder:opacity-80"
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
