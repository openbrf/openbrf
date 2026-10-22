import type { TFunction } from "i18next";

import type { BuiltInPage } from "../api/site";

/** A page as a list of pages to choose from needs it. */
export interface PageOption {
  id: string;
  title: string;
  builtIn: BuiltInPage | null;
}

/**
 * A page as a list of pages to choose from names it.
 *
 * By the title the board gave it, a built-in page's too: that is the name the
 * board chose for it, and the one its menu entry shows. A built-in page is
 * marked as one, so the board can tell the news index from a page of its own
 * called "Nyheter".
 */
export function pageOptionName(t: TFunction, page: PageOption): string {
  return page.builtIn === null
    ? page.title
    : t("siteAdmin.builtIn.option", { title: page.title });
}
