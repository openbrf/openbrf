import { apiRequest, type ApiResult } from "../api/client";
import type { BuiltInPage } from "../api/site";
import type { MenuPlacement } from "./menu-arrangement";

/**
 * The site menu's endpoints.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP and a
 * shared type would hide the day the wire changed.
 */

export type MenuItemKind = "PAGE" | "EXTERNAL";

/**
 * Every kind, in the order the form offers them. The news index, the
 * calendar, the broker information page and the account request form are
 * built-in pages, chosen from the pages like any other.
 */
export const MENU_ITEM_KINDS: readonly MenuItemKind[] = ["PAGE", "EXTERNAL"];

/** A page's status, as the API names it. */
export type PageStatus = "DRAFT" | "MEMBERS_ONLY" | "PUBLIC";

/**
 * As long a label as fits a menu on a telephone.
 *
 * The server holds the same number and refuses a longer one; the field carries
 * it too so the board is stopped while typing rather than told afterwards.
 * Written out here rather than imported, like the wire shapes above.
 */
export const MENU_LABEL_LIMIT = 60;

export interface MenuItem {
  id: string;
  label: string;
  kind: MenuItemKind;
  parentId: string | null;
  sortOrder: number;
  pageId: string | null;
  url: string | null;
  /** Whether the board keeps the entry for signed-in visitors alone. */
  membersOnly: boolean;
  /** The page's own state, when the entry points at one. */
  page: {
    slug: string;
    title: string;
    status: PageStatus;
    builtIn: BuiltInPage | null;
  } | null;
}

/** A page as the menu editor needs it: enough to name it and to pick it. */
export interface MenuPage {
  id: string;
  slug: string;
  title: string;
  status: PageStatus;
  builtIn: BuiltInPage | null;
}

export interface MenuItemFields {
  kind: MenuItemKind;
  label: string;
  pageId?: string;
  url?: string;
  parentId?: string | null;
  membersOnly?: boolean;
}

export function fetchMenu(): Promise<ApiResult<MenuItem[]>> {
  return apiRequest("GET", "/api/site/menu");
}

/** The association's pages, as the entry form's choices. */
export function fetchMenuPages(): Promise<ApiResult<MenuPage[]>> {
  return apiRequest("GET", "/api/site/pages");
}

export function addMenuItem(
  fields: MenuItemFields,
): Promise<ApiResult<MenuItem>> {
  return apiRequest("POST", "/api/site/menu", fields);
}

export function saveMenuItem(
  id: string,
  fields: MenuItemFields,
): Promise<ApiResult<MenuItem>> {
  return apiRequest("PUT", `/api/site/menu/${encodeURIComponent(id)}`, fields);
}

export function removeMenuItem(id: string): Promise<ApiResult<void>> {
  return apiRequest("DELETE", `/api/site/menu/${encodeURIComponent(id)}`);
}

/**
 * Puts the whole menu in the arrangement it is given: every entry in reading
 * order, each naming the top-level entry it hangs under.
 *
 * The whole menu rather than the entry that moved, so a drag that changes an
 * entry's place and its level is one write that either happens or does not.
 * Answered `menu-changed` when the entries it names are not the ones the menu
 * has, which is somebody else having changed it since it was read.
 */
export function arrangeMenu(
  items: readonly MenuPlacement[],
): Promise<ApiResult<MenuItem[]>> {
  return apiRequest("POST", "/api/site/menu/arrange", { items });
}
