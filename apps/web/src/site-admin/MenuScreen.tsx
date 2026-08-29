import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { QUIET_BUTTON } from "../ui/controls";
import { generatedLabelKey, MenuEntryForm } from "./MenuEntryForm";
import {
  addMenuItem,
  fetchMenu,
  fetchMenuPages,
  orderMenu,
  removeMenuItem,
  saveMenuItem,
  type MenuItem,
  type MenuItemFields,
  type MenuPage,
} from "./menu-api";

/**
 * The board's screen for the menu on the association's website.
 *
 * The menu is two lists rather than a tree with a depth: a top level, and
 * whatever hangs under each of its entries. That is the shape the website can
 * render without a script, so it is the shape the editor offers - a screen
 * that let a board build a third level would be a screen promising something
 * the site cannot show.
 *
 * Order is changed one step at a time rather than by dragging. A move up and a
 * move down are reachable from a keyboard and from a screen reader, they need
 * no pointer precision, and the arrangement of a housing cooperative's menu is
 * not work that happens often enough to be worth a drag surface nobody can use
 * without a mouse.
 *
 * What the screen deliberately does not do is decide who sees an entry. That
 * follows from what the entry points at and is settled on the server, so the
 * rows say what state a page is in - a draft, or members only - rather than
 * offering a visibility of their own that could disagree with the page's.
 */

export function MenuScreen(): ReactElement {
  const { t } = useTranslation();

  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [pages, setPages] = useState<readonly MenuPage[]>([]);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [menu, available] = await Promise.all([
        fetchMenu(),
        fetchMenuPages(),
      ]);
      if (cancelled) {
        return;
      }
      setFailed(!menu.ok || !available.ok);
      if (menu.ok) {
        setItems(menu.value);
      }
      if (available.ok) {
        setPages(available.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  /*
   * A change reloads rather than patching the list in place. Adding an entry
   * can put it at the end of a level, moving one can change two rows at once
   * and removing one takes its children with it, so the server's own answer is
   * the only thing that gets all three right.
   */
  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const move = useCallback(
    async (entry: MenuItem, by: -1 | 1): Promise<void> => {
      const siblings = (items ?? []).filter(
        (candidate) => candidate.parentId === entry.parentId,
      );
      const from = siblings.findIndex((candidate) => candidate.id === entry.id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= siblings.length) {
        return;
      }
      const ordered = siblings.map((candidate) => candidate.id);
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to, 0, moved ?? entry.id);

      const result = await orderMenu(entry.parentId, ordered);
      if (result.ok) {
        setItems(result.value);
      } else {
        setFailed(true);
      }
    },
    [items],
  );

  const remove = useCallback(
    async (entry: MenuItem): Promise<void> => {
      const result = await removeMenuItem(entry.id);
      if (result.ok) {
        reload();
      } else {
        setFailed(true);
      }
    },
    [reload],
  );

  const topLevel = (items ?? []).filter((item) => item.parentId === null);
  const childrenOf = (id: string): MenuItem[] =>
    (items ?? []).filter((item) => item.parentId === id);

  const row = (
    entry: MenuItem,
    siblings: readonly MenuItem[],
  ): ReactElement => {
    const position = siblings.findIndex(
      (candidate) => candidate.id === entry.id,
    );
    const generatedKey =
      entry.generatedKey === null
        ? null
        : generatedLabelKey(entry.generatedKey);

    return (
      <li
        className="flex flex-col gap-3 border-t border-line pt-3"
        key={entry.id}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-body font-semibold text-ink">
              {entry.label}
            </span>
            {entry.page === null ? null : (
              <span className="text-small text-ink-muted">
                {entry.page.title}
              </span>
            )}
            {generatedKey === null ? null : (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.entry.generated", {
                  name: t(generatedKey),
                })}
              </span>
            )}
            {entry.url === null ? null : (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.entry.external", { url: entry.url })}
              </span>
            )}
            {entry.page !== null && !entry.page.published ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.pageState.draft")}
              </span>
            ) : null}
            {entry.page !== null && entry.page.visibility === "MEMBER" ? (
              <span className="text-small text-ink-muted">
                {t("siteAdmin.menu.pageState.member")}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              aria-label={t("siteAdmin.menu.edit.moveUp", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              disabled={position <= 0}
              onClick={() => {
                void move(entry, -1);
              }}
              type="button"
            >
              {"↑"}
            </button>
            <button
              aria-label={t("siteAdmin.menu.edit.moveDown", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              disabled={position < 0 || position >= siblings.length - 1}
              onClick={() => {
                void move(entry, 1);
              }}
              type="button"
            >
              {"↓"}
            </button>
            <button
              aria-expanded={editing === entry.id}
              aria-label={t("siteAdmin.menu.edit.heading", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              onClick={() => {
                setEditing((open) => (open === entry.id ? null : entry.id));
              }}
              type="button"
            >
              {editing === entry.id
                ? t("siteAdmin.menu.edit.cancel")
                : t("siteAdmin.menu.edit.open")}
            </button>
            <button
              aria-label={t("siteAdmin.menu.edit.removeEntry", {
                label: entry.label,
              })}
              className={QUIET_BUTTON}
              onClick={() => {
                void remove(entry);
              }}
              type="button"
            >
              {t("siteAdmin.menu.edit.remove")}
            </button>
          </div>
        </div>

        {editing === entry.id ? (
          <MenuEntryForm
            entry={entry}
            onCancel={() => {
              setEditing(null);
            }}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            pages={pages}
            parents={topLevel.filter((candidate) => candidate.id !== entry.id)}
            save={(fields: MenuItemFields) => saveMenuItem(entry.id, fields)}
          />
        ) : null}

        {entry.parentId === null && childrenOf(entry.id).length > 0 ? (
          <ul className="ml-6 flex flex-col gap-3">
            {childrenOf(entry.id).map((child) =>
              row(child, childrenOf(entry.id)),
            )}
          </ul>
        ) : null}
      </li>
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

      <Panel title={t("siteAdmin.menu.heading")}>
        {items === null ? (
          <p className="text-body text-ink-muted" role="status">
            {t("siteAdmin.menu.loading")}
          </p>
        ) : topLevel.length === 0 ? (
          <Notice tone="info">{t("siteAdmin.menu.empty")}</Notice>
        ) : (
          <ul className="flex flex-col gap-3">
            {topLevel.map((entry) => row(entry, topLevel))}
          </ul>
        )}
      </Panel>

      <Panel title={t("siteAdmin.menu.add.heading")}>
        <MenuEntryForm
          onSaved={reload}
          pages={pages}
          parents={topLevel}
          save={addMenuItem}
        />
      </Panel>
    </div>
  );
}
