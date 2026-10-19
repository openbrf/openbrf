// A render function compiled against the language alone, with neither the DOM
// library nor Node's types. Its program has no `AbortSignal` to take, so the
// signal is the part of one that every platform's has.
import type {
  PluginBlockContent,
  PluginBlockRenderContext,
} from "../src/index.ts";

export function render(context: PluginBlockRenderContext): PluginBlockContent {
  const stop = (): void => undefined;
  context.signal.addEventListener("abort", stop);
  context.signal.removeEventListener("abort", stop);
  // @ts-expect-error Without the platform's types there is no `reason` to read.
  void context.signal.reason;
  return context.signal.aborted ? null : "rendered";
}
