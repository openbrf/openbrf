import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { Viewer } from "../api/instance";
import {
  type AdminPage,
  createPage,
  fetchPages,
  type PageVisibility,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
} from "../ui/controls";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { PageEditor } from "./PageEditor";

/**
 * The association's own website, from the board's side.
 *
 * The list is the whole site: drafts beside published pages, because a page is
 * written before it is meant to be read and both states belong on the same
 * screen. What each page is - published or not, public or for the members - is
 * written out in words beside it and never carried by colour alone.
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
  const [slug, setSlug] = useState("");
  const [visibility, setVisibility] = useState<PageVisibility>("PUBLIC");

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
    setSlug("");
    setSelected(page.id);
    setReloadToken((token) => token + 1);
  }, []);

  const create = useSaveAction(
    async () =>
      createPage({ slug, title, content: { blocks: [] }, visibility }),
    created,
  );

  const changed = useCallback((page: AdminPage) => {
    setPages((current) =>
      current === null
        ? current
        : current.map((one) => (one.id === page.id ? page : one)),
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
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("siteAdmin.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("siteAdmin.description")}
        </p>
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
        {pages === null ? (
          <p role="status" className="text-body text-ink-muted">
            {t("siteAdmin.loading")}
          </p>
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
                  <span className="text-small text-ink-muted">
                    {one.published
                      ? t("siteAdmin.state.published")
                      : t("siteAdmin.state.draft")}
                  </span>
                  <span className="text-small text-ink-muted">
                    {one.visibility === "PUBLIC"
                      ? t("siteAdmin.state.public")
                      : t("siteAdmin.state.memberOnly")}
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
        </label>
        <label className={LABEL}>
          {t("siteAdmin.editor.slug")}
          <input
            className={FIELD}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
          />
          <span className={HINT}>{t("siteAdmin.editor.slugHint")}</span>
        </label>
        <label className={LABEL}>
          {t("siteAdmin.newPage.visibility")}
          <select
            className={FIELD}
            value={visibility}
            onChange={(event) => {
              setVisibility(
                event.target.value === "MEMBER" ? "MEMBER" : "PUBLIC",
              );
            }}
          >
            <option value="PUBLIC">{t("siteAdmin.state.public")}</option>
            <option value="MEMBER">{t("siteAdmin.state.memberOnly")}</option>
          </select>
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
