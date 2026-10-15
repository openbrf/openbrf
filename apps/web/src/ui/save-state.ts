import type { TFunction } from "i18next";
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
 * `abandon` is for a screen whose context the submit belonged to has gone - a
 * chat room left, say. It does what `reset` does and also drops the callbacks of
 * every submit started before it, so a refusal or a cleared draft cannot land in
 * whatever replaced it. Such a submit resolves to false. Use it only where the
 * write has no effect the screen must still act on.
 *
 * `pending` is the part `reset` and `abandon` leave alone: it is true from the
 * moment a save is sent until its answer is in. A form that keeps its own writes
 * in order - the answer to an older one must not land over a newer one -
 * disables its control on it rather than on `saving`, which an edit clears.
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
  abandon: () => void;
} {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // Counts the saves and resets so far; an answer applies only if it is still the latest.
  const generation = useRef(0);
  // Bumped by `abandon`, so a submit can tell its callbacks are no longer wanted.
  const abandoned = useRef(0);
  // Counts the saves still waiting for their answer, whether or not `reset` let go of them.
  const unanswered = useRef(0);
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (...args: Args): Promise<boolean> => {
      generation.current += 1;
      const mine = generation.current;
      const startedIn = abandoned.current;
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
      if (abandoned.current !== startedIn) {
        return false;
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

  const abandon = useCallback(() => {
    abandoned.current += 1;
    generation.current += 1;
    setState({ kind: "idle" });
  }, []);

  return { state, pending, submit, reset, abandon };
}

/**
 * The translated sentence for a failure.
 *
 * The three cases every screen shares are handled here rather than repeated:
 * a request that never reached the server, a refusal by the authorization
 * guard, and the housing cooperative not existing yet - which is the answer to
 * every settings write on an instance whose wizard has not named it. The first
 * two are said in the `form.errors` words every screen shares.
 */
export function failureMessageKey(
  failure: ApiFailure,
  reasons: Readonly<Record<string, TranslationKey>>,
  fallback: TranslationKey,
): TranslationKey {
  const shared: Readonly<Record<string, TranslationKey>> = {
    offline: "form.errors.unknown",
    "housing-cooperative-missing": "settings.errors.housingCooperativeMissing",
  };

  if (failure.status === 403) {
    return "form.errors.forbidden";
  }

  return reasons[failure.reason] ?? shared[failure.reason] ?? fallback;
}

/**
 * The fields a schema refusal named, as dotted paths with list indexes dropped.
 *
 * The API answers a body that fails its schema with `invalid-body` and each
 * refused field's path, never its value. `apartments.3.number` reads as
 * `apartments.number`: a form labels the column, not the row.
 */
export function refusedFields(failure: ApiFailure): readonly string[] {
  if (failure.reason !== "invalid-body" || !Array.isArray(failure.detail)) {
    return [];
  }
  return failure.detail.flatMap((issue: unknown) => {
    const path = (issue as { path?: unknown } | null)?.path;
    return typeof path === "string" ? [path.replace(/\.\d+(?=\.|$)/g, "")] : [];
  });
}

/**
 * The translated sentence for a failure, naming the fields a schema refused.
 *
 * A refused field is not a moment's trouble, so "try again" is the wrong
 * advice: the same input is refused every time. A path the form has no label
 * for is left out rather than guessed at, and with none left the sentence says
 * only that something in the form was not accepted.
 */
export function failureMessage(
  t: TFunction,
  failure: ApiFailure,
  reasons: Readonly<Record<string, TranslationKey>>,
  fallback: TranslationKey,
  fieldLabels: Readonly<Record<string, TranslationKey>> = {},
): string {
  if (failure.reason !== "invalid-body") {
    return t(failureMessageKey(failure, reasons, fallback));
  }
  const labels = [
    ...new Set(
      refusedFields(failure).flatMap((path) => {
        const key = fieldLabels[path];
        return key === undefined ? [] : [t(key)];
      }),
    ),
  ];
  return labels.length === 0
    ? t("form.errors.invalidBody")
    : t("form.errors.fieldsRefused", {
        fields: labels.join(", "),
        count: labels.length,
      });
}
