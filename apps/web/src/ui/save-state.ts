import { useCallback, useRef, useState } from "react";

import type { ApiFailure, ApiResult } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; failure: ApiFailure };

/**
 * Runs one save and tracks its outcome.
 *
 * Held as one state rather than three booleans so "saving" and "failed" cannot
 * both be true, which is the bug that leaves a spinner running under an error
 * message.
 *
 * `reset` clears what is shown and nothing else: a submit still in flight lands
 * afterwards as it would have. `abandon` is for a screen whose context the
 * submit belonged to has gone - a chat room left, say - and also drops the
 * outcome of every submit started before it, callbacks included, so a refusal
 * or a cleared draft cannot land in whatever replaced it. Such a submit resolves
 * to false.
 */
export function useSaveAction<Args extends unknown[], T>(
  run: (...args: Args) => Promise<ApiResult<T>>,
  onSaved?: (value: T) => void,
  onFailed?: (failure: ApiFailure) => void,
): {
  state: SaveState;
  submit: (...args: Args) => Promise<boolean>;
  reset: () => void;
  abandon: () => void;
} {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  /** Bumped by `abandon`, so a submit can tell it has been left behind. */
  const generation = useRef(0);

  const submit = useCallback(
    async (...args: Args): Promise<boolean> => {
      const startedIn = generation.current;
      setState({ kind: "saving" });
      const result = await run(...args);
      if (generation.current !== startedIn) {
        return false;
      }

      if (!result.ok) {
        setState({ kind: "failed", failure: result.failure });
        onFailed?.(result.failure);
        return false;
      }

      setState({ kind: "saved" });
      onSaved?.(result.value);
      return true;
    },
    [run, onSaved, onFailed],
  );

  const reset = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  const abandon = useCallback(() => {
    generation.current += 1;
    setState({ kind: "idle" });
  }, []);

  return { state, submit, reset, abandon };
}

/**
 * The translated sentence for a failure.
 *
 * The three cases every screen shares are handled here rather than repeated:
 * a request that never reached the server, a refusal by the authorization
 * guard, and the housing cooperative not existing yet - which is the answer to
 * every settings write on an instance whose wizard has not named it.
 */
export function failureMessageKey(
  failure: ApiFailure,
  reasons: Readonly<Record<string, TranslationKey>>,
  fallback: TranslationKey,
): TranslationKey {
  const shared: Readonly<Record<string, TranslationKey>> = {
    offline: "settings.errors.unknown",
    "housing-cooperative-missing": "settings.errors.housingCooperativeMissing",
  };

  if (failure.status === 403) {
    return "settings.errors.forbidden";
  }

  return reasons[failure.reason] ?? shared[failure.reason] ?? fallback;
}
