import { apiRequest, apiUpload, type ApiResult } from "../api/client";

/**
 * The document archive's endpoints.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP and a
 * shared type would hide the day the wire changed.
 */

export type DocumentAudience = "BOARD" | "MEMBER" | "PUBLIC";

/** Every audience, in the order the interface offers them. */
export const DOCUMENT_AUDIENCES: readonly DocumentAudience[] = [
  "PUBLIC",
  "MEMBER",
  "BOARD",
];

export interface ArchivedDocument {
  id: string;
  title: string;
  category: string;
  audience: DocumentAudience;
  fileName: string;
  contentType: string;
  byteSize: number;
  /** A path on this instance's own origin. The media route decides access. */
  url: string;
  /** ISO instant. */
  uploadedAt: string;
}

export interface DocumentFields {
  title: string;
  category: string;
  audience: DocumentAudience;
}

export function fetchDocuments(): Promise<ApiResult<ArchivedDocument[]>> {
  return apiRequest("GET", "/api/documents");
}

/**
 * Files one document.
 *
 * The fields travel in the multipart body beside the bytes, ahead of them:
 * apiUpload writes the fields first because the server stops reading at the
 * file part.
 */
export function fileDocument(
  fields: DocumentFields,
  file: File,
): Promise<ApiResult<ArchivedDocument>> {
  return apiUpload("POST", "/api/documents", file, {
    title: fields.title,
    category: fields.category,
    audience: fields.audience,
  });
}

export function editDocument(
  id: string,
  fields: DocumentFields,
): Promise<ApiResult<ArchivedDocument>> {
  return apiRequest("PUT", `/api/documents/${encodeURIComponent(id)}`, fields);
}

export function removeDocument(id: string): Promise<ApiResult<void>> {
  return apiRequest("DELETE", `/api/documents/${encodeURIComponent(id)}`);
}
