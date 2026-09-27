/**
 * The setup link's token, on the client side (ADR 0023).
 *
 * The link is `/app/setup#claim=<token>`. A fragment is never sent to a
 * server, so the token reaches no proxy's access log and no `Referer`; the
 * wizard reads it here, takes it out of the address bar, and sends it in the
 * body of the one request that needs it.
 *
 * Between the link and that request it is held in this tab's session storage,
 * so a reload of the wizard - with the fragment already gone - still has it.
 * It is forgotten once the instance is claimed, when it is worth nothing.
 */

/** Where the token is held until the claim. One tab's storage, never shared. */
export const SETUP_CLAIM_STORAGE_KEY = "openbrf.setupClaim";

/**
 * The slice of Web Storage this module needs.
 *
 * Taken as a parameter so tests can hand in one of their own, for the reason
 * theme-mode.ts gives: Node ships Web Storage globals of its own that shadow
 * the ones jsdom provides.
 */
export interface SetupClaimStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * The browser's session storage, when it is usable.
 *
 * Undefined rather than a throw: a private window or a browser that blocks
 * site data throws on access, and the wizard then works from the link alone.
 */
export function browserClaimStorage(): SetupClaimStorage | undefined {
  try {
    const storage = globalThis.sessionStorage;
    return storage === undefined || storage === null ? undefined : storage;
  } catch {
    return undefined;
  }
}

/** The token in a location's fragment (`#claim=<token>`), or null. */
export function claimInFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("claim");
  return token === null || token.trim() === "" ? null : token.trim();
}

/** The token held from an earlier load of the wizard in this tab, or null. */
export function readHeldClaim(
  storage: SetupClaimStorage | undefined = browserClaimStorage(),
): string | null {
  try {
    const held = storage?.getItem(SETUP_CLAIM_STORAGE_KEY) ?? null;
    return held === null || held === "" ? null : held;
  } catch {
    return null;
  }
}

export function holdClaim(
  token: string,
  storage: SetupClaimStorage | undefined = browserClaimStorage(),
): void {
  try {
    storage?.setItem(SETUP_CLAIM_STORAGE_KEY, token);
  } catch {
    // Not held across a reload; the wizard still has it until then.
  }
}

export function forgetClaim(
  storage: SetupClaimStorage | undefined = browserClaimStorage(),
): void {
  try {
    storage?.removeItem(SETUP_CLAIM_STORAGE_KEY);
  } catch {
    // Nothing was held, or nothing can be; either way nothing remains to use.
  }
}
