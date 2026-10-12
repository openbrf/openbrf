import { useEffect, useRef, type ReactElement } from "react";

import { QUIET_BUTTON } from "./controls";

/**
 * An act that cannot be undone, asked for twice rather than through a browser
 * dialogue.
 *
 * A native confirm cannot be styled, cannot be translated and cannot be read by
 * a test, and the question belongs next to the row it is about. Asking in the
 * page means moving focus by hand, which a dialogue would have done by itself:
 * the button that was pressed is gone once the question appears, and the
 * browser drops focus to the page. So the confirm button takes focus as it
 * appears, and declining hands focus back to the button that asked - once the
 * question has been asked, not when the row first renders.
 *
 * Whether the question is open is the caller's, because the caller says what
 * it is about beside it and closes it once the act has gone through.
 */
export function TwoPressConfirm({
  confirming,
  busy,
  askDisabled = busy,
  askText,
  askLabel,
  confirmText,
  keepText,
  onAsk,
  onConfirm,
  onKeep,
  className = "flex flex-wrap gap-2",
  askClassName = QUIET_BUTTON,
}: {
  confirming: boolean;
  /** The act is under way: neither answer can be given again. */
  busy: boolean;
  askDisabled?: boolean;
  askText: string;
  /** The ask button's name, naming what it acts on where every row offers it. */
  askLabel?: string;
  confirmText: string;
  keepText: string;
  onAsk: () => void;
  onConfirm: () => void;
  onKeep: () => void;
  className?: string;
  askClassName?: string;
}): ReactElement {
  const confirmButton = useRef<HTMLButtonElement | null>(null);
  const askButton = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (confirming) {
      asked.current = true;
      confirmButton.current?.focus();
    } else if (asked.current) {
      askButton.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        ref={askButton}
        disabled={askDisabled}
        aria-label={askLabel}
        onClick={onAsk}
        className={askClassName}
      >
        {askText}
      </button>
    );
  }

  return (
    <span className={className}>
      <button
        type="button"
        ref={confirmButton}
        disabled={busy}
        onClick={onConfirm}
        className={QUIET_BUTTON}
      >
        {confirmText}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onKeep}
        className={QUIET_BUTTON}
      >
        {keepText}
      </button>
    </span>
  );
}
