import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { emptyPluginBoot, type BootPlugin } from "./plugin-boot";
import { PluginLoaderService } from "./plugin-loader.service";

/**
 * An addon exists for the plugin it extends (ADR 0030): when the host plugin
 * stops serving - switched off, removed, or refused after it loaded - every
 * addon of it stops with it, says why, and takes back what it registered.
 */

function loaded(id: string, extendsIds: string[] = []): BootPlugin {
  return {
    id,
    manifest: {
      extends: extendsIds.map((plugin) => ({
        plugin,
        point: "source",
        version: 1,
        personalData: [],
      })),
    },
    directory: `/data/plugins/node_modules/${id}`,
    context: { serving: true },
  } as unknown as BootPlugin;
}

function loaderOver(plugins: BootPlugin[]) {
  const boot = emptyPluginBoot();
  boot.plugins.push(...plugins);
  const unregisterOwner = vi.fn();
  const unregisterBlocks = vi.fn();
  const unregisterExtensions = vi.fn();
  const loader = new PluginLoaderService(
    boot,
    {} as never,
    { unregisterOwner } as never,
    { unregisterPlugin: unregisterBlocks } as never,
    { unregisterPlugin: unregisterExtensions } as never,
  );
  return { loader, unregisterOwner, unregisterExtensions };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginLoaderService.unload", () => {
  it("stops every addon of a host plugin that stops", () => {
    const signage = loaded("signage");
    const residents = loaded("signage-residents", ["signage"]);
    const weather = loaded("signage-weather", ["signage"]);
    const unrelated = loaded("occupancy");
    const { loader, unregisterOwner, unregisterExtensions } = loaderOver([
      signage,
      residents,
      weather,
      unrelated,
    ]);

    loader.unload("signage");

    expect(loader.list().map((plugin) => plugin.id)).toEqual(["occupancy"]);
    expect(residents.context.serving).toBe(false);
    expect(weather.context.serving).toBe(false);
    expect(unrelated.context.serving).toBe(true);
    // Each takes back its actions and its contributions as it stops.
    expect(unregisterOwner).toHaveBeenCalledWith({
      kind: "plugin",
      pluginId: "signage-residents",
    });
    expect(unregisterExtensions).toHaveBeenCalledWith("signage-weather");
  });

  it("says why on the admin screen, naming the host plugin", () => {
    const { loader } = loaderOver([
      loaded("signage"),
      loaded("signage-residents", ["signage"]),
    ]);

    loader.unload("signage");

    expect(loader.report()).toEqual([
      {
        id: "signage-residents",
        directory: "/data/plugins/node_modules/signage-residents",
        reason: "extension-host-missing",
        detail: { plugin: "signage" },
      },
    ]);
    // Dormant rather than forgotten, so its settings form is still drawn.
    expect(loader.manifestFor("signage-residents")).not.toBeNull();
  });

  it("leaves the host plugin serving when an addon stops", () => {
    const signage = loaded("signage");
    const { loader } = loaderOver([
      signage,
      loaded("signage-residents", ["signage"]),
    ]);

    loader.unload("signage-residents");

    expect(signage.context.serving).toBe(true);
    expect(loader.report()).toEqual([]);
  });
});
