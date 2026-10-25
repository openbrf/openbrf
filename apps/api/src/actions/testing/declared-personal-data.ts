import type {
  ActionRegistryService,
  PluginLiveness,
} from "../action-registry.service";

/**
 * Has the registry read a plugin no package backs as declaring `personalData`,
 * for a suite that builds a plugin's caller with `ActionCallerFactory.forPlugin`
 * rather than loading a plugin. The registry reads a plugin it cannot find as
 * declaring nothing, and refuses it every action that handles personal data.
 *
 * Every other plugin is still looked up as before. Returns what puts the
 * registry's own lookup back.
 */
export function declarePersonalData(
  registry: ActionRegistryService,
  pluginId: string,
  personalData: readonly string[],
): () => void {
  const internals = registry as unknown as { liveness: PluginLiveness | null };
  const previous = internals.liveness;
  registry.bindLiveness({
    get: async (id) =>
      id === pluginId
        ? { serving: true, armedActions: [], capabilityFloor: [], personalData }
        : ((await previous?.get(id)) ?? null),
  });
  return () => {
    internals.liveness = previous;
  };
}
