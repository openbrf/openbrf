import { useLocation } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface Disclosure<Container extends HTMLElement> {
  open: boolean;
  toggle: () => void;
  /** Closes, and hands focus back to the trigger when it was in the panel. */
  close: () => void;
  /** The panel's id, for the trigger's aria-controls. */
  panelId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The element holding both the trigger and its panel. */
  containerRef: RefObject<Container | null>;
}

/**
 * A button that shows and hides a panel of links, and every way it closes.
 *
 * The disclosure pattern rather than a menu widget: what opens is page links in
 * a navigation landmark, which a screen reader should read in browse mode as
 * links, with Tab and Shift-Tab walking them in document order. So there is no
 * roving focus and no arrow keys, and nothing opens on hover, which fails a
 * touch screen and an unsteady hand alike.
 *
 * It closes on Escape anywhere in the document, listened for on the document
 * because Safari does not focus a button it was clicked on; on a pointer
 * pressed outside the trigger and its panel; on focus moving somewhere outside
 * them; and on any change of the page, back and forward included. Pressing a
 * link in the panel closes it through `close`, which its caller wires to the
 * link, so the link to the page already open closes it as well.
 *
 * Focus goes back to the trigger only when it was on the trigger or in the
 * panel, where closing would otherwise drop it on the page's body. Anywhere
 * else, it stays where the person put it.
 */
export function useDisclosure<
  Container extends HTMLElement = HTMLElement,
>(): Disclosure<Container> {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<Container>(null);
  // The path inside the application; the router strips its /app basepath.
  const pathname = useLocation({ select: (location) => location.pathname });

  const close = useCallback(() => {
    const focused = document.activeElement;
    const trigger = triggerRef.current;
    const panel = document.getElementById(panelId);
    const holdsFocus =
      focused !== null &&
      (focused === trigger || (panel?.contains(focused) ?? false));
    setOpen(false);
    if (holdsFocus) {
      trigger?.focus();
    }
  }, [panelId]);

  const toggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      // A pointer puts focus where it lands, so none is handed back.
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  useEffect(() => {
    const container = containerRef.current;
    if (!open || container === null) {
      return;
    }
    /*
     * Only a related target outside counts. None at all is focus leaving the
     * window, or a press on something that takes no focus - in Safari, a link
     * in the panel itself - and closing then would take the link away before
     * its click arrived.
     */
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      if (next instanceof Node && !container.contains(next)) {
        setOpen(false);
      }
    };
    container.addEventListener("focusout", onFocusOut);
    return () => {
      container.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  const shownOn = useRef(pathname);
  useEffect(() => {
    if (shownOn.current === pathname) {
      return;
    }
    shownOn.current = pathname;
    close();
  }, [pathname, close]);

  return { open, toggle, close, panelId, triggerRef, containerRef };
}
