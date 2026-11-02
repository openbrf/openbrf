/**
 * Which installed plugins serve the plugin access class today (ADR 0053).
 *
 * The board grants an access only to a plugin that declares `pluginAccess`
 * among its `nonResidentCallers` and whose install consented to that class
 * without withdrawing it since. Those two facts are the plugin system's: the
 * loaded manifest and the classes recorded with the install. So this module
 * asks for them through this token and decides nothing about them itself.
 *
 * The binding below serves no plugin, so until the plugin system binds the
 * real answer, every grant is refused as `plugin-access-not-served` and the
 * picker offers nothing. It fails closed: a grant made before the install's
 * consent to the class could be read would widen whom a plugin serves past
 * what the administrator consented to.
 */
export interface PluginAccessClass {
  /** The ids of the installed plugins a plugin access can be granted to. */
  pluginsServingAccess(): Promise<ReadonlySet<string>>;
}

export const PLUGIN_ACCESS_CLASS = Symbol("PLUGIN_ACCESS_CLASS");

/** The binding until the install's consent to the class is recorded. */
export const NO_PLUGIN_SERVES_ACCESS: PluginAccessClass = {
  pluginsServingAccess: () => Promise.resolve(new Set<string>()),
};
