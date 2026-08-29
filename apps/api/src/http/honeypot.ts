import { randomBytes } from "node:crypto";

/**
 * The honeypot convention for the forms anyone can reach.
 *
 * A public form carries one extra text field that no person ever sees and no
 * assistive technology ever announces. A script filling in every input it finds
 * fills that one too, and a submission carrying it is dropped - answered
 * exactly as a stored one would be, so nothing in the response tells the script
 * that this form has a decoy in it or which field it is.
 *
 * The field is rendered by every side that renders one of these forms, and each
 * has to render it the same way: hidden from the screen, `aria-hidden` so it is
 * absent from the accessibility tree, and `tabindex="-1"` so it is absent from
 * the tab order. A resident using a screen reader must never be offered it,
 * because they would fill it in honestly and have their request silently
 * dropped. Hiding the input alone while its label stays on the page is the
 * mistake that does exactly that.
 *
 * It is one layer and not a wall: it stops the scripts that submit forms
 * without reading them, which is most of them, and nothing else. The
 * per-address budget in `public-rate-limit.decorator.ts` is what bounds the
 * rest. Neither is a CAPTCHA, and neither becomes one.
 */

/**
 * The decoy's field name, chosen to look like a field a form might have and to
 * be one no browser autofills: a filled honeypot has to mean a script, never a
 * password manager being helpful on a resident's behalf.
 */
export const HONEYPOT_FIELD = "website";

/** Whether a submitted body filled the decoy in. */
export function isHoneypotFilled(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const value = (body as Record<string, unknown>)[HONEYPOT_FIELD];
  // Whitespace is not a filled field: a browser that submits the empty value it
  // was rendered with has not fallen for anything.
  return typeof value === "string" && value.trim() !== "";
}

/**
 * An identifier for a submission that was never stored.
 *
 * The answer to a dropped submission has to be the answer to a stored one, down
 * to the shape of the identifier in it. The database's own identifiers are
 * cuids - a `c` and twenty-four base-36 digits - so this is one too, drawn from
 * the system's random source and referring to nothing at all.
 */
export function droppedSubmissionId(): string {
  const digits = BigInt(`0x${randomBytes(16).toString("hex")}`)
    .toString(36)
    .padStart(24, "0");
  return `c${digits.slice(-24)}`;
}
