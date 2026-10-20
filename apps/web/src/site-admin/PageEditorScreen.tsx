import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { type AdminPage, fetchPages } from "../api/site";
import { BoardPageRefused } from "../ui/BoardPage";
import { isReadOnly } from "../support/read-only";
import { Notice } from "../ui/Notice";
import { QUIET_BUTTON } from "../ui/controls";
import { PageEditor } from "./PageEditor";

/**
 * One page of the association's website, at its own address, in the editor.
 *
 * The page is read with the rest of the list, because a button on it may lead
 * to any of them and the editor offers them by title. The capability is
 * checked here rather than in the route guard, as on the list of pages: the
 * API is the one that decides. A support session (ADR 0028) is not offered the
 * editor, which sends a change with every control, and is told so if it
 * arrives at this address.
 */

export interface PageEditorScreenProps {
  viewer: Viewer;
  pageId: string;
}

export function PageEditorScreen({
  viewer,
  pageId,
}: PageEditorScreenProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = viewer.capabilities.includes("site:manage");
  const readOnly = isReadOnly(viewer);

  const [pages, setPages] = useState<AdminPage[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canManage || readOnly) {
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
  }, [canManage, readOnly]);

  /*
   * A page that comes back as the front page took the place from whichever
   * page had it, as it did on the server in the same transaction.
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

  const removed = useCallback(() => {
    void navigate({ to: "/board/site" });
  }, [navigate]);

  if (!canManage) {
    return <BoardPageRefused />;
  }

  if (readOnly) {
    return <Notice tone="info">{t("support.errors.readOnly")}</Notice>;
  }

  const page = pages?.find((one) => one.id === pageId);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link className={QUIET_BUTTON} to="/board/site">
          {t("siteAdmin.editor.back")}
        </Link>
      </div>
      {failed ? (
        <Notice tone="danger" live>
          {t("siteAdmin.errors.loadFailed")}
        </Notice>
      ) : pages === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("siteAdmin.loading")}
        </p>
      ) : page === undefined ? (
        <Notice tone="info">{t("siteAdmin.errors.pageGone")}</Notice>
      ) : (
        /*
         * Keyed by the page, so going from one page to another mounts a fresh
         * editor rather than carrying the previous page's draft into it. That
         * is the one way this screen could publish the wrong words.
         */
        <PageEditor
          key={page.id}
          page={page}
          pages={pages}
          onChanged={changed}
          onRemoved={removed}
        />
      )}
    </div>
  );
}
