import {
  type Announcements,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { PAGE_CONTENT_LIMITS } from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type DropTarget, entryOf } from "./block-tree";
import { BlockInserter } from "./BlockInserter";
import { CanvasBlock, PlainText } from "./CanvasBlock";
import {
  type CanvasActions,
  CanvasActionsContext,
  type CanvasState,
  type CanvasStore,
  CanvasStoreContext,
} from "./canvas-context";
import { CANVAS_CLASS, canvasStylesheet } from "./canvas-stylesheet";
import { EditorIcon } from "./EditorIcon";

/**
 * The page, drawn as the website draws it, with every block on it editable
 * where it stands.
 *
 * A pointer drags a block by its handle, onto another block's upper or lower
 * half, into a column or out of one, with @dnd-kit (ADR 0027); the keyboard
 * moves it through the same places from the same handle (see the page
 * editor's handleKey), and the move buttons beside the handle stay, so
 * nothing depends on the drag working. The website itself is not touched by
 * any of this: it is rendered on the server and runs no script.
 */

/** The stylesheet, built once: it depends on nothing but the website's rules. */
const STYLESHEET = canvasStylesheet();

/** What a place a block can be dropped on is. */
type DropData =
  | { kind: "block"; parent: string | null }
  | { kind: "column"; parent: string; column: number }
  | { kind: "end" };

/**
 * Nothing is announced for a pointer's drag by the library: the editor says
 * where a block went once it is dropped, in its own words and the board's
 * language, as it does for a move from the keyboard.
 */
