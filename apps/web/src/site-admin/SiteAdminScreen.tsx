import { slugFromTitle } from "@openbrf/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import { type AdminPage, createPage, fetchPages } from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { BoardPageTitle } from "../ui/BoardPage";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { PAGE_STATUS_LABELS, PageEditor } from "./PageEditor";

/**
 * The association's own website, from the board's side.
 *
 * The list is the whole site: drafts beside published pages, because a page is
 * written before it is meant to be read and both states belong on the same
 * screen. What each page is - a draft, for the members or public, and whether
 * it is the front page - is written out in words beside it and never carried
 * by colour alone.
 *
 * The capability is checked here rather than in the route guard, which is the
 * convention: a guard that read capabilities would be a second opinion about
 * what the API will allow, and the API is the one that decides.
 */

const CREATE_REASONS: Readonly<Record<string, TranslationKey>> = {
  "invalid-slug": "siteAdmin.errors.invalidSlug",
  "slug-taken": "siteAdmin.errors.slugTaken",
  "invalid-body": "siteAdmin.errors.invalidBody",
};

export interface SiteAdminScreenProps {
  viewer: Viewer;
}

export function SiteAdminScreen({
  viewer,
}: SiteAdminScreenProps): ReactElement {
  const { t } = useTranslation();
  const canManage = viewer.capabilities.includes("site:manage");

  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    let cancelled = false;

    void (async () => {
      const result = await fetchPages();
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setPages(result.value);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canManage, reloadToken]);

  /*
   * A new page reloads rather than being appended. The server decides the sort
   * order a page lands on, and appending would put it wherever the browser
   * guessed instead of where the website will actually show it.
   */
  const created = useCallback((page: AdminPage) => {
    setTitle("");
    setSelected(page.id);
    setReloadToken((token) => token + 1);
  }, []);

  /*
   * The title and nothing else. The address is made from it by the server, and
   * a new page is always a draft: who it is for is chosen when it is ready to
   * be read, on the page itself.
   */
  const create = useSaveAction(
    async () => createPage({ title, content: { blocks: [] } }),
    created,
  );

  /*
   * A page that comes back as the front page took the place from whichever
   * page had it, as it did on the server in the same transaction. The other is
   * cleared here too, or its editor would go on refusing to take it down or
   * delete it until the list was read again.
   */
  const changed = useCallback((page: AdminPage) => {
    setPages((current) =>
      current === null
        ? current
        : current.map((one) =>
            one.id === page.id
              ? page
              : page.frontPage && one.frontPage
                ? { ...one, frontPage: false }
                : one,
          ),
    );
  }, []);

  const removed = useCallback((id: string) => {
    setSelected((current) => (current === id ? null : current));
    setPages((current) =>
      current === null ? current : current.filter((one) => one.id !== id),
    );
  }, []);

  if (!canManage) {
    return <Notice tone="info">{t("siteAdmin.notAllowed")}</Notice>;
  }

  const page = pages?.find((one) => one.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <BoardPageTitle>{t("siteAdmin.heading")}</BoardPageTitle>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("siteAdmin.description")}
          </p>
        </div>

        {/*
         * The way to the menu. The pages are what the association writes and
         * the menu is how a visitor finds them, so they are two screens - but
         * a board that has just written a page is exactly who needs to put it
         * in the menu, and a destination reachable only from the navigation
         * band would leave that a thing you have to know about.
         */}
        {canManage ? (
          <Link className={SECONDARY_BUTTON} to="/board/site/menu">
            {t("siteAdmin.menu.open")}
          </Link>
        ) : null}
      </header>

      {failed ? (
        <Notice tone="danger" live>
          {t("siteAdmin.errors.loadFailed")}
        </Notice>
      ) : null}

      <Panel
        title={t("siteAdmin.pages.heading")}
        description={t("siteAdmin.pages.description")}
      >
        {/*
         * A failed load says so once, in the notice above. Leaving the loading
         * paragraph standing beside it would have a screen reader announce
         * that the pages are still being read while the danger notice says
         * they could not be - so the failure is answered first, and a list
         * already on the screen when a reload failed is kept rather than
         * replaced by a status that is no longer true.
         */}
        {pages === null ? (
          failed ? null : (
            <p role="status" className="text-body text-ink-muted">
              {t("siteAdmin.loading")}
            </p>
          )
        ) : pages.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("siteAdmin.pages.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pages.map((one) => (
              <li
                key={one.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2"
              >
                <span className="flex flex-col gap-1">
                  <span className="text-body text-ink">{one.title}</span>
                  <span className={`${HINT} font-data`}>/{one.slug}</span>
                </span>
                <span className="flex flex-wrap items-center gap-3">
                  {one.frontPage ? (
                    <span className="text-small text-ink">
                      {t("siteAdmin.state.frontPage")}
                    </span>
                  ) : null}
                  <span className="text-small text-ink-muted">
                    {t(PAGE_STATUS_LABELS[one.status])}
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    onClick={() => {
                      setSelected(one.id);
                    }}
                  >
                    {t("siteAdmin.pages.edit")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={t("siteAdmin.newPage.heading")}
        description={t("siteAdmin.newPage.description")}
        notice={
          create.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  create.state.failure,
                  CREATE_REASONS,
                  "siteAdmin.errors.unknown",
                ),
              )}
            </Notice>
          ) : null
        }
        actions={
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={create.state.kind === "saving"}
            onClick={() => {
              void create.submit();
            }}
          >
            {t("siteAdmin.newPage.create")}
          </button>
        }
      >
        <label className={LABEL}>
          {t("siteAdmin.editor.title")}
          <input
            className={FIELD}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          {/*
           * The address the title will give, as it is typed, so nobody has to
           * think of one. Shown rather than asked for; the page's own editor
           * has it under Advanced for the board that wants another.
           */}
          {title.trim() === "" ? null : (
            <span className={HINT}>
              {t("siteAdmin.newPage.address", {
                address: `/${slugFromTitle(title)}`,
              })}
            </span>
          )}
        </label>
      </Panel>

      {page === null ? null : (
        /*
         * Keyed by the page, so choosing another one in the list mounts a fresh
         * editor rather than carrying the previous page's draft into it. That
         * is the one way this screen could publish the wrong words.
         */
        <PageEditor
          key={page.id}
          page={page}
          onChanged={changed}
          onRemoved={removed}
        />
      )}
    </div>
  );
}
