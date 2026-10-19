import { vi } from "vite-plus/test";

/**
 * Chrome drops focus from a control that is disabled, without a blur event;
 * jsdom keeps it, so the body is reported as active until focus is set again.
 *
 * Test support only: the settings tests that check focus survives a save use
 * it to stand in for what the browser does while the save is out.
 */
export function dropFocus(): void {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => document.body,
  });
  const focus = Reflect.get(HTMLElement.prototype, "focus") as (
    this: HTMLElement,
    options?: FocusOptions,
  ) => void;
  const spy = vi.spyOn(HTMLElement.prototype, "focus");
  spy.mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    spy.mockRestore();
    Reflect.deleteProperty(document, "activeElement");
    focus.call(this, options);
  });
}
