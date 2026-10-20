import {
  PAGE_CONTENT_LIMITS,
  type PluginBlockDeclaration,
} from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type {
  BannerBlock,
  ButtonBlock,
  ColumnsBlock,
  HeadingBlock,
  ImageBlock,
  ImageTextBlock,
  PageBlock,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL } from "../ui/controls";
import { Panel } from "../ui/Panel";
import { UNREGISTERED_HINT } from "./CanvasBlock";
import {
  BannerSettings,
  type BlockFieldsContext,
  ButtonSettings,
  ColumnsSettings,
  HeadingSettings,
  ImageTextSettings,
  PictureFields,
} from "./LayoutBlockFields";
import {
  type EditorBlock,
  type EditorRegistry,
  pluginSettingsOf,
  withPluginSetting,
} from "./page-blocks";
import { PluginBlockFields } from "./PluginBlockFields";

/**
 * The selected block's settings, beside the page.
 *
 * Everything about a block that is not words on the page: which picture and
 * what it shows, where a button leads, how a heading ranks, how many columns,
 * how many dates. The panel is named for the block it is about, and says so
 * when no block is selected rather than standing empty.
 */

/**
 * The counts a calendar block may be set to.
 *
 * Derived from the API's own limit rather than written out, so the field cannot
 * offer a number the write path would refuse.
 */
const CALENDAR_COUNTS: readonly number[] = Array.from(
  { length: PAGE_CONTENT_LIMITS.calendarCount },
  (_, at) => at + 1,
);

/** What a block with nothing to set says instead, by its type. */
const NOTHING_TO_SET: Readonly<Record<string, TranslationKey>> = {
  paragraph: "siteAdmin.editor.settings.paragraph",
  faq: "siteAdmin.editor.settings.faq",
  boardRoster: "siteAdmin.editor.rosterHint",
  associationFacts: "siteAdmin.editor.factsHint",
  contactForm: "siteAdmin.editor.settings.placedElsewhere",
  issueReportForm: "siteAdmin.editor.settings.placedElsewhere",
  newsTeaser: "siteAdmin.editor.settings.placedElsewhere",
  controllerContact: "siteAdmin.editor.settings.placedElsewhere",
};

export interface BlockSettingsProps {
  /** The selected block, or undefined when none is. */
  entry: EditorBlock | undefined;
  kind: string;
  /** Whether it stands in a column. */
  nested: boolean;
  registry: EditorRegistry;
  plugins: readonly PluginBlockDeclaration[];
  pluginsKnown: "loading" | "failed" | "known";
  /** Whether it is a stored plugin's block that no longer has what it needs. */
  unfinished: boolean;
  context: BlockFieldsContext;
  onBlock: (block: PageBlock) => void;
  onEntry: (entry: EditorBlock) => void;
}

export function BlockSettings({
  entry,
  kind,
  nested,
  registry,
  plugins,
  pluginsKnown,
  unfinished,
  context,
  onBlock,
  onEntry,
}: BlockSettingsProps): ReactElement {
  const { t } = useTranslation();

  if (entry === undefined) {
    return (
      <Panel title={t("siteAdmin.editor.settings.heading")}>
        <p className={HINT}>{t("siteAdmin.editor.settings.none")}</p>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("siteAdmin.editor.settings.headingNamed", { kind })}
      description={nested ? t("siteAdmin.editor.settings.inColumn") : undefined}
    >
      <Fields
        entry={entry}
        registry={registry}
        plugins={plugins}
        pluginsKnown={pluginsKnown}
        unfinished={unfinished}
        context={context}
        onBlock={onBlock}
        onEntry={onEntry}
      />
    </Panel>
  );
}

function Fields({
  entry,
  registry,
  plugins,
  pluginsKnown,
  unfinished,
  context,
  onBlock,
  onEntry,
}: Omit<BlockSettingsProps, "entry" | "kind" | "nested"> & {
  entry: EditorBlock;
}): ReactElement {
  const { t } = useTranslation();
  const { id, block } = entry;

  const plugin = plugins.find((declaration) => declaration.type === block.type);
  if (plugin !== undefined) {
    // A serving plugin's block, set up by the form its declaration describes.
    return (
      <PluginBlockFields
        declaration={plugin}
        settings={pluginSettingsOf(block)}
        unfinished={unfinished}
        onChange={(key, value) => {
          onBlock(withPluginSetting(block, key, value));
        }}
      />
    );
  }
  if (registry.definition(block.type) === undefined) {
    // Kept while its plugin is away; what it holds is the plugin's to edit.
    return <p className={HINT}>{t(UNREGISTERED_HINT[pluginsKnown])}</p>;
  }

  switch (block.type) {
    case "heading":
      return (
        <HeadingSettings block={block as HeadingBlock} onChange={onBlock} />
      );
    case "image": {
      const image = block as ImageBlock;
      return (
        <div className="flex flex-col gap-3">
          <PictureFields
            id={id}
            alt={image.alt}
            required={false}
            context={context}
            onAlt={(alt) => {
              onBlock({ ...image, alt });
            }}
          />
          <p className={HINT}>{t("siteAdmin.editor.settings.caption")}</p>
        </div>
      );
    }
    case "button":
      return (
        <ButtonSettings
          block={block as ButtonBlock}
          pages={context.pages}
          onChange={onBlock}
        />
      );
    case "banner":
      return (
        <BannerSettings
          entry={entry}
          block={block as BannerBlock}
          context={context}
          onChange={onBlock}
        />
      );
    case "imageText":
      return (
        <ImageTextSettings
          entry={entry}
          block={block as ImageTextBlock}
          context={context}
          onEntry={onEntry}
        />
      );
    case "columns":
      return (
        <ColumnsSettings
          entry={entry}
          block={block as ColumnsBlock}
          onEntry={onEntry}
        />
      );
    case "eventCalendar": {
      const count = (block as { count: number }).count;
      return (
        <label className={LABEL}>
          {t("siteAdmin.editor.calendarCount")}
          <select
            className={FIELD}
            value={String(count)}
            onChange={(event) => {
              onBlock({
                type: "eventCalendar",
                count: Number(event.target.value),
              });
            }}
          >
            {/*
             * A list of the counts the API accepts rather than a number field,
             * so there is no way to type one it would refuse. One is the
             * smallest: a block showing no dates renders as nothing, which is
             * not a page a board meant to arrange.
             */}
            {CALENDAR_COUNTS.map((one) => (
              <option key={one} value={String(one)}>
                {one}
              </option>
            ))}
          </select>
          <span className={HINT}>{t("siteAdmin.editor.calendarHint")}</span>
        </label>
      );
    }
    case "documentList": {
      const category = (block as { category?: string }).category;
      return (
        <label className={LABEL}>
          {t("siteAdmin.editor.documentBinder")}
          <input
            className={FIELD}
            maxLength={PAGE_CONTENT_LIMITS.category}
            value={category ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              /*
               * An emptied field is no binder rather than a binder named "".
               * The API stores it the same way; keeping the two in step here is
               * what makes the field read back as the board left it after a
               * save.
               */
              onBlock(
                next.trim() === ""
                  ? { type: "documentList" }
                  : { type: "documentList", category: next },
              );
            }}
          />
          <span className={HINT}>
            {t("siteAdmin.editor.documentBinderHint")}
          </span>
        </label>
      );
    }
    default: {
      const key = NOTHING_TO_SET[block.type];
      return (
        <p className={HINT}>{t(key ?? "siteAdmin.editor.settings.nothing")}</p>
      );
    }
  }
}
