import { useEffect, useRef } from "react";

/**
 * One attempt at a poll.
 *
 * `stillWanted` is what the callback asks before it writes any state: a
 * response can arrive after the screen has gone, after the tab was hidden, or
 * after the caller stopped wanting this poll at all, and applying it then would
 * set state on a component nobody is looking at. Both hand-rolled polls in this
 * client already carry that flag as a closure variable; passing it in is the
 * same rule with one place to get it right.
 */
export type PollAttempt = (stillWanted: () => boolean) => void | Promise<void>;

/**
 * Asks for something again, at an interval, while the tab is being looked at.
 *
 * ## Why a poll at all
 *
 * There is no realtime transport in this product and there is deliberately not
 * going to be one for a chat - ADR 0010 states the argument. A read on an
 * interval is a request answered by an index scan that returns an empty page
 * most of the time, and it needs no proxy configuration, no shutdown hook and no
 * in-process subscriber registry that has to be rebuilt every restart.
 *
 * ## The visibility pause is not a nicety
 *
 * A screen left open on a phone would otherwise poll for days. So the timer runs
 * only while `document.visibilityState` is "visible", is cleared the moment the
 * tab is hidden, and fires one attempt immediately when the tab comes back -
 * which is also what a reader wants, because the thing they came back to look at
 * is whatever arrived while they were away.
 *
 * There is no attempt on mount. Whatever mounted this has just read for itself,
 * and a poll firing into that first read would be a second answer to a question
 * already in flight.
 *
 * ## The callback is read from a ref
 *
 * A caller composes its callback from state, so a new function arrives on every
 * render. Naming it in the dependencies would tear the interval down and build a
 * new one each time, which on a busy screen means the poll never actually waits
 * out its own interval. The ref is what lets the timer survive a render while
 * still calling the newest callback.
 *
 * @param poll What to do on each attempt.
 * @param options `intervalMs` is how long to wait between attempts.
 *   `enabled` stops it entirely - a screen with nothing to poll for yet, or a
 *   reader who is in no room, asks for nothing rather than asking for nothing
 *   repeatedly.
 */
export function usePoll(
  poll: PollAttempt,
  options: { intervalMs: number; enabled: boolean },
): void {
  const latest = useRef(poll);
  /*
   * Updated after every render rather than during one. A ref written while
   * rendering is a side effect in a function React is allowed to call twice, and
   * the timer below only ever reads it from a callback, so after the render is
   * both correct and soon enough.
   */
  useEffect(() => {
    latest.current = poll;
  });

  const { intervalMs, enabled } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    /*
     * Turned off by the cleanup, and read by the callback through `stillWanted`.
     * It covers leaving the screen and being disabled alike: as far as an answer
     * already in flight is concerned the two are one event, and both mean it may
     * no longer be applied.
     */
    let wanted = true;
    const stillWanted = (): boolean => wanted;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = (): void => {
      // Guarded, so a second visibilitychange while already visible does not
      // leave a timer running with nothing holding its handle.
      if (timer === null) {
        timer = setInterval(() => {
          void latest.current(stillWanted);
        }, intervalMs);
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        // At once, and then on the interval. What somebody came back to look at
        // is whatever arrived while they were away.
        void latest.current(stillWanted);
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      wanted = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
