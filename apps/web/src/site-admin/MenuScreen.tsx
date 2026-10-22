import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
} from "@dnd-kit/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { failureMessageKey } from "../ui/save-state";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { MenuAddPage } from "./MenuAddPage";
import { MENU_REASONS, MenuEntryForm } from "./MenuEntryForm";
import { MenuRow, controlOf } from "./MenuRow";
import {
  addMenuItem,
  arrangeMenu,
  fetchMenu,
  fetchMenuPages,
  removeMenuItem,
  saveMenuItem,
  type MenuItem,
  type MenuItemFields,
  type MenuPage,
} from "./menu-api";
import {
  canIndent,
  dropTo,
  indent,
  moveBy,
  outdent,
  placementsOf,
  positionOf,
  treeOf,
  type MenuTree,
} from "./menu-arrangement";

/**
 * The board's screen for the menu on the association's website.
 *
 * The menu is two lists rather than a tree with a depth: a top level, and
 * whatever hangs under each of its entries. That is the shape the website can
 * render without a script, so it is the shape the editor offers - a screen
 * that let a board build a third level would be a screen promising something
 * the site cannot show.
 *
 * An entry is moved by dragging it (ADR 0027): up or down to change its place,
 * and sideways under the entry above to make it a dropdown item, or back out
 * to the top level. A drag needs a pointer, so each row also has buttons that
 * make the same moves - up, down, into the dropdown above and out of one -
 * which is what a keyboard and a screen reader use, and the board's language
 * says where the entry went each time. The drag and the buttons are one
 * function from an arrangement to the next (`menu-arrangement.ts`), so they
 * cannot reach different menus.
 *
 * Every move sends the whole arrangement. It is applied on the screen at once
 * and sent in turn: two moves have to be written one after the other, and the
 * server's answer to an earlier one is not allowed to put back an arrangement
 * a later one has already replaced, nor a menu without an entry added since.
 * An entry added, changed or removed takes its turn with the moves, so the
 * server hears every change in the order the board made it, and a move is
 * sent as the screen stands when its turn comes: with the entry added before
 * it, and without the one removed.
 *
 * What the screen deliberately does not do is decide who sees an entry. That
 * follows from what the entry points at and is settled on the server, so the
 * rows say what state a page is in - a draft, or members only - rather than
 * offering a visibility of their own that could disagree with the page's.
 *
 * A support session (ADR 0028) reads the menu as the board does, with each
 * entry's target and state, and is offered neither a row's controls nor the
 * forms that add an entry.
 */

/**
 * How far sideways a drag has to go to change the level: the width a dropdown
 * is indented by below.
 */
const LEVEL_STEP = 32;

/**
 * Nothing is announced for a pointer's drag by the library: where an entry
 * went is said once it is dropped, in the board's language, as it is for a
 * button.
 */
const QUIET: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

export interface MenuScreenProps {
  /** Whether the viewer changes nothing: a support session. */
  readOnly?: boolean;
}