const QUIET: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function contains(rect: ClientRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * The place under the pointer.
 *
 * The innermost one that holds the pointer - a block in a column before the
 * column, and the column before the columns block around it - and where the
 * pointer is over none, the nearest block on the page by height, so dragging
 * past the margin of the page still lands somewhere. A block that may not sit
 * in a column is never offered one, and a columns block is never offered its
 * own inside.
 */
const collisions: CollisionDetection = ({
  active,
  droppableContainers,
  droppableRects,
  pointerCoordinates,
}) => {
  if (pointerCoordinates === null) {
    return [];
  }
  // The dragged block says itself whether it may sit in a column.
  const nestable =
    (active.data.current as { nestable?: boolean } | undefined)?.nestable ===
    true;
  const { x, y } = pointerCoordinates;

  const candidates = droppableContainers.flatMap((container) => {
    const data = container.data.current as DropData | undefined;
    const rect = droppableRects.get(container.id);
    if (data === undefined || rect === undefined) {
      return [];
    }
    const inColumn =
      data.kind === "column" || (data.kind === "block" && data.parent !== null);
    if (
      inColumn &&
      (!nestable || ("parent" in data && data.parent === active.id))
    ) {
      return [];
    }
    return [{ container, data, rect }];
  });

  let found = candidates
    .filter(({ rect }) => contains(rect, x, y))
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
    .at(0);
  if (found === undefined) {
    found = candidates
      .filter(
        ({ data }) =>
          data.kind === "end" ||
          (data.kind === "block" && data.parent === null),
      )
      .map((candidate) => ({
        candidate,
        distance: Math.max(
          candidate.rect.top - y,
          y - candidate.rect.bottom,
          0,
        ),
      }))
      .sort((a, b) => a.distance - b.distance)
      .at(0)?.candidate;
  }
  if (found === undefined) {
    return [];
  }
  const edge = y < found.rect.top + found.rect.height / 2 ? "before" : "after";
  const collision: Collision = {
    id: found.container.id,
    data: { droppableContainer: found.container, edge },
  };
  return [collision];
};

/** The drop a collision stands for. */
function targetOf(collision: Collision | undefined): DropTarget | null {
  const data = collision?.data as
    | { droppableContainer: { data: { current?: DropData } }; edge: string }
    | undefined;
  const drop = data?.droppableContainer.data.current;
  if (collision === undefined || data === undefined || drop === undefined) {
    return null;
  }
  switch (drop.kind) {
    case "block":
      return {
        id: String(collision.id),
        edge: data.edge === "before" ? "before" : "after",
      };
    case "column":
      return { parent: drop.parent, column: drop.column };
    case "end":
      return { end: true };
  }
}

export interface EditorCanvasProps {
  /** The page's state as this render has it, and the store blocks read it from. */
  state: CanvasState;
  store: CanvasStore;
  actions: CanvasActions;
  title: string;
  onTitle: (title: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (id: string, target: DropTarget | null) => void;
  onDrop: (id: string, target: DropTarget | null) => void;
  onDragCancel: () => void;
}

export function EditorCanvas({
  state,
  store,
  actions,
  title,
  onTitle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragCancel,
}: EditorCanvasProps): ReactElement {
  const { t } = useTranslation();
  const entries = state.entries;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A click on the handle selects; a drag starts once the pointer moves.
      activationConstraint: { distance: 4 },
    }),
  );

  const end = useDroppable({ id: "page-end", data: { kind: "end" } });
  const dragged =
    state.dragging === null ? undefined : entryOf(entries, state.dragging);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisions}
      accessibility={{
        announcements: QUIET,
        screenReaderInstructions: { draggable: "" },
      }}
      onDragStart={({ active }) => {
        onDragStart(String(active.id));
      }}
      onDragMove={({ active, collisions: found }) => {
        onDragOver(String(active.id), targetOf(found?.[0]));
      }}
      onDragEnd={({ active, collisions: found }) => {
        onDrop(String(active.id), targetOf(found?.[0]));
      }}
      onDragCancel={onDragCancel}
    >
      <CanvasActionsContext.Provider value={actions}>
        <CanvasStoreContext.Provider value={store}>
          <section
            aria-label={t("siteAdmin.editor.canvas.label")}
            className={`${CANVAS_CLASS} overflow-x-clip rounded-panel border border-line shadow-raised`}
          >
            <style>{STYLESHEET}</style>
            <p id={actions.instructionsId} hidden>
              {t("siteAdmin.editor.dragInstructions")}
            </p>
            <div className="site">
              <div className="site-main">
                <div className="site-title">
                  <PlainText
                    label={t("siteAdmin.editor.title")}
                    placeholder={t("siteAdmin.editor.canvas.title")}
                    value={title}
                    onChange={onTitle}
                  />
                </div>

                {entries.map((entry, at) => (
                  <CanvasBlock
                    key={entry.id}
                    entry={entry}
                    place={{ list: "page", at }}
                  />
                ))}

                <div
                  ref={(element) => {
                    end.setNodeRef(element);
                  }}
                  className={`mt-10 flex flex-col items-center gap-2 rounded-control p-2 ${
                    state.dropAt !== null && "end" in state.dropAt
                      ? "outline-2 outline-trust"
                      : ""
                  }`}
                >
                  <BlockInserter
                    look="end"
                    label={t("siteAdmin.editor.inserter.end")}
                    choices={state.pageChoices}
                    ref={actions.control("add")}
                    full={
                      state.room <= 0
                        ? t("siteAdmin.editor.pageFullShort", {
                            count: PAGE_CONTENT_LIMITS.blocks,
                          })
                        : null
                    }
                    onChoose={(type) => {
                      actions.insert(
                        { list: "page", at: entries.length },
                        type,
                      );
                    }}
                  />
                  {state.room <= 0 ? (
                    <span className="text-small text-ink-muted">
                      {t("siteAdmin.editor.pageFull", {
                        count: PAGE_CONTENT_LIMITS.blocks,
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <DragOverlay dropAnimation={null}>
            {dragged === undefined ? null : (
              <span className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-raised px-3 text-small text-ink shadow-raised">
                <EditorIcon name="drag" />
                {state.kindOf(dragged.block)}
              </span>
            )}
          </DragOverlay>
        </CanvasStoreContext.Provider>
      </CanvasActionsContext.Provider>
    </DndContext>
  );
}
