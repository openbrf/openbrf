import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Gives a form its focus back once a lock on it lifts.
 *
 * A form is locked while a save runs by disabling its fieldset, so what is typed
 * in the meantime is refused rather than taken and then wiped when the save
 * succeeds. A disabled control drops focus to the page, so a board member who
 * sent the form with Enter would find the cursor gone when it opens again.
 *
 * Call the returned function when the form is sent, before the lock is set. It
 * remembers the control that had focus; when `locked` goes false that control
 * gets focus again.
 *
 * - Where the control is disabled by then, `fallback` gets it instead.
 * - Safari and macOS Firefox do not focus a button that was clicked, so the
 *   submitter stands in for the focused control when focus is elsewhere.
 * - Focus is only given back while it is still in the form or on the page
 *   itself. A user who moved to a control outside the form meanwhile keeps it
 *   there, or what they type next would land in the form.
 */
export function useFocusAfterLock(
  locked: boolean,
  formRef: RefObject<HTMLFormElement | null>,
  fallback: RefObject<HTMLElement | null>,
): (submitter: HTMLElement | null) => void {
  const focusedBeforeLock = useRef<HTMLElement | null>(null);

  const remember = useCallback(
    (submitter: HTMLElement | null): void => {
      const focused = document.activeElement;
      const inForm = (element: Element | null): element is HTMLElement =>
        element instanceof HTMLElement && !!formRef.current?.contains(element);

      focusedBeforeLock.current = inForm(focused)
        ? focused
        : inForm(submitter)
          ? submitter
          : null;
    },
    [formRef],
  );

  useEffect(() => {
    if (locked) {
      return;
    }
    const target = focusedBeforeLock.current;
    focusedBeforeLock.current = null;
    if (target === null) {
      return;
    }
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      !formRef.current?.contains(active)
    ) {
      return;
    }
    (target.matches(":disabled") ? fallback.current : target)?.focus();
  }, [locked, formRef, fallback]);

  return remember;
}
