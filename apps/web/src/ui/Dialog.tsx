import {
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";

export interface DialogProps {
  /** What the dialog is for, as its heading and its accessible name. */
  title: string;
  /** Called when the dialog is dismissed: Escape, or a control that closes it. */
  onClose: () => void;
  children: ReactNode;
  /** The dialog's own actions, along its bottom edge. */
  actions?: ReactNode;
}

/**
 * A modal dialog: the browser's own `<dialog>`, opened as a modal.
 *
 * The native element rather than a component of our own, because what a modal
 * owes a reader is the browser's to give and the browser gives it: the page
 * behind is inert, focus moves in and comes back out where it was, Escape
 * closes it, and a screen reader is told it is a dialog. A hand-built overlay
 * gets each of those slightly wrong in its own way.
 *
 * Mounted open and unmounted to close, so what was typed into one is never in
 * the next: the parent renders it while it is open and not otherwise. Closing
 * by Escape is reported through `onClose` rather than left to the element, so
 * the parent's state and the element cannot disagree about whether it is open.
 *
 * A browser without `showModal` - and the test environment is one - gets the
 * `open` attribute instead, which shows the dialog without making the rest of
 * the page inert. The content is the same either way.
 *
 * Styled as a card in the room (DESIGN.md): one radius step up, one shadow
 * level, a line between the content and the actions, and no backdrop blur.
 */
export function Dialog({
  title,
  onClose,
  children,
  actions,
}: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  /*
   * Held in a ref so the listener below is added once. The parent's callback is
   * a new function on every render, and a listener re-added on each would be
   * removed and added again while the dialog is open.
   */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }

    // Escape: the browser would close the element itself, and the parent
    // would not know. Refused here and reported, so the parent closes it.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100vh-2rem)] w-[min(36rem,calc(100vw-2rem))] rounded-panel border border-line bg-raised p-0 text-ink shadow-raised backdrop:bg-ink/40"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-title">
          {title}
        </h2>
        {children}
        {actions === undefined ? null : (
          <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
            {actions}
          </footer>
        )}
      </div>
    </dialog>
  );
}
