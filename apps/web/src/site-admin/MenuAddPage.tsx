import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { SECONDARY_BUTTON } from "../ui/controls";
import { failureMessageKey } from "../ui/save-state";
import { MENU_REASONS } from "./MenuEntryForm";
import type { MenuItem, MenuPage } from "./menu-api";

/**
 * The pages the menu does not have yet, to put in it one at a time.
 *
 * The association's own pages and the built-in ones - the news, the calendar,
 * the broker information and the account request form - are offered together,
 * the built-in ones named as such so the news index is never mistaken for a
 * page of the board's own called "Nyheter". A page is added last on the top
 * level and named for its title, which is the sensible name for it; where it
 * belongs is a drag away, or a button. A link to an address elsewhere is the
 * form below this panel.
 *
 * A page that already has an entry is not offered again: a menu with the same
 * page twice is something the board arrives at on purpose, from the entry's
 * own form, and not something a list of the pages that are missing should
 * make easy to do by mistake.
 */

export interface MenuAddPageProps {
  pages: readonly MenuPage[];
  /** The ids of the pages the menu already has an entry for. */
  inMenu: ReadonlySet<string>;
  add: (page: MenuPage) => Promise<ApiResult<MenuItem>>;
  onAdded: (page: MenuPage) => void;
}

export function MenuAddPage({
  pages,
  inMenu,
  add,
  onAdded,
}: MenuAddPageProps): ReactElement {
  const { t } = useTranslation();
  // The one page being added, so a second press cannot add it twice.
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);

  const missing = pages.filter((page) => !inMenu.has(page.id));

  const press = async (page: MenuPage): Promise<void> => {
    if (adding !== null) {
      return;
    }
    setAdding(page.id);
    setFailure(null);
    const result = await add(page);
    setAdding(null);
    if (result.ok) {
      onAdded(page);
    } else {
      setFailure(
        failureMessageKey(
          result.failure,
          MENU_REASONS,
          "siteAdmin.menu.errors.unknown",
        ),
      );
    }
  };

  return (
    <Panel
      description={t("siteAdmin.menu.addPage.description")}
      title={t("siteAdmin.menu.addPage.heading")}
    >
      {failure === null ? null : (
        <Notice live tone="danger">
          {t(failure)}
        </Notice>
      )}

      {missing.length === 0 ? (
        <Notice tone="info">
          {pages.length === 0
            ? t("siteAdmin.menu.noPages")
            : t("siteAdmin.menu.addPage.allIn")}
        </Notice>
      ) : (
        <ul className="flex flex-col">
          {missing.map((page) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2 first:border-t-0"
              key={page.id}
            >
              <span className="flex flex-col gap-1">
                <span className="text-body text-ink">
                  {page.builtIn === null
                    ? page.title
                    : t("siteAdmin.menu.builtInOption", { title: page.title })}
                </span>
                {page.status === "PUBLIC" ? null : (
                  <span className="text-small text-ink-muted">
                    {t(
                      page.status === "DRAFT"
                        ? "siteAdmin.state.draft"
                        : "siteAdmin.state.memberOnly",
                    )}
                  </span>
                )}
              </span>
              <button
                aria-label={t("siteAdmin.menu.addPage.addFor", {
                  title: page.title,
                })}
                className={SECONDARY_BUTTON}
                disabled={adding !== null}
                onClick={() => {
                  void press(page);
                }}
                type="button"
              >
                {t("siteAdmin.menu.addPage.add")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
