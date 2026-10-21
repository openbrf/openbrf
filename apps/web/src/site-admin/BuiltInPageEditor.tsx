import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import {
  type AdminPage,
  type BuiltInPage,
  fetchPages,
  savePage,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { useSaveAction } from "../ui/save-state";
import { AssociationFactsPanel } from "./AssociationFactsPanel";
import { pageFailureKey } from "./PageEditor";
import { PAGE_STATUS_LABELS } from "./PageSettings";

/**
 * A built-in page, from the board's side.
 *
 * What stands on it is the platform's, read from what the association already
 * holds, so there is no body here to edit, no address to choose, no status to
 * set and nothing to delete. What is left is its title - the words a menu entry
 * for it borrows - and a way to where its content really is written: the news
 * screen, the events, the account requests. The broker information page has
 * no screen of its own, so the association facts it is made from are recorded
 * right here.
 */

/** What stands on each built-in page, said in a sentence. */
const WHAT: Readonly<Record<BuiltInPage, TranslationKey>> = {
  NEWS: "siteAdmin.builtIn.what.NEWS",
  CALENDAR: "siteAdmin.builtIn.what.CALENDAR",
  BROKER_INFORMATION: "siteAdmin.builtIn.what.BROKER_INFORMATION",
  REQUEST_ACCOUNT: "siteAdmin.builtIn.what.REQUEST_ACCOUNT",
};

export interface BuiltInPageEditorProps {
  page: AdminPage & { builtIn: BuiltInPage };
  onChanged: (page: AdminPage) => void;
}

export function BuiltInPageEditor({
  page,
  onChanged,
}: BuiltInPageEditorProps): ReactElement {
  const { t } = useTranslation();
  const [title, setTitle] = useState(page.title);
  // Counts the saves and re-reads so far; a re-read's page is handed up only if
  // nothing has been sent or read since, nor the panel closed.
  const generation = useRef(0);
  /*
   * Set from the press of Save until its answer is in. Editing the title lets
   * go of the "saving" state but not of the write, which still claims the
   * revision this panel holds: a second save sent under it would claim the same
   * one and be refused for the board's own first, and its answer could land
   * before the first's. Kept in a ref as well as read from `pending`, so a
   * second press before the button is drawn disabled sends nothing either.
   */
  const sending = useRef(false);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const save = useSaveAction(
    async () => {
      generation.current += 1;
      return savePage(page.id, {
        title,
        content: { blocks: [] },
        expectedRevision: page.revision,
      });
    },
    onChanged,
    (failure) => {
      /*
       * Somebody else saved this page while it was open here. Read it again and
       * hand it up, so the next save claims the revision that is current; the
       * title the board has typed stays where it is.
       */
      if (failure.reason !== "page-changed") {
        return;
      }
      generation.current += 1;
      const mine = generation.current;
      void (async () => {
        const pages = await fetchPages();
        if (generation.current !== mine) {
          return;
        }
        const fresh = pages.ok
          ? pages.value.find((one) => one.id === page.id)
          : undefined;
        if (fresh !== undefined) {
          onChanged(fresh);
        }
      })();
    },
  );

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title={page.title}
        description={t("siteAdmin.builtIn.description")}
        notice={
          save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(pageFailureKey(save.state.failure))}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("siteAdmin.editor.saved")}
            </Notice>
          ) : null
        }
        actions={
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={save.pending}
              onClick={() => {
                if (sending.current) {
                  return;
                }
                sending.current = true;
                void save.submit().finally(() => {
                  sending.current = false;
                });
              }}
            >
              {t("siteAdmin.editor.save")}
            </button>
            <ManageLink builtIn={page.builtIn} />
          </>
        }
      >
        <p className="text-body text-ink">{t(WHAT[page.builtIn])}</p>

        <label className={LABEL}>
          {t("siteAdmin.editor.title")}
          <input
            className={FIELD}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              save.reset();
            }}
          />
          <span className={HINT}>{t("siteAdmin.builtIn.titleHint")}</span>
        </label>

        {/*
         * Said rather than offered. The address is where the platform serves
         * the page, and the status is public for good: a choice that could
         * only ever be refused is not a choice to put on the screen.
         */}
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-label text-ink-muted uppercase">
              {t("siteAdmin.builtIn.address")}
            </dt>
            <dd className="font-data text-body text-ink">/{page.slug}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-label text-ink-muted uppercase">
              {t("siteAdmin.editor.status")}
            </dt>
            <dd className="text-body text-ink">
              {t(PAGE_STATUS_LABELS[page.status])}
              <span className={`block ${HINT}`}>
                {t("siteAdmin.builtIn.status")}
              </span>
            </dd>
          </div>
        </dl>
      </Panel>

      {page.builtIn === "BROKER_INFORMATION" ? <AssociationFactsPanel /> : null}
    </div>
  );
}

/** The way to where what stands on the page is written, where there is one. */
function ManageLink({
  builtIn,
}: {
  builtIn: BuiltInPage;
}): ReactElement | null {
  const { t } = useTranslation();
  switch (builtIn) {
    case "NEWS":
      return (
        <Link className={SECONDARY_BUTTON} to="/admin/site/news">
          {t("siteAdmin.builtIn.manage.NEWS")}
        </Link>
      );
    case "CALENDAR":
      return (
        <Link className={SECONDARY_BUTTON} to="/events">
          {t("siteAdmin.builtIn.manage.CALENDAR")}
        </Link>
      );
    case "REQUEST_ACCOUNT":
      return (
        <Link
          className={SECONDARY_BUTTON}
          to="/settings/$section"
          params={{ section: "account-requests" }}
        >
          {t("siteAdmin.builtIn.manage.REQUEST_ACCOUNT")}
        </Link>
      );
    case "BROKER_INFORMATION":
      // Its facts are recorded on this screen, below.
      return null;
  }
}
