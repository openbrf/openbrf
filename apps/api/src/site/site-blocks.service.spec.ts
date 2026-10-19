import { PLUGIN_BLOCK_RENDER_TIMEOUT_MS } from "@openbrf/plugin-sdk";
import type { PluginBlockDeclaration } from "@openbrf/shared";
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ZodError } from "zod";

import type { PageContent } from "./page-content";
import {
  type RegisteredSiteBlock,
  SiteBlocksService,
} from "./site-blocks.service";

/**
 * The website's block types once plugins add to them: what the editor is
 * offered, what a save is held to, and - the part a visitor depends on - that
 * a plugin's failure hides its own block and nothing else.
 */

function declaration(
  pluginId: string,
  name: string,
  fields: PluginBlockDeclaration["fields"] = [],
): PluginBlockDeclaration {
  return {
    type: `${pluginId}/${name}`,
    pluginId,
    labelKey: `blocks.${name}`,
    icon: "plugin",
    category: "association",
    fields,
  };
}

const COUNT_FIELD: PluginBlockDeclaration["fields"] = [
  {
    key: "count",
    labelKey: "blocks.count",
    type: "number",
    required: false,
    integer: true,
    min: 1,
    max: 5,
    default: 2,
  },
];

function block(
  pluginId: string,
  name: string,
  render: RegisteredSiteBlock["render"],
  fields?: PluginBlockDeclaration["fields"],
): RegisteredSiteBlock {
  return { declaration: declaration(pluginId, name, fields), render };
}

function page(...blocks: PageContent["blocks"]): PageContent {
  return { version: 1, blocks };
}

/** Answers with the key it was asked for, and the count when it was given one. */
const t = vi.fn((key: string, values?: { count?: number }) =>
  values?.count === undefined ? key : `${key}:${String(values.count)}`,
) as unknown as TFunction;

const CONTEXT = { locale: "sv", t };

afterEach(() => {
  vi.useRealTimers();
});

describe("which plugin blocks there are", () => {
  it("offers the blocks of the plugins that are serving, in plugin order", () => {
    const service = new SiteBlocksService();
    let pollsServing = true;
    service.registerPlugin("polls", () => pollsServing, [
      block("polls", "poll", () => null),
    ]);
    service.registerPlugin("laundry", () => true, [
      block("laundry", "schedule", () => null),
    ]);

    expect(service.declarations().map((one) => one.type)).toEqual([
      "laundry/schedule",
      "polls/poll",
    ]);

    // Switched off is read rather than told, so it bites at once.
    pollsServing = false;
    expect(service.declarations().map((one) => one.type)).toEqual([
      "laundry/schedule",
    ]);

    service.unregisterPlugin("laundry");
    expect(service.declarations()).toEqual([]);
  });

  it("refuses a block type already claimed", () => {
    const service = new SiteBlocksService();

    expect(() => {
      service.registerPlugin("polls", () => true, [
        block("polls", "poll", () => null),
        block("polls", "poll", () => null),
      ]);
    }).toThrow(/registered twice/);
    expect(service.declarations()).toEqual([]);
  });
});

