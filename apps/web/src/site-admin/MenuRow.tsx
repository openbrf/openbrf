import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QUIET_BUTTON } from "../ui/controls";
import { EditorIcon } from "./EditorIcon";
import type { MenuItem } from "./menu-api";

/**
 * One entry of the menu on the board's screen: what it says, what it points
 * at, what state that is in, and the ways to move it.
 *
 * The row is where an entry is dragged from and dropped on, with @dnd-kit, by
 * the handle at its left. A drag needs a pointer, so every move it can make
 * has a button beside it: up, down, into the dropdown of the entry above and
 * out of one. The handle is therefore left out of the tab order and out of the
 * accessibility tree - a control a keyboard can reach and cannot use is worse
 * than none - and the buttons are what the keyboard and a screen reader use.
 */

/**
 * A move button, which shows an arrow and nothing else: as wide as it is tall,
 * so the touch target is the full 44px both ways rather than the arrow's width.
 */
const ARROW_BUTTON = `${QUIET_BUTTON} min-w-11`;

/** Names the buttons, so the screen can put the focus back on one. */
export function controlOf(id: string, control: string): string {
  return `${id}:${control}`;
}

export interface MenuRowProps {
  entry: MenuItem;
  /** The top level or the dropdown. */
  level: "top" | "dropdown";
  /** Zero-based, among the entries of its level. */
  index: number;
  /** How many entries its level has. */
  count: number;
  canIndent: boolean;
  /**
   * Whether the entry stays where it is: it, or the entry it hangs under, is
   * being removed, and the removal takes the dropdown as the board saw it.
   */
  held: boolean;
  /** Whether a drag is over this row, and would drop next to it. */
  dropHere: boolean;
  readOnly: boolean;
  editing: boolean;
  onMove: (by: -1 | 1) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onEdit: () => void;
  onRemove: () => void;
  /** The edit form, while this row is being edited. */
  form: ReactNode;
}

export function MenuRow({
  entry,
  level,
  index,
  count,
  canIndent,
  held,
  dropHere,
  readOnly,
  editing,
  onMove,
  onIndent,
  onOutdent,
  onEdit,
  onRemove,
  form,
}: MenuRowProps): ReactElement {
  const { t } = useTranslation();
  const {
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef: setDraggableRef,
    transform: moved,
  } = useDraggable({ id: entry.id, disabled: readOnly || held });
  const { setNodeRef: setDroppableRef } = useDroppable({ id: entry.id });

  return (
    <div
      className={[
        "flex flex-col gap-3 rounded-control",
        isDragging ? "relative z-10 bg-raised opacity-90 shadow-raised" : "",
        dropHere ? "outline-2 outline-offset-2 outline-trust" : "",
      ].join(" ")}
      data-menu-row={entry.id}
      ref={(element) => {
        setDraggableRef(element);
        setDroppableRef(element);
      }}
      style={
        moved === null
          ? undefined
          : { transform: `translate3d(${moved.x}px, ${moved.y}px, 0)` }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          {readOnly ? null : (
            <span
              aria-hidden="true"
              className="inline-flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center text-ink-muted"
              ref={setActivatorNodeRef}
              title={t("siteAdmin.menu.dragHandle", { label: entry.label })}
              {...listeners}
            >
              <EditorIcon name="drag" />
            </span>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-body font-semibold text-ink">
              {entry.label}
            </span>
            {entry.page === null ? null : (
              <span className="text-small text-ink-muted">
                {entry.page.builtIn === null
                  ? entry.page.title
                  : t("siteAdmin.menu.entry.builtIn", {
                      title: entry.page.title,
                    })}
              </span>
            )}
            {entry.url === null ? null : (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.entry.external", { url: entry.url })}
              </span>
            )}
            {entry.page?.status === "DRAFT" ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.pageState.draft")}
              </span>
            ) : null}
            {entry.page?.status === "MEMBERS_ONLY" ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.pageState.member")}
              </span>
            ) : null}
            {/*
             * Kept for members by the entry itself. Said only where the page
             * does not already say as much, or more: a draft's entry is on
             * nobody's menu, and a member-only page's says so above.
             */}
            {entry.membersOnly &&
            entry.page?.status !== "DRAFT" &&
            entry.page?.status !== "MEMBERS_ONLY" ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.entry.membersOnly")}
              </span>
            ) : null}
            {/*
             * The one built-in page whose entry is not on everybody's menu:
             * the form is for somebody asking for an account, so it is offered
             * only while the board takes requests and only to a visitor who
             * is not signed in.
             */}
            {entry.page?.builtIn === "REQUEST_ACCOUNT" ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.pageState.requestAccount")}
              </span>
            ) : null}
          </div>
        </div>

        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              aria-label={t("siteAdmin.menu.edit.moveUp", {
                label: entry.label,
              })}
              className={ARROW_BUTTON}
              data-menu-control={controlOf(entry.id, "up")}
              disabled={held || index <= 0}
              onClick={() => {
                onMove(-1);
              }}
              type="button"
            >
              {"↑"}
            </button>
            <button
              aria-label={t("siteAdmin.menu.edit.moveDown", {
                label: entry.label,
              })}
              className={ARROW_BUTTON}
              data-menu-control={controlOf(entry.id, "down")}
              disabled={held || index >= count - 1}
              onClick={() => {
                onMove(1);
              }}
              type="button"
            >
              {"↓"}
            </button>
            {level === "top" ? (
              <button
                aria-label={t("siteAdmin.menu.edit.indent", {
                  label: entry.label,
                })}
                className={ARROW_BUTTON}
                data-menu-control={controlOf(entry.id, "indent")}
                disabled={!canIndent}
                onClick={onIndent}
                type="button"
              >
                {"→"}
              </button>
            ) : (
              <button
                aria-label={t("siteAdmin.menu.edit.outdent", {
                  label: entry.label,
                })}
                className={ARROW_BUTTON}
                data-menu-control={controlOf(entry.id, "outdent")}
                disabled={held}
                onClick={onOutdent}
                type="button"
              >
                {"←"}
              </button>
            )}
            <button
              aria-expanded={editing}
              aria-label={t("siteAdmin.menu.edit.heading", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              data-menu-control={controlOf(entry.id, "edit")}
              onClick={onEdit}
              type="button"
            >
              {editing
                ? t("siteAdmin.menu.edit.cancel")
                : t("siteAdmin.menu.edit.open")}
            </button>
            <button
              aria-label={t("siteAdmin.menu.edit.removeEntry", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              onClick={onRemove}
              type="button"
            >
              {t("siteAdmin.menu.edit.remove")}
            </button>
          </div>
        )}
      </div>

      {form}
    </div>
  );
}
