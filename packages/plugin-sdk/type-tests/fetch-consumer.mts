// A render function compiled as a plugin's own program is: strict, Node's
// module resolution, and the DOM library, which is where `fetch` comes from.
// The host's signal has to go into `fetch` as it is, without a cast.
import type {
  PluginBlockContent,
  PluginBlockRenderContext,
  PluginMediaFile,
} from "../src/index.ts";

export async function render(
  context: PluginBlockRenderContext,
): Promise<PluginBlockContent> {
  const answer = await fetch("https://example.org/schedule", {
    signal: context.signal,
  });
  const platform: AbortSignal = context.signal;
  platform.throwIfAborted();
  // @ts-expect-error The signal is the platform's type, not `any`.
  const wrong: number = context.signal;
  void wrong;
  return answer.text();
}

// A picture served from a plugin's own route: the stream goes into a
// `Response` as it is, without a cast.
export function serve(file: PluginMediaFile): Response {
  const platform: ReadableStream = file.stream;
  void platform;
  return new Response(file.stream, {
    headers: { "content-type": file.contentType },
  });
}
