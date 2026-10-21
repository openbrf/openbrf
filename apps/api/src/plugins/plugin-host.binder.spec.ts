import { describe, expect, it, vi } from "vite-plus/test";

import { PluginHostBinder } from "./plugin-host.binder";

/** One loaded plugin, as the loader lists it, with what its factory buffered. */
interface LoadedDouble {
  id: string;
  manifest: { actions: unknown[]; blocks: unknown[] };
  context: {
    serving: boolean;
    bufferedActions: unknown[];
    bufferedBlocks: unknown[];
  };
}

/** A binder over one loaded plugin, with the registries it writes to spied on. */
function binderFor(plugin: LoadedDouble) {
  const registerFor = vi.fn();
  const registerPlugin = vi.fn();
  const refuse = vi.fn();
  const binder = new PluginHostBinder(
    { bind: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { bindServing: vi.fn() } as never,
    { registerFor, bindLiveness: vi.fn() } as never,
    {} as never,
    { list: () => [plugin], refuse } as never,
    { registerPlugin } as never,
  );
  return { binder, registerFor, registerPlugin, refuse };
}

/** A plugin that declares one website block, `counter`. */
function blockPlugin(bufferedBlocks: unknown[]): LoadedDouble {
  return {
    id: "counters",
    manifest: {
      actions: [],
      blocks: [
        {
          name: "counter",
          labelKey: "blocks.counter",
          icon: "facts",
          category: "association",
          settingsSchema: { fields: [] },
        },
      ],
    },
    context: { serving: true, bufferedActions: [], bufferedBlocks },
  };
}

/**
 * The actions a plugin's module factory declared, as the binder hands them to
 * the registry.
 */
describe("flushing a plugin's actions", () => {
  it("puts an alias in the plugin's own namespace, as its name is", () => {
    const { binder, registerFor } = binderFor({
      id: "occupancy",
      manifest: {
        actions: [
          {
            id: "summary",
            capability: "self:manage",
            effect: "read",
            personalData: [],
            surfaces: [],
          },
        ],
        blocks: [],
      },
      context: {
        serving: true,
        bufferedActions: [
          {
            id: "summary",
            definition: {
              name: "summary",
              // A core action's name, which a core registrar would then
              // find taken.
              deprecatedAliases: ["news_delete"],
            },
          },
        ],
        bufferedBlocks: [],
      },
    });

    binder.bind();

    expect(registerFor).toHaveBeenCalledWith(
      "occupancy",
      expect.objectContaining({
        definition: expect.objectContaining({
          name: "occupancy_summary",
          deprecatedAliases: ["occupancy_news_delete"],
        }) as unknown,
      }),
      expect.anything(),
    );
  });
});

/** The website blocks a plugin's module factory gave render functions for. */
describe("flushing a plugin's website blocks", () => {
  it("registers a declared block under its composed type id", () => {
    const render = vi.fn(() => "rendered");
    const { binder, registerPlugin, refuse } = binderFor(
      blockPlugin([{ name: "counter", render }]),
    );

    binder.bind();

    expect(refuse).not.toHaveBeenCalled();
    expect(registerPlugin).toHaveBeenCalledWith(
      "counters",
      expect.any(Function),
      [
        expect.objectContaining({
          declaration: {
            type: "counters/counter",
            pluginId: "counters",
            labelKey: "blocks.counter",
            icon: "facts",
            category: "association",
            fields: [],
          },
        }),
      ],
    );
    const [, serving, blocks] = registerPlugin.mock.calls[0] as [
      string,
      () => boolean,
      { render: (context: unknown) => unknown }[],
    ];
    expect(serving()).toBe(true);
    expect(blocks[0]?.render({})).toBe("rendered");
  });

  it("refuses the plugin for a block its manifest does not declare", () => {
    const { binder, registerPlugin, refuse } = binderFor(
      blockPlugin([{ name: "poll", render: () => null }]),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith("counters", "block-refused", {
      blocks: ["poll"],
    });
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("refuses the plugin for a block registered twice", () => {
    const { binder, refuse } = binderFor(
      blockPlugin([
        { name: "counter", render: () => null },
        { name: "counter", render: () => null },
      ]),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith("counters", "block-refused", {
      blocks: ["counter"],
    });
  });

  it("leaves out a declared block nobody gave a render function", () => {
    const { binder, registerPlugin, refuse } = binderFor(blockPlugin([]));

    binder.bind();

    expect(refuse).not.toHaveBeenCalled();
    expect(registerPlugin).toHaveBeenCalledWith(
      "counters",
      expect.any(Function),
      [],
    );
  });
});
