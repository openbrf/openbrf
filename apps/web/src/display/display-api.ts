import { apiRequest, type ApiResult } from "../api/client";

/**
 * The board's display screen (ADR 0050): what a display link may be composed
 * from, and issuing its device token.
 *
 * The shapes mirror the API's answers rather than restating its types, as the
 * devices screen's do.
 */

export interface DisplayLinkOptions {
  /**
   * The bookable resources a screen could show, by name. Those the register
   * check withholds from devices are not among them.
   */
  resources: { id: string; name: string }[];
  /** The language a link that names none shows. */
  defaultLocale: "sv" | "en";
}

/** A token, as issuing answers it: the token itself, this once, and its row. */
export interface IssuedDisplayToken {
  token: string;
  device: { id: string; label: string; issuedAt: string };
}

export function fetchDisplayLinkOptions(): Promise<
  ApiResult<DisplayLinkOptions>
> {
  return apiRequest("GET", "/api/display-links/options");
}

/** Issues a device token for the display route, named by the board. */
export function issueDisplayToken(
  label: string,
): Promise<ApiResult<IssuedDisplayToken>> {
  return apiRequest("POST", "/api/display-links", { label });
}
