import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The extension point an addon is answering, held for the length of the
 * handler's work (ADR 0035).
 *
 * A host plugin's processing can be objected to although it reads nothing
 * from the register itself, so the host carries the objection out where the
 * data comes from: what an addon reads while it answers the host plugin is
 * what it hands the host plugin. {@link PluginExtensionsService.invoke} runs
 * the handler inside this scope and {@link PluginAddressBookService} reads it,
 * so every read the handler makes, however deep in the addon's own code,
 * leaves out the host plugin's objectors as well as the addon's, without the
 * addon having to pass anything on.
 *
 * The scope ends when the handler settles. Work the handler left running
 * keeps its place in the async context, so the scope is closed by a flag the
 * reads check, not by leaving it: a read made after the answer is given hands
 * the host plugin nothing.
 *
 * One host plugin is enough: an addon declares no extension points, so it
 * never calls another addon while it answers.
 */
interface ExtensionCall {
  readonly hostPlugin: string;
  readonly addon: string;
  active: boolean;
}

const storage = new AsyncLocalStorage<ExtensionCall>();

/** Runs `work` as the addon's answer to a call from `hostPlugin`. */
export async function runForExtensionCall<T>(
  hostPlugin: string,
  addon: string,
  work: () => T | PromiseLike<T>,
): Promise<T> {
  const call: ExtensionCall = { hostPlugin, addon, active: true };
  return storage.run(call, async () => {
    try {
      return await work();
    } finally {
      call.active = false;
    }
  });
}

/**
 * The host plugin `pluginId` is answering, or null.
 *
 * Null for any other plugin whose code runs inside the scope, such as a
 * listener the addon's work set off: only what the addon reads goes to the
 * host plugin. Null as well once the handler has settled, for work it left
 * running.
 */
export function extensionHostOf(pluginId: string): string | null {
  const call = storage.getStore();
  return call?.active === true && call.addon === pluginId
    ? call.hostPlugin
    : null;
}
