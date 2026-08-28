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

export type ImportRunStatus =
  "MAPPING" | "QUEUED" | "APPLYING" | "APPLIED" | "FAILED";

/**
 * An import as it runs.
 *
 * The register write happens in a background job, so this is what the screen
 * watches and what it finds again after a reload: the counts are what the job
 * has committed so far, not a prediction, and `rowsDone` against `rowsTotal` is
 * how far through the file it is.
 */
export interface ImportRunView {
  sessionId: string;
  fileName: string;
  status: ImportRunStatus;
  rowsDone: number;
  rowsTotal: number;
  result: ImportApplyResult;
  /** The API's code for why it stopped early, or null. */
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * An import that has left the mapping step.
 *
 * The distinction is worth a type: a session still being mapped has no run to
 * describe, and the screen shows it the mapping step rather than a progress bar
 * for something that has not started.
 */
export interface StartedImportRun extends Omit<ImportRunView, "status"> {
  status: Exclude<ImportRunStatus, "MAPPING">;
}

/** Whether the job still has work to do, and the screen still has to watch. */
export function isImportRunning(status: ImportRunStatus): boolean {
  return status === "QUEUED" || status === "APPLYING";
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

/**
 * Starts the import.
 *
 * Only the decisions go up: the mapping the apply runs is the one the preview
 * was taken with, so what is written is what the board looked at. The answer is
 * the run to watch rather than a result, because nothing has been written yet.
 */
export function applyImport(
  sessionId: string,
  input: { decisions: Record<string, ImportDecision> },
): Promise<ApiResult<ImportRunView>> {
  return apiRequest(
    "POST",
    `/api/import/sessions/${encodeURIComponent(sessionId)}/apply`,
    input,
  );
}

/** How far the import has got. */
export function fetchImportRun(
  sessionId: string,
): Promise<ApiResult<ImportRunView>> {
  return apiRequest(
    "GET",
    `/api/import/sessions/${encodeURIComponent(sessionId)}/run`,
  );
}

/**
 * The import that is running, or the last one that ran.
 *
 * Asked for on load, because a board member who closed the tab has no session
 * id left to ask with and still has to be able to see what happened.
 */
export function fetchActiveImport(): Promise<ApiResult<ImportRunView | null>> {
  return apiRequest("GET", "/api/import/sessions/active");
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
