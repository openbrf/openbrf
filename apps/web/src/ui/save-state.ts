import { useCallback, useState } from "react";

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
 */
export function useSaveAction<Args extends unknown[], T>(
  run: (...args: Args) => Promise<ApiResult<T>>,
  onSaved?: (value: T) => void,
): {
  state: SaveState;
  submit: (...args: Args) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  const submit = useCallback(
    async (...args: Args): Promise<boolean> => {
      setState({ kind: "saving" });
      const result = await run(...args);

      if (!result.ok) {
        setState({ kind: "failed", failure: result.failure });
        return false;
      }

      setState({ kind: "saved" });
      onSaved?.(result.value);
      return true;
    },
    [run, onSaved],
  );

  const reset = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  return { state, submit, reset };
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
