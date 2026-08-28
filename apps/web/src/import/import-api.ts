import { apiRequest, type ApiResult } from "../api/client";

/**
 * The import, as the browser sees it.
 *
 * Mirrors `apps/api/src/import/import.service.ts`. One property of the contract
 * is load-bearing and invisible in the types: a previewed row reports whether
 * the file holds a personal identity number and never the number itself. A
 * preview is not a register view, and DESIGN.md keeps identity numbers out of
 * every screen that is not one.
 */

export const IMPORT_FIELDS = [
  "addressLabel",
  "apartmentNumber",
  "firstName",
  "lastName",
  "fullName",
  "role",
  "email",
  "phone",
  "personalIdentityNumber",
  "postalStreet",
  "postalCode",
  "postalCity",
  "movedInOn",
  "movedOutOn",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export type ImportOutcome = "create" | "update" | "ambiguous" | "error";

export type ImportMatchKey =
  "personalIdentityNumber" | "email" | "apartmentAndName" | "earlierRow";

export interface ImportSessionView {
  sessionId: string;
  fileName: string;
  format: "CSV" | "XLSX";
  columns: string[];
  rowCount: number;
  sample: string[][];
  suggestedMapping: (ImportField | null)[];
  expiresAt: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  outcome: ImportOutcome;
  person: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    hasPersonalIdentityNumber: boolean;
    postalStreet: string | null;
    postalCode: string | null;
    postalCity: string | null;
  };
  apartment: { id: string; number: string; addressLabel: string } | null;
  role: "MEMBER" | "RESIDENT" | null;
  movedInOn: string | null;
  movedOutOn: string | null;
  matchedPersonId: string | null;
  matchedBy: ImportMatchKey | null;
  sameAsRowNumber: number | null;
  candidates: { personId: string; name: string }[];
  problems: { field: ImportField | null; reason: string }[];
}

export interface ImportPreview {
  sessionId: string;
  summary: Record<ImportOutcome, number>;
  rows: ImportPreviewRow[];
}

export interface ImportApplyResult {
  personsCreated: number;
  personsUpdated: number;
  residenciesCreated: number;
  memberRegisterEntriesCreated: number;
  skipped: number;
  errors: number;
}

export type ImportDecision =
  | { action: "use-person"; personId: string }
  | { action: "create" }
  | { action: "skip" };

export interface ImportMappingInput {
  mapping: (ImportField | null)[];
  defaultRole: "MEMBER" | "RESIDENT" | null;
  defaultMovedInOn: string | null;
}

/** Where the template lives. A plain link, so the browser saves the file. */
export const IMPORT_TEMPLATE_URL = "/api/import/template";

export function uploadImport(input: {
  fileName: string;
  /** The file, base64 encoded. */
  content: string;
}): Promise<ApiResult<ImportSessionView>> {
  return apiRequest("POST", "/api/import/sessions", input);
}

export function previewImport(
  sessionId: string,
  input: ImportMappingInput,
): Promise<ApiResult<ImportPreview>> {
  return apiRequest(
    "POST",
    `/api/import/sessions/${encodeURIComponent(sessionId)}/preview`,
    input,
  );
}

export function applyImport(
  sessionId: string,
  input: ImportMappingInput & { decisions: Record<string, ImportDecision> },
): Promise<ApiResult<ImportApplyResult>> {
  return apiRequest(
    "POST",
    `/api/import/sessions/${encodeURIComponent(sessionId)}/apply`,
    input,
  );
}

/**
 * Reads a file into base64 for upload.
 *
 * The file goes up inside a JSON body rather than as a multipart form: a member
 * list is a handful of kilobytes, and one transport for every request is one
 * fewer thing to get wrong on the way to a register that cannot be edited.
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("The file could not be read."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("The file could not be read."));
        return;
      }
      // A data URL, so the base64 payload starts after the comma.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
