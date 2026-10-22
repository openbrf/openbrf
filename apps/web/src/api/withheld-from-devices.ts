import { apiRequest, type ApiResult } from "./client";

/**
 * Which items an editor shows the register check withholds from devices
 * (ADR 0032).
 *
 * The type mirrors the API's wire shape, as the other modules here do. Each
 * kind has its own route, under the capability its editor already needs, and
 * a support session is refused all four.
 */

/** The editors that show the mark, by the route each asks. */
export type WithheldKind =
  "news" | "events" | "meetings" | "bookable-resources";

/**
 * What an editor shows of an item the check withholds.
 *
 * `words` are the matches it may show, as the text has them. `unshownWords`
 * says the text also names somebody in the register whose words are not
 * shown.
 */
export interface WithheldFromDevices {
  words: string[];
  unshownWords: boolean;
}

export interface WithheldItem {
  id: string;
  withheldFromDevices: WithheldFromDevices;
}

/** The most ids one question may name, as the API caps it. */
export const MAX_WITHHELD_IDS = 200;

/** The withheld items among those named; an item that passes is not listed. */
export function fetchWithheldFromDevices(
  kind: WithheldKind,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ApiResult<{ items: WithheldItem[] }>> {
  const query = new URLSearchParams({ ids: ids.join(",") });
  return apiRequest(
    "GET",
    `/api/withheld-from-devices/${kind}?${query.toString()}`,
    undefined,
    signal === undefined ? {} : { signal },
  );
}
