import { Injectable, Logger } from "@nestjs/common";
import {
  type BlockDefinition,
  type BlockRegistry,
  CORE_BLOCKS,
  createBlockRegistry,
  type PluginBlockDeclaration,
  pluginBlockDefinition,
  readPluginBlockSettings,
} from "@openbrf/shared";
import {
  PLUGIN_BLOCK_RENDER_TIMEOUT_MS,
  type PluginBlockRegistration,
} from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { failureFrames, failureName } from "../logging/failure";
import {
  type ContentSchema,
  contentSchemaFor,
  type PageContent,
  submittedContent,
} from "./page-content";
import {
  readPluginBlockOutput,
  type SiteBlockNode,
} from "./plugin-block-output";

/**
 * The website's block types, the plugins' among them.
 *
 * The core's blocks are a constant (PAGE_BLOCKS). A plugin's are not: they are
 * registered when the application starts, from what each serving plugin's
 * manifest declares and its module factory registers, and they leave the
 * moment the board switches the plugin off or removes it. This holds them, and
 * answers the questions that depend on which are serving: what the editor may
 * offer, what the write path accepts, and what a plugin's block on a page
 * renders as.
 *
 * Reading a page does not depend on it. A stored body is read by the total
 * reader against the core's registry, where a plugin's block is a namespaced
 * block kept exactly as stored (ADR 0006), so a page reads the same whether
 * its plugin is serving or not; whether the block then shows anything is
 * decided here, as the page is rendered.
 *
 * Registered into by the plugin binder (src/plugins), which is why this
 * module imports nothing from there: the website may not reach the register,
 * and the plugin system does.
 */

/** One plugin's block, as it was registered. */
export interface RegisteredSiteBlock {
  declaration: PluginBlockDeclaration;
  render: PluginBlockRegistration["render"];
}

interface PluginEntry {
  /** Read at the moment of every question, as dispatch reads it. */
  serving: () => boolean;
  blocks: readonly RegisteredSiteBlock[];
}

/** What renderPage needs to know about the page being rendered. */
export interface SiteBlockRenderContext {
  locale: string;
  t: TFunction;
}

const TIMED_OUT = Symbol("timed out");

@Injectable()
export class SiteBlocksService {
  private readonly logger = new Logger(SiteBlocksService.name);
  private readonly plugins = new Map<string, PluginEntry>();
  private cached: {
    key: string;
    registry: BlockRegistry<BlockDefinition>;
    schema: ContentSchema;
  } | null = null;

  /**
   * Registers what one plugin declared and registered a renderer for.
   *
   * Throws when the declarations cannot join the registry - a type id of the
   * wrong shape, or one already claimed - which the binder answers by
   * refusing the plugin. Nothing is registered then.
   */
  registerPlugin(
    pluginId: string,
    serving: () => boolean,
    blocks: readonly RegisteredSiteBlock[],
  ): void {
    const others = [...this.plugins.entries()]
      .filter(([id]) => id !== pluginId)
      .flatMap(([, entry]) => entry.blocks);
    createBlockRegistry([
      ...CORE_BLOCKS,
      ...[...others, ...blocks].map((block) =>
        pluginBlockDefinition(block.declaration),
      ),
    ]);
    this.plugins.set(pluginId, { serving, blocks });
    this.cached = null;
  }

  /** Forgets a plugin's blocks: switched off, refused or removed. */
  unregisterPlugin(pluginId: string): void {
    if (this.plugins.delete(pluginId)) {
      this.cached = null;
    }
  }

  /**
   * The blocks of every serving plugin, as the editor is told about them.
   *
   * In plugin id order and then in the order each manifest declares them, so
   * the editor offers them in the same order on every visit.
   */
  declarations(): PluginBlockDeclaration[] {
    return this.serving().map((block) => block.declaration);
  }

  /** The core's blocks and every serving plugin's. */
  registry(): BlockRegistry<BlockDefinition> {
    return this.current().registry;
  }

  /**
   * A submitted body, held to every registered type.
   *
   * A serving plugin's block is held to its declared settings, and refused
   * with the path of the setting that is wrong. A block of a plugin that is
   * not serving is kept as stored, as it always was.
   */
  submittedContent(value: unknown): PageContent {
    return submittedContent(value, this.current().schema);
  }

