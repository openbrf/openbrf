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
 * `reset` also lets go of a save still in flight. The write goes on and
 * `onSaved` or `onFailed` still hear its answer, because a booking or a
 * cancellation that was made has to be acted on whatever the screen shows by
 * then. What the answer no longer does is set the state: a screen that has moved
 * on to another resource or week would otherwise be handed the previous one's
 * "saved" or refusal, and `saving` having been cleared would let a second
 * submission start under it.
 *
 * `pending` is the part `reset` leaves alone: it is true from the moment a save
 * is sent until its answer is in. A form that keeps its own writes in order -
 * the answer to an older one must not land over a newer one - disables its
 * control on it rather than on `saving`, which an edit clears.
 */
export function useSaveAction<Args extends unknown[], T>(
  run: (...args: Args) => Promise<ApiResult<T>>,
  onSaved?: (value: T) => void,
  onFailed?: (failure: ApiFailure) => void,
): {
  state: SaveState;
  pending: boolean;
  submit: (...args: Args) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // Counts the saves and resets so far; an answer applies only if it is still the latest.
  const generation = useRef(0);
  // Counts the saves still waiting for their answer, whether or not `reset` let go of them.
  const unanswered = useRef(0);
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (...args: Args): Promise<boolean> => {
      generation.current += 1;
      const mine = generation.current;
      unanswered.current += 1;
      setPending(true);
      setState({ kind: "saving" });
      let result: ApiResult<T>;
      try {
        result = await run(...args);
      } finally {
        unanswered.current -= 1;
        if (unanswered.current === 0) {
          setPending(false);
        }
      }
      const current = generation.current === mine;

      if (!result.ok) {
        if (current) {
          setState({ kind: "failed", failure: result.failure });
        }
        onFailed?.(result.failure);
        return false;
      }

      if (current) {
        setState({ kind: "saved" });
      }
      onSaved?.(result.value);
      return true;
    },
    [run, onSaved, onFailed],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setState({ kind: "idle" });
  }, []);

  return { state, pending, submit, reset };
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
