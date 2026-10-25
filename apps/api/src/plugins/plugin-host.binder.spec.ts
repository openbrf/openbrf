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
  /** The floor the loader sealed its routes with. */
  routeFloor?: readonly string[];
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
  const bindActionLiveness = vi.fn();
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
    // Consented to nothing, so a floor read from the permissions would be
    // self:manage whatever the loader sealed the routes with.
    {
      find: async () => ({ armedActions: [], consentedPermissions: [] }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { bindServing: vi.fn() } as never,
    { registerFor, bindLiveness: bindActionLiveness } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      list: () => loaded,
      get: (id: string) => loaded.find((plugin) => plugin.id === id) ?? null,
      refuse,
    } as never,
    { registerPlugin } as never,
    {} as never,
    extensions as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { binder, registerFor, bindActionLiveness, registerPlugin, refuse };
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

/**
 * The floor the action registry holds a plugin's actions to, which is the one
 * its routes were sealed with (ADR 0052). A host plugin that reads nothing,
 * joined to an addon that reads the register, could otherwise answer an
 * action with a name its routes would refuse to the same caller.
 */
describe("the floor of a plugin's actions", () => {
  it("is the floor the loader sealed its routes with, not its own permissions'", async () => {
    const { binder, bindActionLiveness } = binderFor({
      id: "signage",
      manifest: { actions: [], blocks: [] },
      context: { serving: true, bufferedActions: [], bufferedBlocks: [] },
      routeFloor: ["addressBook:read"],
    });

    binder.bind();

    const [liveness] = bindActionLiveness.mock.calls[0] as [
      { get: (pluginId: string) => Promise<unknown> },
    ];
    await expect(liveness.get("signage")).resolves.toMatchObject({
      serving: true,
      capabilityFloor: ["addressBook:read"],
    });
  });
});
