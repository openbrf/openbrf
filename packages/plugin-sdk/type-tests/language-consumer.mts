// A render function compiled against the language alone, with neither the DOM
// library nor Node's types. Its program has no `AbortSignal` to take, so the
// signal is the part of one that every platform's has.
import type {
  PluginBlockContent,
  PluginBlockRenderContext,
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
