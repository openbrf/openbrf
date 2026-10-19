import { useCallback, useEffect, useState } from "react";

import type { ApiResult } from "../api/client";

export type ReadState<T> =
  { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; value: T };

/**
 * One panel's read, and the way to run it again.
 *
 * Each panel on the overview owns its read, so a request that fails takes down
 * the panel that made it and nothing else. `read` must be stable across
 * renders - a module-level function, or one the caller memoises - because a new
 * one is a new question and is asked again.
 *
 * A response that arrives after the panel has gone, or after a retry has asked
 * again, is dropped rather than applied.
 */
export function useRead<T>(read: () => Promise<ApiResult<T>>): {
  state: ReadState<T>;
  retry: () => void;
} {
  const [state, setState] = useState<ReadState<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void read().then((result) => {
      if (!active) {
        return;
      }
      setState(
        result.ok
          ? { kind: "loaded", value: result.value }
          : { kind: "failed" },
      );
    });
    return () => {
      active = false;
    };
  }, [read, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((previous) => previous + 1);
  }, []);

  return { state, retry };
}
