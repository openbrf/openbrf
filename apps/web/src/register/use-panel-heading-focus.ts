import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Moves focus to a panel's heading when the panel mounts.
 *
 * Below `xl` an open panel hides the board, so the button that opened it stops
 * being focusable in the same commit and the browser drops focus to the document
 * body. A keyboard or screen-reader user would then have to traverse the whole
 * shell to reach the panel they just asked for. The heading is the right target
 * rather than the panel box: it is what gets announced, and it is where reading
 * starts. Returning focus to the opener on close is the route's job, since only
 * the route knows what opened the panel.
 */
export function usePanelHeadingFocus(): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return heading;
}
