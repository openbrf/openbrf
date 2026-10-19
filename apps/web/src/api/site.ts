import type { PageBlock, PluginBlockDeclaration } from "@openbrf/shared";

import { apiRequest, apiUpload, type ApiResult } from "./client";

/**
 * The association's own website, as the board writes it.
 *
 * The page and the requests mirror the API's wire shapes rather than importing
 * the server's, which is the convention across the client: the two travel over
 * HTTP, and a shared type would hide the day the wire changed. The blocks are
 * the exception, because they are not the server's: each block type is
 * declared once in @openbrf/shared, and the API and this editor both read that
 * declaration (ADR 0006).
 *
 * The body is the server's block JSON and nothing else. The editor's own
 * document is a working shape that never leaves the browser: what is stored is
 * blocks, so a page cannot carry markup into the renderer whatever library the
 * board typed it in.
 */

export type {
  AssociationFactsBlock,
  BoardRosterBlock,
  ContactFormBlock,
  ControllerContactBlock,
  DocumentListBlock,
  EventCalendarBlock,
  FaqBlock,
  FaqItem,
  HeadingBlock,
  ImageBlock,
  IssueReportFormBlock,
  NewsTeaserBlock,
  PageBlock,
  ParagraphBlock,
  PluginBlockDeclaration,
  TextRun,
  UnregisteredBlock,
} from "@openbrf/shared";

/**
 * Whether a page is on the website, and who may read it there: a draft only
 * the board sees, a page for anyone signed in, or a page for everyone.
 */
export type PageStatus = "DRAFT" | "MEMBERS_ONLY" | "PUBLIC";

/** Every status, in the order the editor offers them. */
export const PAGE_STATUSES: readonly PageStatus[] = [
  "DRAFT",
  "MEMBERS_ONLY",
  "PUBLIC",
];

export interface PageContent {
  version: number;
  blocks: PageBlock[];
}

/**
 * The pages the platform writes rather than the board: the news index, the
 * calendar, the broker information page and the account request form.
 */
export type BuiltInPage =
  "NEWS" | "CALENDAR" | "BROKER_INFORMATION" | "REQUEST_ACCOUNT";

export interface AdminPage {
  id: string;
  slug: string;
  title: string;
  content: PageContent;
  status: PageStatus;
  /** Whether the root of the website serves this page. */
  frontPage: boolean;
  /**
   * Whether a new title still moves the address: true until the page is first
   * published or the board writes an address by hand.
   */
  slugFollowsTitle: boolean;
  /**
   * Which built-in page this is, or null for one the board wrote. Only a
   * built-in page's title can be written: its body stays empty, its address
   * is fixed and it is always public.
   */
  builtIn: BuiltInPage | null;
  publishedAt: string | null;
  sortOrder: number;
  /** What this copy is, for a save that means to write it back. */
  revision: number;
  updatedAt: string;
}

export interface NewPage {
  /** Left out, the page takes its address from its title. */
  slug?: string;
  title: string;
  content: { blocks: PageBlock[] };
}

export interface PageEdit {
  /**
   * An address the board wrote by hand, which the page keeps from then on.
   * Left out, the page keeps its address - or moves it with the title while
   * it still follows it.
   */
  slug?: string;
  title: string;
  content: { blocks: PageBlock[] };
  photoConsentConfirmed?: boolean;
  /**
   * The page's revision as this caller last read it.
   *
   * A save carries the whole page, so two callers who each read it and then
   * wrote would leave the second one's copy standing and the first one's work
   * gone. Sending it asks the server to write only if the page is still the one
   * that was read, and to answer `page-changed` if it is not.
   */
  expectedRevision?: number;
}

/** A stored picture, as the editor refers to it. */
export interface SiteImage {
  id: string;
  /** A path on this instance's own origin. */
  url: string;
  showsIdentifiablePersons: boolean;
}

const PAGES = "/api/site/pages";

function pagePath(id: string, suffix = ""): string {
  return `${PAGES}/${encodeURIComponent(id)}${suffix}`;
}

export function fetchPages(): Promise<ApiResult<AdminPage[]>> {
  return apiRequest("GET", PAGES);
}

/**
 * The website blocks the serving plugins add, as the page editor offers them.
 *
 * The core's blocks are compiled into the editor; a plugin's are known only
 * to the running instance, and only while the plugin is serving.
 */
export function fetchPluginBlocks(): Promise<
  ApiResult<{ blocks: PluginBlockDeclaration[] }>
> {
  return apiRequest("GET", "/api/site/blocks");
}

export function createPage(page: NewPage): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", PAGES, page);
}

export function savePage(
  id: string,
  edit: PageEdit,
): Promise<ApiResult<AdminPage>> {
  return apiRequest("PUT", pagePath(id), edit);
}

export function setPageStatus(
  id: string,
  input: {
    status: PageStatus;
    photoConsentConfirmed?: boolean;
    /** @see PageEdit.expectedRevision */
    expectedRevision?: number;
  },
): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", pagePath(id, "/status"), input);
}

/** Makes the page the front page, in place of the one before it. */
export function setFrontPage(
  id: string,
  input: { expectedRevision?: number } = {},
): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", pagePath(id, "/front-page"), input);
}

export function reorderPages(
  ids: readonly string[],
): Promise<ApiResult<AdminPage[]>> {
  return apiRequest("POST", `${PAGES}/order`, { ids });
}

/**
 * Removes a page, refused where somebody else has written it since.
 *
 * The precondition travels as a query parameter, because a DELETE carries no
 * body here: it is the one route of the four that has nowhere else to put it.
 */
export function deletePage(
  id: string,
  input: { expectedRevision?: number } = {},
): Promise<ApiResult<void>> {
  return apiRequest(
    "DELETE",
    input.expectedRevision === undefined
      ? pagePath(id)
      : `${pagePath(id)}?expectedRevision=${String(input.expectedRevision)}`,
  );
}

/**
 * The page as the website would render it.
 *
 * HTML from the server's own renderer, shown in a sandboxed frame. There is no
 * second renderer in the browser, so what the board previews is what a visitor
 * would be served.
 */
export function previewPage(input: {
  slug?: string;
  title: string;
  content: { blocks: PageBlock[] };
}): Promise<ApiResult<{ html: string }>> {
  return apiRequest("POST", `${PAGES}/preview`, input);
}

/**
 * Uploads a picture for the website.
 *
 * The declaration travels with the bytes because the media layer requires it of
 * every image, and because it is what the publication guardrail acts on: an
 * image nobody has declared cannot be checked against a publication consent.
 */
export function uploadSiteImage(
  file: File,
  showsIdentifiablePersons: boolean,
): Promise<ApiResult<SiteImage>> {
  return apiUpload("POST", "/api/site/images", file, {
    showsIdentifiablePersons: showsIdentifiablePersons ? "true" : "false",
  });
}
