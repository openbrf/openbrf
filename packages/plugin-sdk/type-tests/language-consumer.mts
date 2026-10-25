// A render function compiled against the language alone, with neither the DOM
// library nor Node's types. Its program has no `AbortSignal` to take, so the
// signal is the part of one that every platform's has.
import type {
  PluginBlockContent,
  PluginBlockRenderContext,
  PluginHost,
  PluginInstanceFacts,
  PluginMediaFile,
} from "../src/index.ts";

export function render(context: PluginBlockRenderContext): PluginBlockContent {
  const stop = (): void => undefined;
  context.signal.addEventListener("abort", stop);
  context.signal.removeEventListener("abort", stop);
  // @ts-expect-error Without the platform's types there is no `reason` to read.
  void context.signal.reason;
  return context.signal.aborted ? null : "rendered";
}

// A picture read against the language alone: the stream is the part of one
// every platform's has, and its chunks are bytes.
export async function firstChunk(
  file: PluginMediaFile,
): Promise<Uint8Array | undefined> {
  const reader = file.stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  // @ts-expect-error Without the platform's types there is no `pipeTo`.
  void file.stream.pipeTo;
  return value;
}

// The instance a plugin introduces to a screen. An older host has no
// `instance`, and the type makes a plugin say what it does then.
export async function introduction(
  host: PluginHost,
): Promise<PluginInstanceFacts | null> {
  // @ts-expect-error `instance` may be absent: an older host has none.
  void host.instance.read;
  if (host.instance === undefined) {
    return null;
  }
  const facts = await host.instance.read();
  const origin: string = facts.origin;
  // @ts-expect-error The name is null on an instance not set up yet.
  const name: string = facts.name;
  void origin;
  void name;
  return facts;
}