  /**
   * What each serving plugin's block on a page renders as, by its position.
   *
   * Every block is rendered at the same time, and each one that throws, takes
   * longer than PLUGIN_BLOCK_RENDER_TIMEOUT_MS, or answers with something the
   * website will not print is left out of the map and logged with the
   * plugin's id. The page is rendered without it, and with everything else:
   * one plugin's fault hides one block and never the page.
   */
  async renderPage(
    content: PageContent,
    context: SiteBlockRenderContext,
  ): Promise<ReadonlyMap<number, readonly SiteBlockNode[]>> {
    const byType = new Map<
      string,
      { pluginId: string; block: RegisteredSiteBlock }
    >();
    for (const [pluginId, entry] of this.plugins) {
      if (!entry.serving()) {
        continue;
      }
      for (const block of entry.blocks) {
        byType.set(block.declaration.type, { pluginId, block });
      }
    }

    const rendered = await Promise.all(
      content.blocks.map(async (block, index) => {
        const found = byType.get(block.type);
        if (found === undefined) {
          return null;
        }
        const nodes = await this.renderOne(
          found.pluginId,
          found.block,
          (block as { settings?: unknown }).settings,
          context,
        );
        return nodes === null ? null : ([index, nodes] as const);
      }),
    );

    return new Map(
      rendered.filter(
        (entry): entry is readonly [number, SiteBlockNode[]] => entry !== null,
      ),
    );
  }

  private async renderOne(
    pluginId: string,
    block: RegisteredSiteBlock,
    stored: unknown,
    { locale, t }: SiteBlockRenderContext,
  ): Promise<SiteBlockNode[] | null> {
    const { type, fields } = block.declaration;
    const settings = readPluginBlockSettings(fields, stored);
    if (settings === null) {
      // The plugin changed what its block takes since the board set it up.
      // The editor shows the block with its form; the board sets it again.
      this.logger.warn(
        `Plugin "${pluginId}" block "${type}" holds settings its declaration refuses; it is left off the page.`,
      );
      return null;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMED_OUT);
      }, PLUGIN_BLOCK_RENDER_TIMEOUT_MS);
    });

    try {
      // Started inside a promise, so a render that throws before it returns
      // one is a rejection here like any other.
      const answer = await Promise.race([
        Promise.resolve().then(async () =>
          block.render({
            type,
            settings,
            locale,
            t: (key, values) =>
              String(t(`plugin-${pluginId}:${key}`, { ...values })),
            signal: controller.signal,
          }),
        ),
        timeout,
      ]);
      if (answer === TIMED_OUT) {
        controller.abort();
        this.logger.error(
          `Plugin "${pluginId}" block "${type}" did not render within ${String(PLUGIN_BLOCK_RENDER_TIMEOUT_MS)} ms; it is left off the page.`,
        );
        return null;
      }
      const output = readPluginBlockOutput(answer);
      if (!output.ok) {
        // The reason and never the content: what was refused may be exactly
        // what must not be repeated, a personal identity number above all.
        this.logger.error(
          `Plugin "${pluginId}" block "${type}" rendered something the website does not print (${output.refusal}); it is left off the page.`,
        );
        return null;
      }
      return output.nodes;
    } catch (cause) {
      this.logger.error(
        `Plugin "${pluginId}" block "${type}" failed to render; it is left off the page (${failureName(cause)})`,
        failureFrames(cause),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private serving(): RegisteredSiteBlock[] {
    return [...this.plugins.entries()]
      .filter(([, entry]) => entry.serving())
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, entry]) => entry.blocks);
  }

  /**
   * The registry and its schema for the plugins serving right now.
   *
   * Kept until the set changes, which it does when a plugin is switched off
   * as well as when one is registered: serving is read rather than told, so
   * the key is what is serving now and not what was last registered.
   */
  private current(): NonNullable<SiteBlocksService["cached"]> {
    const serving = this.serving();
    const key = serving.map((block) => block.declaration.type).join("\n");
    if (this.cached?.key !== key) {
      const registry = createBlockRegistry<BlockDefinition>([
        ...CORE_BLOCKS,
        ...serving.map((block) => pluginBlockDefinition(block.declaration)),
      ]);
      this.cached = { key, registry, schema: contentSchemaFor(registry) };
    }
    return this.cached;
  }
}
