import { describe, expect, it, vi } from "vitest";

import { PluginHostBinder } from "./plugin-host.binder";

/**
 * The actions a plugin's module factory declared, as the binder hands them to
 * the registry.
 */
describe("flushing a plugin's actions", () => {
  it("puts an alias in the plugin's own namespace, as its name is", () => {
    const registerFor = vi.fn();
    const binder = new PluginHostBinder(
      { bind: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { registerFor, bindLiveness: vi.fn() } as never,
      {} as never,
      {
        list: () => [
          {
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
            },
            context: {
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
            },
          },
        ],
      } as never,
    );

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
