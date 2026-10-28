import type { PluginRecord } from "./plugin-registry.service";

/**
 * Whether the board has consented to the resident routes a plugin declares
 * (ADR 0051).
 *
 * A resident route lets a listed resident reach a plugin that reads the
 * register, so the plugin's author may not decide it: the board decides it, on
 * the consent screen and with `openbrf plugin add`, and the install records
 * what it consented to. That consent, its screen and its record are not built
 * yet, so nothing counts as consented and the host lowers no resident route.
 * Every route the manifest declares keeps the plugin's full floor. Once the
 * install records the consented resident routes, this compares the declaration
 * with them, as the device routes are compared with theirs.
 */
export function residentRoutesConsented(_record: PluginRecord): boolean {
  return false;
}
