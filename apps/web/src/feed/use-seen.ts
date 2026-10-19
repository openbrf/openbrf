import { useEffect, useRef, type RefObject } from "react";

/**
 * How much of a post has to be on screen for it to count as seen: half of it.
 *
 * Not a pixel of it, which a post scrolled past at speed shows, and not all of
 * it, which a long post with three photographs never shows on a phone at once.
 */
const SEEN_THRESHOLD = 0.5;

/**
 * Whether an element is on screen enough to count: half of it, or - for one
 * taller than twice the screen, of which half never fits - half the screen.
 */
function isSeen(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) {
    return false;
  }
  if (entry.intersectionRatio >= SEEN_THRESHOLD) {
    return true;
  }
  const screen = entry.rootBounds?.height ?? 0;
  return screen > 0 && entry.intersectionRect.height >= screen * SEEN_THRESHOLD;
}

/**
 * Calls `onSeen` once, the first time the element is properly on screen.
 *
 * What "Läst av N" counts. A post somebody scrolled to has been read in the
 * sense the count means - the reader had it in front of them - and a count that
 * waited for a press would count the few who opened a thread rather than the
 * many who read the post.
 *
 * Once per element, whatever happens afterwards: scrolling back up to a post is
 * not reading it again, and the server records the first time only anyway.
 *
 * A browser without IntersectionObserver - and the test environment is one -
 * marks nothing rather than everything. A count that is too low says less than
 * it could; one that counted every post that had merely been fetched would be
 * saying something false about who read what.
 */
export function useSeen(
  element: RefObject<HTMLElement | null>,
  onSeen: () => void,
  enabled: boolean,
): void {
  const latest = useRef(onSeen);
  useEffect(() => {
    latest.current = onSeen;
  });
  const done = useRef(false);

  useEffect(() => {
    const target = element.current;
    if (
      !enabled ||
      done.current ||
      target === null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!done.current && entries.some(isSeen)) {
          done.current = true;
          observer.disconnect();
          latest.current();
        }
      },
      // Several steps, so a post taller than the screen is asked about again
      // as more of it comes into view rather than only once at its top edge.
      { threshold: [0.1, 0.25, SEEN_THRESHOLD] },
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [element, enabled]);
}
