import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** One thing the ⋯ menu offers. */
export interface MoreAction {
  /** What the button says. */
  label: string;
  onSelect: () => void;
}

/**
 * The ⋯ beside a post or a comment, and what it opens: a short list of acts.
 *
 * A disclosure of buttons rather than the ARIA menu pattern. What opens is two
 * or three ordinary buttons, and a screen reader user should meet them as
 * buttons in the order they are written, with Tab - a menu widget would ask
 * them to learn arrow keys for a list they can see the end of.
 *
 * It closes on Escape, on a press outside it, and once an act is chosen. Focus
 * goes back to the ⋯ when it was inside the list, where closing would otherwise
 * drop it on the page's body.
 *
 * What is not in it, and never will be, is delete. What somebody wrote is a
 * record of what was said, and the board strikes through rather than erases.
 */
export function MoreMenu({
  label,
  actions,
}: {
  /** The ⋯'s accessible name, which says whose post or comment it is about. */
  label: string;
  actions: readonly MoreAction[];
}): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (): void => {
      const holdsFocus =
        container.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (holdsFocus) {
        trigger.current?.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !(container.current?.contains(event.target) ?? false)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (actions.length === 0) {
    return null;
  }

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-body text-ink-muted transition-colors duration-150 ease-out hover:text-ink"
        aria-label={label}
        title={t("feed.more")}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-5"
          fill="currentColor"
        >
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open ? (
        <ul
          id={listId}
          className="absolute right-0 z-10 mt-1 flex min-w-48 flex-col rounded-control border border-line bg-raised py-1 shadow-raised"
        >
          {actions.map((action) => (
            <li key={action.label}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center px-3 text-left text-small text-ink hover:bg-sunken"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  action.onSelect();
                }}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
