import { apiRequest, type ApiResult } from "../api/client";

/**
 * The site menu's endpoints.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP and a
 * shared type would hide the day the wire changed.
 */

export type MenuItemKind = "PAGE" | "GENERATED" | "EXTERNAL";

/** Every kind, in the order the form offers them. */
export const MENU_ITEM_KINDS: readonly MenuItemKind[] = [
  "PAGE",
  "GENERATED",
  "EXTERNAL",
];

export type MenuGeneratedKey = "news" | "broker" | "requestAccount";

/**
 * The generated destinations the board can put in the menu.
 *
 * Offered whether or not the instance has the page yet: an entry for a page
 * that does not exist is silently left out of the rendered menu, so a board
 * can arrange the menu it wants and the website catches up. The screen says so
 * beside the choice rather than hiding it.
 */
export const MENU_GENERATED_KEYS: readonly MenuGeneratedKey[] = [
  "news",
  "broker",
  "requestAccount",
];

export type PageVisibility = "PUBLIC" | "MEMBER";

export interface MenuItem {
  id: string;
  label: string;
  kind: MenuItemKind;
  parentId: string | null;
  sortOrder: number;
  pageId: string | null;
  generatedKey: string | null;
  url: string | null;
  /** The page's own state, when the entry points at one. */
  page: {
    slug: string;
    title: string;
    published: boolean;
    visibility: PageVisibility;
  } | null;
}

/** A page as the menu editor needs it: enough to name it and to pick it. */
export interface MenuPage {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  visibility: PageVisibility;
}

export interface MenuItemFields {
  kind: MenuItemKind;
  label: string;
  pageId?: string;
  generatedKey?: string;
  url?: string;
  parentId?: string | null;
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
 * Puts one level in the order the ids arrive in.
 *
 * The level is named, so a reorder cannot move an entry between levels by
 * accident - that is what changing its parent is for.
 */
export function orderMenu(
  parentId: string | null,
  ids: readonly string[],
): Promise<ApiResult<MenuItem[]>> {
  return apiRequest("POST", "/api/site/menu/order", { parentId, ids });
}