export function MenuScreen({
  readOnly = false,
}: MenuScreenProps = {}): ReactElement {
  const { t } = useTranslation();

  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [pages, setPages] = useState<readonly MenuPage[]>([]);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TranslationKey | null>(null);
  const [outcomeTitle, setOutcomeTitle] = useState("");
  const [refusal, setRefusal] = useState<TranslationKey | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<{
    id: string;
    over: string;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // How many links the "Add a link" form has added: its key, see below.
  const [linksAdded, setLinksAdded] = useState(0);

  const list = useRef<HTMLUListElement>(null);

  // The entries whose removal is queued or sent and not yet answered.
  const removing = useRef(new Set<string>());

  /*
   * The arrangement the next move is calculated from.
   *
   * A move is applied on the screen at once and its arrangement is sent when
   * the ones before it have been answered, so a second move has to start from
   * the first one's result and not from what the server last said. The list is
   * kept beside the state because a move reads it when it is made rather than
   * when the screen last drew.
   */
  const arranged = useRef<MenuItem[]>([]);
  const moves = useRef<Promise<void>>(Promise.resolve());
  /*
   * How many changes this screen has made to the menu: a move made, an entry
   * added, changed or removed. An answer from the server is put on the screen
   * only when no change was made after it was asked for, as one made since has
   * an answer of its own coming - the move's, or the read that follows the
   * others - that is newer and says what this one would.
   */
  const changes = useRef(0);
  // The buttons to put the focus on once the moved row has been drawn again.
  const focusAfter = useRef<string[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A click on the handle is a click; a drag starts once it moves.
      activationConstraint: { distance: 4 },
    }),
  );

  const publish = useCallback((next: MenuItem[]): void => {
    arranged.current = next;
    setItems(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      /*
       * Read once the moves already made are answered. One still being written
       * may have been taken by the server before the change this read is for,
       * and its answer - the whole menu without that change - must not be the
       * last word; read after it, the menu has both.
       */
      let queued: Promise<void>;
      do {
        queued = moves.current;
        await queued;
      } while (queued !== moves.current);
      if (cancelled) {
        return;
      }
      const asked = changes.current;
      const [menu, available] = await Promise.all([
        fetchMenu(),
        fetchMenuPages(),
      ]);
      if (cancelled) {
        return;
      }
      setFailed(!menu.ok || !available.ok);
      if (menu.ok && changes.current === asked) {
        publish(menu.value);
      }
      if (available.ok) {
        setPages(available.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publish, reloadToken]);

  /*
   * A change reloads rather than patching the list in place. Adding an entry
   * can put it at the end of a level and removing one takes its children with
   * it, so the server's own answer is the only thing that gets both right.
   */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /*
   * Puts one write to the menu in the queue the moves are in, and answers with
   * the server's answer to it. The queue has to survive a refusal, or one
   * failed write would carry its rejection into every one made after it; the
   * caller still hears of it.
   */
  const inTurn = useCallback(<T,>(write: () => Promise<T>): Promise<T> => {
    const next = moves.current.then(write);
    moves.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);

  /*
   * The server has taken an addition, an edit or a removal: the menu it now
   * has goes on the screen before the next write in the queue is sent, as a
   * move sent without it would name entries the menu no longer has. It is
   * read back afterwards all the same.
   */
  const took = useCallback(
    (next: MenuItem[]): void => {
      changes.current += 1;
      publish(next);
    },
    [publish],
  );

  /** An entry the server has added, last in its level where it put it. */
  const added = useCallback(
    (entry: MenuItem): void => {
      took(
        arranged.current.some((item) => item.id === entry.id)
          ? arranged.current
          : [...arranged.current, entry],
      );
    },
    [took],
  );

  /*
   * A row that moves between the lists is drawn again, and takes the focus
   * with it. Put back on the button that was pressed - or on the next one that
   * can still be pressed, when the move has used that one up - so a keyboard
   * can go on moving the same entry.
   */
  useLayoutEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null || list.current === null) {
      return;
    }
    focusAfter.current = null;
    for (const control of wanted) {
      const button = list.current.querySelector<HTMLButtonElement>(
        `[data-menu-control="${control}"]`,
      );
      if (button !== null && !button.disabled) {
        button.focus();
        return;
      }
    }
  }, [items]);

  /*
   * Applies one arrangement: on the screen now, on the server in its turn.
   *
   * Nothing is disabled while one is in flight: the buttons are here so the
   * menu can be arranged from a keyboard, and a button that goes disabled under
   * the finger that pressed it takes the focus with it.
   */
  const arrange = useCallback(
    (tree: MenuTree, id: string): void => {
      const byId = new Map(arranged.current.map((item) => [item.id, item]));
      const placements = placementsOf(tree);
      const entry = byId.get(id);

      publish(
        placements.flatMap((placement, order) => {
          const item = byId.get(placement.id);
          return item === undefined
            ? []
            : [{ ...item, parentId: placement.parentId, sortOrder: order }];
        }),
      );
      setRefusal(null);
      setOutcome(null);

      const at = positionOf(tree, id);
      if (entry !== undefined && at !== null) {
        const parent = at.parentId === null ? undefined : byId.get(at.parentId);
        setAnnouncement(
          parent === undefined
            ? t("siteAdmin.menu.announce.topLevel", {
                label: entry.label,
                position: at.index + 1,
                count: at.count,
              })
            : t("siteAdmin.menu.announce.nested", {
                label: entry.label,
                parent: parent.label,
                position: at.index + 1,
                count: at.count,
              }),
        );
      }

      changes.current += 1;
      const asked = changes.current;
      void inTurn(async () => {
        // The screen as it stands now, which has every move made since and
        // what an addition or a removal before this one changed.
        const result = await arrangeMenu(
          placementsOf(treeOf(arranged.current)),
        );
        if (result.ok) {
          // Only an answer nothing has happened since is put on the screen:
          // an earlier one would put back an arrangement a later move has
          // already replaced, or a menu without an entry added meanwhile.
          if (changes.current === asked) {
            publish(result.value);
          }
          return;
        }
        // The screen has run ahead of the server: read the menu again.
        setRefusal(
          failureMessageKey(
            result.failure,
            MENU_REASONS,
            "siteAdmin.menu.errors.unknown",
          ),
        );
        reload();
      }).catch(() => {
        setRefusal("siteAdmin.menu.errors.unknown");
        reload();
      });
    },
    [inTurn, publish, reload, t],
  );

  const press = useCallback(
    (
      id: string,
      make: (tree: MenuTree) => MenuTree | null,
      controls: readonly string[],
    ): void => {
      const next = make(treeOf(arranged.current));
      if (next === null) {
        return;
      }
      focusAfter.current = controls.map((control) => controlOf(id, control));
      arrange(next, id);
    },
    [arrange],
  );

  const remove = useCallback(
    async (entry: MenuItem): Promise<void> => {
      // Waiting in the queue behind slower writes, the button is still
      // pressable: a second press would queue a second removal, which the
      // server answers with not-found.
      if (removing.current.has(entry.id)) {
        return;
      }
      removing.current.add(entry.id);
      try {
        const result = await inTurn(async () => {
          const answer = await removeMenuItem(entry.id);
          if (answer.ok) {
            // The server takes the entry's dropdown with it.
            took(
              arranged.current.filter(
                (item) => item.id !== entry.id && item.parentId !== entry.id,
              ),
            );
          }
          return answer;
        });
        if (result.ok) {
          setRefusal(null);
          setOutcome("siteAdmin.menu.edit.removed");
          reload();
        } else {
          setOutcome(null);
          setRefusal(
            failureMessageKey(
              result.failure,
              MENU_REASONS,
              "siteAdmin.menu.errors.unknown",
            ),
          );
          reload();
        }
      } finally {
        removing.current.delete(entry.id);
      }
    },
    [inTurn, reload, took],
  );

  /*
   * A page added is put on the screen at once, last on the top level where the
   * server put it, as well as read back: until it is on the screen the page is
   * still offered for adding, and a second press would add it twice.
   */
  const addPage = useCallback(
    (page: MenuPage) =>
      inTurn(async () => {
        const result = await addMenuItem({
          kind: "PAGE",
          label: "",
          pageId: page.id,
        });
        if (result.ok) {
          added(result.value);
        } else {
          setOutcome(null);
        }
        return result;
      }),
    [added, inTurn],
  );

  const pageAdded = useCallback(
    (page: MenuPage): void => {
      setRefusal(null);
      setOutcome("siteAdmin.menu.addPage.saved");
      setOutcomeTitle(page.title);
      reload();
    },
    [reload],
  );

  const addLink = useCallback(
    (fields: MenuItemFields) =>
      inTurn(async () => {
        const result = await addMenuItem(fields);
        if (result.ok) {
          added(result.value);
        } else {
          setOutcome(null);
        }
        return result;
      }),
    [added, inTurn],
  );

  const saveEntry = useCallback(
    (id: string, fields: MenuItemFields) =>
      inTurn(async () => {
        const result = await saveMenuItem(id, fields);
        if (result.ok) {
          // In its place until the menu is read back: the form can have put
          // it under another entry, and a move sent meanwhile has to say so.
          // Moved to another level it is last there, where the server put it,
          // and the tree is ordered by position in the list.
          const before = arranged.current.find((item) => item.id === id);
          took(
            before !== undefined && before.parentId !== result.value.parentId
              ? [
                  ...arranged.current.filter((item) => item.id !== id),
                  result.value,
                ]
              : arranged.current.map((item) =>
                  item.id === id ? result.value : item,
                ),
          );
        } else {
          setOutcome(null);
        }
        return result;
      }),
    [inTurn, took],
  );

  const tree = treeOf(items ?? []);
  const byId = new Map((items ?? []).map((item) => [item.id, item]));
  const topLevel = tree.flatMap((branch) => {
    const entry = byId.get(branch.id);
    return entry === undefined ? [] : [entry];
  });
  const inMenu = new Set(
    (items ?? []).flatMap((item) =>
      item.pageId === null ? [] : [item.pageId],
    ),
  );

  const row = (id: string, level: "top" | "dropdown"): ReactElement | null => {
    const entry = byId.get(id);
    const at = positionOf(tree, id);
    if (entry === undefined || at === null) {
      return null;
    }
    return (
      <MenuRow
        canIndent={canIndent(tree, id)}
        count={at.count}
        dropHere={
          dragging !== null && dragging.over === id && dragging.id !== id
        }
        editing={editing === id}
        entry={entry}
        form={
          editing === id ? (
            <MenuEntryForm
              entry={entry}
              onCancel={() => {
                setEditing(null);
              }}
              onSaved={() => {
                setEditing(null);
                setRefusal(null);
                setOutcome("siteAdmin.menu.edit.saved");
                reload();
              }}
              pages={pages}
              parents={topLevel.filter((candidate) => candidate.id !== id)}
              save={(fields: MenuItemFields) => saveEntry(id, fields)}
            />
          ) : null
        }
        index={at.index}
        level={level}
        onEdit={() => {
          setEditing((open) => (open === id ? null : id));
        }}
        onIndent={() => {
          press(id, (current) => indent(current, id), [
            "outdent",
            "up",
            "down",
            "edit",
          ]);
        }}
        onMove={(by) => {
          press(id, (current) => moveBy(current, id, by), [
            by < 0 ? "up" : "down",
            by < 0 ? "down" : "up",
            "edit",
          ]);
        }}
        onOutdent={() => {
          press(id, (current) => outdent(current, id), [
            "indent",
            "up",
            "down",
            "edit",
          ]);
        }}
        onRemove={() => {
          void remove(entry);
        }}
        readOnly={readOnly}
      />
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("siteAdmin.menu.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("siteAdmin.menu.description")}
        </p>
      </header>

      {failed ? (
        <Notice live tone="danger">
          {t("siteAdmin.menu.errors.loadFailed")}
        </Notice>
      ) : null}

      {refusal === null ? null : (
        <Notice live tone="danger">
          {t(refusal)}
        </Notice>
      )}

      {outcome === null ? null : (
        <Notice live tone="ok">
          {t(outcome, { title: outcomeTitle })}
        </Notice>
      )}

      {/*
       * Where an entry went, said for a screen reader as it moves. The list
       * itself is what a sighted board member watches change, so this is not
       * drawn.
       */}
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>

      <Panel title={t("siteAdmin.menu.listHeading")}>
        {items === null ? (
          <p className="text-body text-ink-muted" role="status">
            {t("siteAdmin.menu.loading")}
          </p>
        ) : tree.length === 0 ? (
          <Notice tone="info">{t("siteAdmin.menu.empty")}</Notice>
        ) : (
          <DndContext
            accessibility={{
              announcements: QUIET,
              screenReaderInstructions: { draggable: "" },
            }}
            collisionDetection={closestCenter}
            onDragCancel={() => {
              setDragging(null);
            }}
            onDragEnd={({ active, over, delta }) => {
              setDragging(null);
              const id = String(active.id);
              const next = dropTo(
                treeOf(arranged.current),
                id,
                over === null ? id : String(over.id),
                delta.x,
                LEVEL_STEP,
              );
              if (next !== null) {
                // A drag has no button to give the focus back to.
                focusAfter.current = null;
                arrange(next, id);
              }
            }}
            onDragOver={({ active, over }) => {
              setDragging({
                id: String(active.id),
                over: over === null ? String(active.id) : String(over.id),
              });
            }}
            onDragStart={({ active }) => {
              setDragging({ id: String(active.id), over: String(active.id) });
            }}
            sensors={sensors}
          >
            <ul className="flex flex-col gap-3" ref={list}>
              {tree.map((branch) => (
                <li
                  className="flex flex-col gap-3 border-t border-line pt-3"
                  key={branch.id}
                >
                  {row(branch.id, "top")}
                  {branch.children.length > 0 ? (
                    <ul className="ml-8 flex flex-col gap-3">
                      {branch.children.map((child) => (
                        <li
                          className="flex flex-col gap-3 border-t border-line pt-3"
                          key={child}
                        >
                          {row(child, "dropdown")}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </DndContext>
        )}
      </Panel>

      {readOnly ? null : (
        <>
          {items === null ? null : (
            <MenuAddPage
              add={addPage}
              inMenu={inMenu}
              onAdded={pageAdded}
              pages={pages}
            />
          )}
          <Panel title={t("siteAdmin.menu.addLink.heading")}>
            {/*
             * Remounted after each of its own saves, so the form the board sees
             * next is empty: a link has just been added, and the fields it was
             * added from are the previous answer rather than a draft of the
             * next one. Only after its own: a link half typed stays while the
             * board adds a page or moves an entry.
             */}
            <MenuEntryForm
              key={linksAdded}
              kinds={["EXTERNAL"]}
              onSaved={() => {
                setLinksAdded((count) => count + 1);
                setRefusal(null);
                setOutcome("siteAdmin.menu.add.saved");
                reload();
              }}
              pages={pages}
              parents={topLevel}
              save={addLink}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
