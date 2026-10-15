import { domainToASCII } from "node:url";

/**
 * What the board needs to tell an internationalised sender domain from the
 * ASCII one it resembles.
 *
 * Present only when the domain is not plain ASCII: an ASCII domain is its own
 * identity and has nothing to add.
 */
export interface AddressDomainIdentity {
  /**
   * The domain as the mail system addresses it (punycode), so that a Cyrillic
   * "е" shows as `xn--...` next to the Latin "e" it passes for. Null when the
   * domain is not one that converts, which the board should treat as a reason
   * for care and not as a reason to hide it.
   */
  ascii: string | null;
  /** Whether a single label mixes scripts, which is how a lookalike is made. */
  mixedScript: boolean;
}

const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Hebrew",
  "Arabic",
  "Devanagari",
  "Bengali",
  "Thai",
  "Georgian",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
  "Bopomofo",
].map((script) => ({
  script,
  pattern: new RegExp(String.raw`\p{Script_Extensions=${script}}`, "u"),
}));

/**
 * Scripts that are written together in one language and are no sign of a
 * lookalike (UTS #39, "highly restrictive"). Latin is allowed beside each,
 * because a domain such as `例え-shop.jp` is ordinary.
 */
const WRITTEN_TOGETHER: readonly ReadonlySet<string>[] = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];

/** Whether one label draws its letters from scripts that are not written together. */
function labelMixesScripts(label: string): boolean {
  const used = new Set<string>();
  for (const character of label) {
    for (const { script, pattern } of SCRIPTS) {
      if (pattern.test(character)) {
        used.add(script);
      }
    }
  }
  if (used.size <= 1) {
    return false;
  }
  return !WRITTEN_TOGETHER.some((allowed) =>
    [...used].every((script) => allowed.has(script)),
  );
}

/**
 * The identity of the domain of an address, for an address whose domain is not
 * ASCII, or null when it is.
 *
 * Nothing here decides whether the sender is who they appear to be, and the
 * address is never rewritten: a legitimate `münchen.de` or `почта.рф` is
 * returned with its punycode form and no warning. A label that mixes scripts
 * (a Latin "x" beside a Cyrillic "е") is flagged, because that is what a domain
 * built to pass for another one looks like. A domain written wholly in one
 * script cannot be told from its lookalike by this, which is why the punycode
 * form is shown for every internationalised domain.
 */
export function addressDomainIdentity(
  address: string,
): AddressDomainIdentity | null {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(domain)) {
    return null;
  }

  const ascii = domainToASCII(domain);
  return {
    ascii: ascii === "" ? null : ascii,
    mixedScript: domain.split(".").some(labelMixesScripts),
  };
}