describe("a save, with a plugin's block on the page", () => {
  it("holds a serving plugin's block to its settings", () => {
    const service = new SiteBlocksService();
    service.registerPlugin("counters", () => true, [
      block("counters", "counter", () => null, COUNT_FIELD),
    ]);

    expect(
      service.submittedContent({
        blocks: [{ type: "counters/counter", settings: { count: 3 } }],
      }).blocks,
    ).toEqual([{ type: "counters/counter", settings: { count: 3 } }]);

    let refusal: unknown;
    try {
      service.submittedContent({
        blocks: [{ type: "counters/counter", settings: { count: 9 } }],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ZodError);
    expect((refusal as ZodError).issues[0]?.path).toEqual([
      "blocks",
      0,
      "settings",
      "count",
    ]);
  });

  it("keeps the block of a plugin that is switched off, as stored", () => {
    const service = new SiteBlocksService();
    service.registerPlugin("counters", () => false, [
      block("counters", "counter", () => null, COUNT_FIELD),
    ]);

    expect(
      service.submittedContent({
        blocks: [{ type: "counters/counter", settings: { count: 9 } }],
      }).blocks,
    ).toEqual([{ type: "counters/counter", settings: { count: 9 } }]);
  });
});

describe("rendering a page's plugin blocks", () => {
  it("renders each block by its position, with its settings and the reader's language", async () => {
    const service = new SiteBlocksService();
    const render = vi.fn<RegisteredSiteBlock["render"]>(
      ({ settings, t: translate }) => ({
        tag: "p",
        children: [
          translate("blocks.shown", { count: settings["count"] as number }),
        ],
      }),
    );
    service.registerPlugin("counters", () => true, [
      block("counters", "counter", render, COUNT_FIELD),
    ]);

    const rendered = await service.renderPage(
      page(
        { type: "paragraph", runs: [{ text: "Hej" }] },
        { type: "counters/counter", settings: {} },
      ),
      CONTEXT,
    );

    expect([...rendered.entries()]).toEqual([
      [1, [{ tag: "p", children: ["plugin-counters:blocks.shown:2"] }]],
    ]);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "counters/counter",
        settings: { count: 2 },
        locale: "sv",
      }),
    );
  });

  it("hides only the block whose renderer throws", async () => {
    const service = new SiteBlocksService();
    service.registerPlugin("broken", () => true, [
      block("broken", "fails", () => {
        throw new Error("the plugin's own words");
      }),
      block("broken", "rejects", async () => Promise.reject(new Error("no"))),
    ]);
    service.registerPlugin("fine", () => true, [
      block("fine", "works", () => "shown"),
    ]);

    const rendered = await service.renderPage(
      page(
        { type: "broken/fails", settings: {} },
        { type: "fine/works", settings: {} },
        { type: "broken/rejects", settings: {} },
      ),
      CONTEXT,
    );

    expect([...rendered.entries()]).toEqual([[1, ["shown"]]]);
  });

  it("stops waiting for a block that takes too long, and tells it so", async () => {
    vi.useFakeTimers();
    const service = new SiteBlocksService();
    let signal: AbortSignal | undefined;
    service.registerPlugin("slow", () => true, [
      block("slow", "hangs", (context) => {
        signal = context.signal as AbortSignal;
        return new Promise(() => undefined);
      }),
    ]);
    service.registerPlugin("fine", () => true, [
      block("fine", "works", () => "shown"),
    ]);

    const rendering = service.renderPage(
      page(
        { type: "slow/hangs", settings: {} },
        { type: "fine/works", settings: {} },
      ),
      CONTEXT,
    );
    await vi.advanceTimersByTimeAsync(PLUGIN_BLOCK_RENDER_TIMEOUT_MS);
    const rendered = await rendering;

    expect([...rendered.entries()]).toEqual([[1, ["shown"]]]);
    expect(signal?.aborted).toBe(true);
  });

  it("hides a block whose answer the website does not print", async () => {
    const service = new SiteBlocksService();
    service.registerPlugin("leaky", () => true, [
      block("leaky", "names", () => ({
        tag: "p",
        children: ["19121212-1212"],
      })),
    ]);

    const rendered = await service.renderPage(
      page({ type: "leaky/names", settings: {} }),
      CONTEXT,
    );

    expect(rendered.size).toBe(0);
  });

  it("renders nothing for a plugin that is switched off or not registered", async () => {
    const service = new SiteBlocksService();
    const render = vi.fn(() => "shown");
    service.registerPlugin("counters", () => false, [
      block("counters", "counter", render),
    ]);

    const rendered = await service.renderPage(
      page(
        { type: "counters/counter", settings: {} },
        { type: "removed/block", settings: {} },
      ),
      CONTEXT,
    );

    expect(rendered.size).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });

  it("does not call a renderer with settings its declaration refuses", async () => {
    const service = new SiteBlocksService();
    const render = vi.fn(() => "shown");
    service.registerPlugin("counters", () => true, [
      block("counters", "counter", render, COUNT_FIELD),
    ]);

    const rendered = await service.renderPage(
      page({ type: "counters/counter", settings: { count: 99 } }),
      CONTEXT,
    );

    expect(rendered.size).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});
