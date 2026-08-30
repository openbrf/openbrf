import { apiRequest, apiUpload, type ApiResult } from "./client";

/**
 * The association's own website, as the board writes it.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP, and a
 * shared type would hide the day the wire changed.
 *
 * The body is the server's block JSON and nothing else. The editor's own
 * document is a working shape that never leaves the browser: what is stored is
 * blocks, so a page cannot carry markup into the renderer whatever library the
 * board typed it in.
 */

export type PageVisibility = "PUBLIC" | "MEMBER";

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** http, https, mailto or a path on this instance. The API refuses the rest. */
  link?: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  runs: TextRun[];
}

export interface HeadingBlock {
  type: "heading";
  /** Two or three: the page's title is its only first-level heading. */
  level: 2 | 3;
  runs: TextRun[];
}

export interface ImageBlock {
  type: "image";
  mediaFileId: string;
  alt: string;
  caption?: string;
}

/**
 * The blocks that carry no content of their own.
 *
 * Each names something the instance already holds, and what it becomes is
 * resolved by the website when the page is rendered, against the reader. The
 * editor arranges them and never fills them in: a document list showing the
 * board's own shelf, or a roster of people who have not consented, would be a
 * page that reads differently for the person who wrote it than for the street.
 */
export interface DocumentListBlock {
  type: "documentList";
  /** The binder to list, or absent for everything the reader may see. */
  category?: string;
}

export interface BoardRosterBlock {
  type: "boardRoster";
}

export interface AssociationFactsBlock {
  type: "associationFacts";
}

/** One question the association answers, and its answer as one paragraph. */
export interface FaqItem {
  question: string;
  answer: TextRun[];
}

export interface FaqBlock {
  type: "faq";
  items: FaqItem[];
}

/**
 * The two public forms and the news teaser, which have no editor of their own.
 *
 * Named here all the same, because a page can carry one - the API accepts them
 * and the website renders them - and a union that did not know about them would
 * make the editor's own switches unable to describe a page it had been handed.
 * The editor shows such a block as itself, with its position and the controls
 * for moving it, and offers no fields: there are none to offer.
 */
export interface ContactFormBlock {
  type: "contactForm";
  intro?: TextRun[];
}

export interface IssueReportFormBlock {
  type: "issueReportForm";
  intro?: TextRun[];
}

export interface NewsTeaserBlock {
  type: "newsTeaser";
  count: number;
}

export type PageBlock =
  | ParagraphBlock
  | HeadingBlock
  | ImageBlock
  | ContactFormBlock
  | IssueReportFormBlock
  | NewsTeaserBlock
  | DocumentListBlock
  | BoardRosterBlock
  | AssociationFactsBlock
  | FaqBlock;

export interface PageContent {
  version: number;
  blocks: PageBlock[];
}

export interface AdminPage {
  id: string;
  slug: string;
  title: string;
  content: PageContent;
  visibility: PageVisibility;
  published: boolean;
  publishedAt: string | null;
  sortOrder: number;
  updatedAt: string;
}

export interface NewPage {
  slug: string;
  title: string;
  content: { blocks: PageBlock[] };
  visibility: PageVisibility;
}

export interface PageEdit {
  slug: string;
  title: string;
  content: { blocks: PageBlock[] };
  photoConsentConfirmed?: boolean;
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

export function createPage(page: NewPage): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", PAGES, page);
}

export function savePage(
  id: string,
  edit: PageEdit,
): Promise<ApiResult<AdminPage>> {
  return apiRequest("PUT", pagePath(id), edit);
}

export function publishPage(
  id: string,
  input: { published: boolean; photoConsentConfirmed?: boolean },
): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", pagePath(id, "/publish"), input);
}

export function setPageVisibility(
  id: string,
  input: { visibility: PageVisibility; photoConsentConfirmed?: boolean },
): Promise<ApiResult<AdminPage>> {
  return apiRequest("POST", pagePath(id, "/visibility"), input);
}

export function reorderPages(
  ids: readonly string[],
): Promise<ApiResult<AdminPage[]>> {
  return apiRequest("POST", `${PAGES}/order`, { ids });
}

export function deletePage(id: string): Promise<ApiResult<void>> {
  return apiRequest("DELETE", pagePath(id));
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
