import { useEffect, useState } from "react";

/**
 * The browser's clock, read again every `everyMs`.
 *
 * For what a screen offers while an instant has not passed yet, such as a
 * Cancel button for a booking that has not started. A render may not read the
 * clock itself, and a value read once would leave the button on screen after
 * the moment it should have gone.
 *
 * Courtesy and nothing more: the browser's clock can be wrong, and the server
 * decides on its own. What this changes is whether a button that the server
 * would refuse is shown, never whether the refusal is made.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [everyMs]);

  return now;
}
