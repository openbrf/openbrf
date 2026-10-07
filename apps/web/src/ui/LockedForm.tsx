import { useRef } from "react";
import type { ComponentPropsWithoutRef, ReactElement, RefObject } from "react";

import { useFocusAfterLock } from "./use-focus-after-lock";

/**
 * A form that refuses input while its save runs.
 *
 * Screens on `useSaveAction` clear their fields once a save succeeds. Disabling
 * only the submit button leaves the fields open, so what is typed while the
 * request runs is wiped without a word. Here the whole form is one disabled
 * fieldset while `locked`, so that input is refused instead of lost.
 *
 * A disabled control drops focus to the page, so the form hands focus back when
 * the lock lifts (see `useFocusAfterLock`): to the control that had it when the
 * form was sent, or to `focusFallback` where that control is still disabled.
 *
 * - `onSend` runs when the form is sent, with the browser's default submit
 *   already prevented. Call the save from it.
 * - `contents` keeps the controls in the form's own layout (flex, grid), as if
 *   the fieldset were not there.
 * - Only controls are affected by the lock, so the failure notice can sit among
 *   the children.
 */
export function LockedForm({
  locked,
  focusFallback,
  onSend,
  children,
  ...formProps
}: Omit<ComponentPropsWithoutRef<"form">, "onSubmit" | "ref"> & {
  locked: boolean;
  /** Takes focus when the control that had it is still disabled. */
  focusFallback: RefObject<HTMLElement | null>;
  onSend: () => void;
}): ReactElement {
  const formRef = useRef<HTMLFormElement>(null);
  const rememberFocus = useFocusAfterLock(locked, formRef, focusFallback);

  return (
    <form
      {...formProps}
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        // A submit button outside the fieldset (`form="…"`) is not disabled by it.
        if (locked) {
          return;
        }
        const { submitter } = event.nativeEvent as SubmitEvent;
        rememberFocus(submitter);
        onSend();
      }}
    >
      <fieldset className="contents" disabled={locked}>
        {children}
      </fieldset>
    </form>
  );
}
