/**
 * Which installed plugins serve the plugin access class today (ADR 0053).
 *
 * The board grants an access only to a plugin that declares `pluginAccess`
 * among its `nonResidentCallers` and whose install consented to that class
 * without withdrawing it since. Those two facts are the plugin system's: the
 * loaded manifest and the classes recorded with the install. So this module
 * asks for them through this token and decides nothing about them itself.
 * `PluginsModule` binds it, to `PluginAccessClassService`.
 */
export interface PluginAccessClass {
  /** The ids of the installed plugins a plugin access can be granted to. */
  pluginsServingAccess(): Promise<ReadonlySet<string>>;
}

export const PLUGIN_ACCESS_CLASS = Symbol("PLUGIN_ACCESS_CLASS");
