import { describe, expect, it, vi } from "vite-plus/test";

import { z } from "zod";

import { PluginExtensionsService } from "./plugin-extensions.service";
import { PluginHostBinder } from "./plugin-host.binder";

/** One loaded plugin, as the loader lists it, with what its factory buffered. */
interface LoadedDouble {
  id: string;
  manifest: {
    actions: unknown[];
    blocks: unknown[];
    extensionPoints?: unknown[];
    extends?: unknown[];
  };
  context: {
    serving: boolean;
    bufferedActions: unknown[];
    bufferedBlocks: unknown[];
    bufferedExtensionPoints?: unknown[];
    bufferedContributions?: unknown[];
  };
}

/**
 * A binder over the loaded plugins, with the registries it writes to spied on.
 * `onRefuse` stands in for the loader's side of a refusal.
 */
function binderFor(
  plugins: LoadedDouble | LoadedDouble[],
  extensions: object = { bindLiveness: vi.fn() },
  onRefuse: (id: string, loaded: LoadedDouble[]) => void = () => undefined,
) {
  const registerFor = vi.fn();
  const registerPlugin = vi.fn();
  const refuse = vi.fn((id: string) => onRefuse(id, loaded));
  const loaded = [plugins].flat().map((plugin) => ({
    ...plugin,
    manifest: { extensionPoints: [], extends: [], ...plugin.manifest },
    context: {
      bufferedExtensionPoints: [],
      bufferedContributions: [],
      ...plugin.context,
    },
  }));
  const binder = new PluginHostBinder(
    { bind: vi.fn() } as never,
    {} as never,
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
    { list: () => loaded, refuse } as never,
    { registerPlugin } as never,
    extensions as never,
    {} as never,
    {} as never,
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

/**
 * The schemas a host plugin defined and the handlers an addon contributed
 * (ADR 0030), as the binder hands them to the service that carries calls.
 */
describe("flushing a plugin's extension points and contributions", () => {
  const point = { id: "source", version: 1, personalData: [] };
  const extension = {
    plugin: "signage",
    point: "source",
    version: 1,
    personalData: [],
  };
  const schemas = {
    input: z.strictObject({}),
    output: z.strictObject({ title: z.string() }),
  };

  function host(definitions: unknown[]): LoadedDouble {
    return {
      id: "signage",
      manifest: { actions: [], blocks: [], extensionPoints: [point] },
      context: {
        serving: true,
        bufferedActions: [],
        bufferedBlocks: [],
        bufferedExtensionPoints: definitions,
      },
    };
  }

  function addon(contributions: unknown[]): LoadedDouble {
    return {
      id: "signage-weather",
      manifest: { actions: [], blocks: [], extends: [extension] },
      context: {
        serving: true,
        bufferedActions: [],
        bufferedBlocks: [],
        bufferedContributions: contributions,
      },
    };
  }

  it("defines a declared point", () => {
    const extensions = new PluginExtensionsService();
    const { binder, refuse } = binderFor(
      host([{ point: "source", definition: schemas }]),
      extensions,
    );

    binder.bind();

    expect(refuse).not.toHaveBeenCalled();
    expect(extensions.list("signage", "source")).toEqual([]);
  });

  it("refuses the plugin for a point its manifest does not declare", () => {
    const { binder, refuse } = binderFor(
      host([{ point: "weather", definition: schemas }]),
      new PluginExtensionsService(),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith("signage", "extension-refused", {
      extensions: ["weather"],
    });
  });

  it("refuses the plugin for a schema that strips unknown keys", () => {
    const { binder, refuse } = binderFor(
      host([
        {
          point: "source",
          definition: { ...schemas, output: z.object({ title: z.string() }) },
        },
      ]),
      new PluginExtensionsService(),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith("signage", "extension-refused", {
      extensions: ["source"],
    });
  });

  it("refuses an addon contributing to a point its manifest does not extend", () => {
    const { binder, refuse } = binderFor(
      addon([
        {
          target: { plugin: "signage", point: "weather" },
          contribution: { titleKey: "title", handler: async () => ({}) },
        },
      ]),
      new PluginExtensionsService(),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith(
      "signage-weather",
      "extension-refused",
      { extensions: ["signage/weather"] },
    );
  });

  it("skips an addon that stopped with its host plugin in the same pass", () => {
    const extensions = new PluginExtensionsService();
    const contribute = vi.spyOn(extensions, "contribute");
    const hostPlugin = host([{ point: "weather", definition: schemas }]);
    const addonPlugin = addon([
      {
        target: { plugin: "signage", point: "source" },
        contribution: { titleKey: "title", handler: async () => ({}) },
      },
    ]);
    const { binder, refuse } = binderFor(
      [hostPlugin, addonPlugin],
      extensions,
      // The loader stops every addon of a host plugin it refuses.
      (id, loaded) => {
        if (id === "signage") {
          for (const plugin of loaded) {
            if (plugin.id === "signage-weather") {
              plugin.context.serving = false;
            }
          }
        }
      },
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledTimes(1);
    expect(refuse).toHaveBeenCalledWith("signage", "extension-refused", {
      extensions: ["weather"],
    });
    expect(contribute).not.toHaveBeenCalled();
  });

  it("refuses an addon contributing twice to one point", () => {
    const contribution = {
      target: { plugin: "signage", point: "source" },
      contribution: { titleKey: "title", handler: async () => ({}) },
    };
    const { binder, refuse } = binderFor(
      addon([contribution, contribution]),
      new PluginExtensionsService(),
    );

    binder.bind();

    expect(refuse).toHaveBeenCalledWith(
      "signage-weather",
      "extension-refused",
      { extensions: ["signage/source"] },
    );
  });
});
