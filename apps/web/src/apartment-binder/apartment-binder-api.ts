import { apiRequest, apiUpload, type ApiResult } from "../api/client";

/**
 * The apartment binder's endpoints, on two paths.
 *
 * These types mirror the API's wire shapes rather than importing the server's,
 * which is the convention across the client: the two travel over HTTP and a
 * shared type would hide the day the wire changed.
 *
 * The two paths are the two ways somebody reaches a binder, and they are kept
 * apart here because they are kept apart on the server: `apartment-binder` is
 * the binder of whoever is asking, decided by the residencies they hold today,
 * and `apartment-binders` is every apartment's, behind a capability a board
 * seat alone confers. Nothing in this module decides which of them a person may
 * call; the server answers that, and answers a binder that is not theirs the
 * same way it answers one that does not exist.
 */

/** What an entry is. The enum's own order, which is the order they are shown. */
export const BINDER_KINDS = [
  "DRAWING",
  "ALTERATION_PERMISSION",
  "WORK_RECORD",
  "INSPECTION",
  "INSTRUCTIONS",
  "OTHER",
] as const;

export type BinderKind = (typeof BINDER_KINDS)[number];

/** Who an entry is addressed to. */
export const BINDER_AUDIENCES = ["TENANT_OWNERS", "HOUSEHOLD"] as const;

export type BinderAudience = (typeof BINDER_AUDIENCES)[number];

/** In what capacity an entry was filed. */
export type BinderFiler = "BOARD" | "TENANT_OWNER";

/**
 * Who filed an entry, as the board's view names them.
 *
 * The same named-to-nobody shape the chat is answered in: a person with
 * protected personal data is named to nobody, and a link the purge has detached
 * is reported as unknown rather than as an empty name. A household's view
 * carries none of this - it is not that the name is hidden there, it is that
 * the answer does not contain one.
 */
export type BinderFilerView =
  | { kind: "person"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** One entry, as whoever lives in the apartment is shown it. */
export interface BinderEntry {
  id: string;
  kind: BinderKind;
  audience: BinderAudience;
  title: string;
  /** The day on the entry as YYYY-MM-DD, or null where it carries none. */
  datedOn: string | null;
  /** In what capacity it was filed. All a household is shown about who. */
  filedAs: BinderFiler;
  /** Whether the reader filed it themselves, which is what offers taking out. */
  filedByYou: boolean;
  fileName: string;
  contentType: string;
  byteSize: number;
  /** A path on this instance's own origin. The media route decides access. */
  url: string;
  /** ISO instant. */
  filedAt: string;
}

/** One entry, as the board is shown it. */
export interface BoardBinderEntry extends Omit<BinderEntry, "filedByYou"> {
  filedBy: BinderFilerView;
}

/** One apartment's binder, as whoever lives there is shown it. */
export interface Binder {
  apartmentId: string;
  /** The designation, as every register document spells it. */
  apartment: string;
  /** Whether the reader holds the apartment, which is what offers the form. */
  isTenantOwner: boolean;
  entries: BinderEntry[];
}

/** One apartment on the board's chooser. */
export interface BoardBinderSummary {
  apartmentId: string;
  apartment: string;
  entries: number;
}

/** One apartment's binder, as the board is shown it. */
export interface BoardBinder {
  apartmentId: string;
  apartment: string;
  /** How many people the binder is shown to today, as two counts. */
  tenantOwners: number;
  otherResidents: number;
  entries: BoardBinderEntry[];
}

/** What is filed, beside the file itself. */
export interface BinderEntryFields {
  kind: BinderKind;
  audience: BinderAudience;
  title: string;
  /** A calendar date as YYYY-MM-DD, or empty where the entry carries none. */
  datedOn: string;
}

/** Every binder this account reads today. Almost always one apartment. */
export function fetchMyBinders(): Promise<ApiResult<Binder[]>> {
  return apiRequest("GET", "/api/apartment-binder");
}

/**
 * Files one entry into a binder this account holds the apartment of.
 *
 * The fields travel in the multipart body ahead of the bytes: the server stops
 * reading at the file part, so a field written after it is one the handler is
 * not guaranteed to have seen.
 */
export function fileInMyBinder(
  apartmentId: string,
  fields: BinderEntryFields,
  file: File,
): Promise<ApiResult<BinderEntry>> {
  return apiUpload(
    "POST",
    `/api/apartment-binder/${encodeURIComponent(apartmentId)}/documents`,
    file,
    fieldsFor(fields),
  );
}

/** Takes out an entry this account filed, on an apartment it still holds. */
export function takeOutOfMyBinder(id: string): Promise<ApiResult<void>> {
  return apiRequest(
    "DELETE",
    `/api/apartment-binder/documents/${encodeURIComponent(id)}`,
  );
}

/** Every apartment, with how many entries its binder holds. */
export function fetchBinders(): Promise<ApiResult<BoardBinderSummary[]>> {
  return apiRequest("GET", "/api/apartment-binders");
}

/** One apartment's whole binder. Every read of one is in the audit log. */
export function fetchBinder(
  apartmentId: string,
): Promise<ApiResult<BoardBinder>> {
  return apiRequest(
    "GET",
    `/api/apartment-binders/${encodeURIComponent(apartmentId)}`,
  );
}

/** Files one entry as the board, into any apartment's binder. */
export function fileAsBoard(
  apartmentId: string,
  fields: BinderEntryFields,
  file: File,
): Promise<ApiResult<BinderEntry>> {
  return apiUpload(
    "POST",
    `/api/apartment-binders/${encodeURIComponent(apartmentId)}/documents`,
    file,
    fieldsFor(fields),
  );
}

/** Takes any entry out, which is how an art. 17 request about one is met. */
export function takeOutAsBoard(id: string): Promise<ApiResult<void>> {
  return apiRequest(
    "DELETE",
    `/api/apartment-binders/documents/${encodeURIComponent(id)}`,
  );
}

/**
 * The fields as the multipart body carries them.
 *
 * A date the form left empty is sent as an empty field rather than left out.
 * The server reads an absent date and an empty one alike as an entry with no
 * day on it, and sending the field either way keeps the two forms on this
 * screen sending the same shape.
 */
function fieldsFor(fields: BinderEntryFields): Record<string, string> {
  return {
    kind: fields.kind,
    audience: fields.audience,
    title: fields.title,
    datedOn: fields.datedOn,
  };
}
