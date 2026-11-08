import { normalizeEmail } from "../crypto/personal-data";

/** The domains Google delivers to one account, as the name it is counted by. */
const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const GOOGLE_MAIL_DOMAIN = "gmail.com";

/**
 * The recipient an address reaches, as the reporter-link mail budget counts it.
 *
 * Several spellings reach one inbox: a tag after `+` in the local part, which
 * most providers deliver to the address without it, and at Google dots in the
 * local part and the `googlemail.com` domain, which it ignores. Counted by the
 * address as typed, `someone+1@`, `someone+2@` and so on would each have a
 * budget of their own and the form would mail one stranger without end. So
 * the budget is counted by this form, which drops the tag, and at Google the
 * dots, and names Google's domain one way.
 *
 * For that budget only, and compared in memory, never stored: it is not a
 * normalisation of the stored address, whose blind index is matched against
 * the register and restrictions (`normalizeEmail`), and two people whose
 * addresses fold to one form share a budget rather than lose a mail they
 * would otherwise get. A tag that is the whole local part is dropped too, so
 * those addresses share one budget.
 */
export function reporterLinkRecipient(address: string): string {
  const normalized = normalizeEmail(address);
  const at = normalized.lastIndexOf("@");
  if (at === -1) {
    return normalized;
  }
  let local = normalized.slice(0, at);
  // A trailing dot names the same domain, as DNS reads it.
  let domain = normalized.slice(at + 1).replace(/\.+$/, "");
  const tag = local.indexOf("+");
  if (tag !== -1) {
    local = local.slice(0, tag);
  }
  if (GOOGLE_MAIL_DOMAINS.has(domain)) {
    domain = GOOGLE_MAIL_DOMAIN;
    local = local.replaceAll(".", "");
  }
  return `${local}@${domain}`;
}
