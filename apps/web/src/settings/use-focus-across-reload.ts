import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const CONTROLS = "input, select, textarea, button, a[href]";

interface Held {
  element: HTMLElement;
  /** Which of the root's children held it, and the identity of the control inside that. */
  child: number;
  identity: string;
}

/**
 * What names a control across a rebuild: its tag, type and the first of id,
 * name, aria-label, wrapping label text or own text. A control with none of
 * these has no identity, and focus is not restored to it.
 */
function identify(control: Element): string | null {
  const label =
    control.id ||
    control.getAttribute("name") ||
    control.getAttribute("aria-label") ||
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
 * a save can add or remove controls) - unless there is none, the old one is
 * still on the page, or the user has moved focus elsewhere meanwhile.
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
    const identity = active.matches(CONTROLS) ? identify(active) : null;
    if (identity !== null) {
      held.current = { element: active, child, identity };
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
    const target = find(root.children[was.child], was.identity);
    if (target !== null && !target.matches(":disabled")) {
      target.focus();
    }
  }, [applied]);

  return { rootRef, remember };
}
