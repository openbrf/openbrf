import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefCallback } from "react";

const CONTROLS = "input, select, textarea, button, a[href]";

interface Held {
  element: HTMLElement;
  /** Which of the root's children held it, and the identity of the control inside that. */
  child: number;
  identity: string;
}

/**
 * What names a form across a rebuild: its id, name or aria-label, else its
 * place among the forms on the page.
 */
function identifyForm(form: HTMLFormElement): string {
  return (
    form.id ||
    form.getAttribute("name") ||
    form.getAttribute("aria-label") ||
    `form-${Array.from(document.forms).indexOf(form)}`
  );
}

/**
 * What names a control across a rebuild: its tag, type and the first of id,
 * name, aria-label, wrapping label text or own text. A submit button is named
 * by its form instead of its text: the text is the state of the save (Save,
 * Saving...) and the language, and both change with the save itself. A control
 * with none of these has no identity, and focus is not restored to it.
 */
function identify(control: Element): string | null {
  const own = control.id || control.getAttribute("name");
  const label =
    own ||
    control.getAttribute("aria-label") ||
    (control instanceof HTMLButtonElement &&
    control.type === "submit" &&
    control.form !== null
      ? identifyForm(control.form)
      : null) ||
    control.closest("label")?.textContent?.trim() ||
    control.textContent?.trim();
  if (!label) {
    return null;
  }
  return `${control.tagName}:${control.getAttribute("type") ?? ""}:${label}`;
}

function find(
  container: Element | undefined,
  identity: string,
): HTMLElement | null {
  const matches = Array.from(
    container?.querySelectorAll(CONTROLS) ?? [],
  ).filter((each) => identify(each) === identity);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only instanceof HTMLElement ? only : null;
}

/**
 * Keeps focus on a panel that a reload replaces.
 *
 * A panel keyed on the values it was seeded with is built again when a save
 * changes them, and the control that had focus goes with the old one. Call the
 * returned function just before the reloaded data is applied: it remembers
 * where focus is within the root. Once `applied` changes, focus goes to the
 * control of the new panel with the same identity (not the same position, as
 * a save can add or remove controls) - unless there is none or the user has
 * moved focus elsewhere meanwhile. A control that is still on the page is
 * focused again if it lost focus by being disabled while the save was out.
 */
export function useFocusAcrossReload(applied: unknown): {
  rootRef: RefCallback<HTMLDivElement>;
  remember: () => void;
} {
  const root = useRef<HTMLDivElement | null>(null);
  const held = useRef<Held | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const detach = useRef<(() => void) | null>(null);

  /*
   * A control that is disabled while it has focus (the save button, while the
   * save is out) loses it without a blur event in Chrome, and by the time the
   * reload lands document.activeElement is the body. So the control that last
   * took focus is kept, and counts as held until focus is moved on purpose,
   * also once the save has enabled it again and before the reload lands.
   *
   * The listeners follow the root itself rather than the hook's mount: the
   * root may appear later than the hook (a screen that redirects first), and
   * can be replaced by another element.
   */
  const rootRef = useCallback((node: HTMLDivElement | null): void => {
    detach.current?.();
    detach.current = null;
    root.current = node;
    lastFocused.current = null;
    if (node === null) {
      return;
    }
    const onFocusIn = (event: FocusEvent): void => {
      lastFocused.current =
        event.target instanceof HTMLElement ? event.target : null;
    };
    const onFocusOut = (event: FocusEvent): void => {
      // Focus that leaves an enabled control was moved on purpose.
      if (
        event.target instanceof HTMLElement &&
        !event.target.matches(":disabled")
      ) {
        lastFocused.current = null;
      }
    };
    node.addEventListener("focusin", onFocusIn);
    node.addEventListener("focusout", onFocusOut);
    detach.current = () => {
      node.removeEventListener("focusin", onFocusIn);
      node.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const remember = useCallback((): void => {
    held.current = null;
    const focused = document.activeElement;
    const dropped = lastFocused.current;
    const active =
      (focused === null || focused === document.body) && dropped !== null
        ? dropped
        : focused;
    if (root.current === null || !(active instanceof HTMLElement)) {
      return;
    }
    const children = Array.from(root.current.children);
    const child = children.findIndex((each) => each.contains(active));
    if (child === -1) {
      return;
    }
    const identity = active.matches(CONTROLS) ? identify(active) : null;
    if (identity !== null) {
      held.current = { element: active, child, identity };
    }
  }, []);

  useLayoutEffect(() => {
    const was = held.current;
    held.current = null;
    const container = root.current;
    if (was === null || container === null) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }
    if (was.element.isConnected) {
      // Not rebuilt, but enabled again after losing focus while it saved.
      if (!was.element.matches(":disabled")) {
        was.element.focus();
      }
      return;
    }
    const target = find(container.children[was.child], was.identity);
    if (target !== null && !target.matches(":disabled")) {
      target.focus();
    }
  }, [applied]);

  return { rootRef, remember };
}
