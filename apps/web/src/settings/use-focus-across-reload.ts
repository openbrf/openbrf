import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const CONTROLS = "input, select, textarea, button, a[href]";

interface Held {
  element: HTMLElement;
  /** Which of the root's children held it, and which control inside that. */
  child: number;
  control: number;
}

/**
 * Keeps focus on a panel that a reload replaces.
 *
 * A panel keyed on the values it was seeded with is built again when a save
 * changes them, and the control that had focus goes with the old one. Call the
 * returned function just before the reloaded data is applied: it remembers
 * where focus is within the root. Once `applied` changes, focus goes to the
 * control in the same place of the new panel - unless the old one is still on
 * the page, or the user has moved focus elsewhere meanwhile.
 */
export function useFocusAcrossReload(applied: unknown): {
  rootRef: RefObject<HTMLDivElement | null>;
  remember: () => void;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  const held = useRef<Held | null>(null);

  const remember = useCallback((): void => {
    held.current = null;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root === null || !(active instanceof HTMLElement)) {
      return;
    }
    const children = Array.from(root.children);
    const child = children.findIndex((each) => each.contains(active));
    if (child === -1) {
      return;
    }
    const control = Array.from(
      children[child]?.querySelectorAll(CONTROLS) ?? [],
    ).indexOf(active);
    if (control !== -1) {
      held.current = { element: active, child, control };
    }
  }, []);

  useLayoutEffect(() => {
    const was = held.current;
    held.current = null;
    const root = rootRef.current;
    if (was === null || root === null || was.element.isConnected) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }
    const controls = root.children[was.child]?.querySelectorAll(CONTROLS);
    const target = controls?.[was.control];
    if (target instanceof HTMLElement && !target.matches(":disabled")) {
      target.focus();
    }
  }, [applied]);

  return { rootRef, remember };
}
