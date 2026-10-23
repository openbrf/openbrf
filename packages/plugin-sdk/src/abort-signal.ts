/**
 * The `AbortSignal` the host hands a plugin, and takes from one.
 *
 * The host passes a real `AbortSignal`. This package compiles against the
 * language alone and cannot name the platform's type, so it is looked up in
 * the plugin's own program: where that has an `AbortSignal`, from the DOM
 * library or from Node's types, this is it, and the signal can be passed on to
 * `fetch` and to anything else that takes one. Where it has none, this is the
 * part of one a plugin can use without them.
 */
export type PluginAbortSignal = typeof globalThis extends {
  readonly AbortSignal: { readonly prototype: infer Signal };
}
  ? Signal
  : PluginAbortSignalShape;

/** What every `AbortSignal` has, for a program without the platform's types. */
interface PluginAbortSignalShape {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
