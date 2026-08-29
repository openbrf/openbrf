import { apiRequest, type ApiResult } from "../api/client";

/**
 * The news endpoints.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP and a
 * shared type would hide the day the wire changed.
 */

export type NewsVisibility = "PUBLIC" | "MEMBER";

/** A stretch of text carrying its marks, exactly as the API stores it. */
export interface NewsRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

export type NewsBlock =
  | { type: "paragraph"; runs: NewsRun[] }
  | { type: "heading"; level: 2 | 3; runs: NewsRun[] };

export interface NewsContent {
  blocks: NewsBlock[];
}

/** How far a mailing got, as the board's screen reports it. */
export interface NewsDeliveryReport {
  pending: number;
  sent: number;
  failed: number;
  /** At least one delivery failed because the instance has no mail server. */
  mailNotConfigured: boolean;
}

export interface NewsItem {
  id: string;
  slug: string;
  title: string;
  content: NewsContent;
  visibility: NewsVisibility;
  published: boolean;
  /** ISO instant, or null while it has never been published. */
  publishedAt: string | null;
  /**
   * ISO instant the mailing was claimed, or null. Null is what says a mailing
   * is still possible: the column is written once and never cleared, so an
   * item that carries a date here will not be mailed again whatever is done
   * to it.
   */
  emailQueuedAt: string | null;
  delivery: NewsDeliveryReport;
  updatedAt: string;
}

export interface PublishedNewsItem extends NewsItem {
  /** How many members the mailing was claimed for, or null if none was. */
  mailedTo: number | null;
}

export interface NewsFields {
  slug: string;
  title: string;
  content: NewsContent;
}

export interface PublishFields {
  published: boolean;
  visibility?: NewsVisibility;
  sendEmail?: boolean;
}

export function fetchNews(): Promise<ApiResult<NewsItem[]>> {
  return apiRequest("GET", "/api/news");
}

/** How many members a mailing would reach, right now. */
export function fetchRecipientCount(): Promise<ApiResult<{ count: number }>> {
  return apiRequest("GET", "/api/news/recipients");
}

export function createNews(fields: NewsFields): Promise<ApiResult<NewsItem>> {
  return apiRequest("POST", "/api/news", fields);
}

export function editNews(
  id: string,
  fields: NewsFields,
): Promise<ApiResult<NewsItem>> {
  return apiRequest("PUT", `/api/news/${encodeURIComponent(id)}`, fields);
}

export function publishNews(
  id: string,
  fields: PublishFields,
): Promise<ApiResult<PublishedNewsItem>> {
  return apiRequest(
    "POST",
    `/api/news/${encodeURIComponent(id)}/publish`,
    fields,
  );
}

export function removeNews(id: string): Promise<ApiResult<void>> {
  return apiRequest("DELETE", `/api/news/${encodeURIComponent(id)}`);
}
