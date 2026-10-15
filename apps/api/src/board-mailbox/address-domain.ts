import { domainToASCII, domainToUnicode } from "node:url";

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

/**
 * Every script Unicode gives characters of their own (Unicode 17), by its
 * ISO 15924 code. Common, Inherited and Unknown are not scripts a lookalike is
 * made of and are not listed. A test holds this list to the runtime's Unicode
 * data, so that a script Unicode adds is not one a warning can be avoided with.
 */
export const SCRIPT_CODES: readonly string[] = `
  Adlm Aghb Ahom Arab Armi Armn Avst Bali Bamu Bass Batk Beng Berf Bhks Bopo
  Brah Brai Bugi Buhd Cakm Cans Cari Cham Cher Chrs Copt Cpmn Cprt Cyrl Deva
  Diak Dogr Dsrt Dupl Egyp Elba Elym Ethi Gara Geor Glag Gong Gonm Goth Gran
  Grek Gujr Gukh Guru Hang Hani Hano Hatr Hebr Hira Hluw Hmng Hmnp Hung Ital
  Java Kali Kana Kawi Khar Khmr Khoj Kits Knda Krai Kthi Lana Laoo Latn Lepc
  Limb Lina Linb Lisu Lyci Lydi Mahj Maka Mand Mani Marc Medf Mend Merc Mero
  Miao Mlym Modi Mong Mroo Mtei Mult Mymr Nagm Nand Narb Nbat Newa Nkoo Nshu
  Ogam Olck Onao Orkh Orya Osge Osma Ougr Palm Pauc Perm Phag Phli Phlp Phnx
  Plrd Prti Rjng Rohg Runr Samr Sarb Saur Sgnw Shaw Shrd Sidd Sidt Sind Sinh
  Sogd Sogo Sora Soyo Sund Sunu Sylo Syrc Tagb Takr Tale Talu Taml Tang Tavt
  Tayo Telu Tfng Tglg Thaa Thai Tibt Tirh Tnsa Todr Tols Toto Tutg Ugar Vaii
  Vith Wara Wcho Xpeo Xsux Yezi Yiii Zanb
`
  .trim()
  .split(/\s+/u);

/**
 * A pattern per script, matched on a character's Script_Extensions, so that a
 * character shared by several scripts (a combining diaeresis, a Japanese
 * prolonged sound mark) is counted as belonging to each of them. A script the
 * runtime does not know yet is left out; its characters then fall to Unknown.
 */
const SCRIPTS = SCRIPT_CODES.flatMap((code) => {
  try {
    return [{ code, pattern: new RegExp(String.raw`\p{scx=${code}}`, "u") }];
  } catch {
    return [];
  }
});

/** A character that belongs with any script, such as a digit or a hyphen. */
const ANY_SCRIPT = /^[\p{sc=Zyyy}\p{sc=Zinh}]$/u;

/**
 * The scripts that a writing system draws on together, which UTS #39 adds to
 * the scripts of a character so that Han, kana and Hangul can be told apart
 * as Chinese, Japanese and Korean.
 */
const WRITING_SYSTEMS: Readonly<Record<string, readonly string[]>> = {
  Hani: ["Hanb", "Jpan", "Kore"],
  Hira: ["Jpan"],
  Kana: ["Jpan"],
  Hang: ["Kore"],
  Bopo: ["Hanb"],
};

/**
 * The scripts a character may be written in (its augmented script set, UTS #39
 * section 5.1), or null when it belongs with any script.
 */
function scriptsOf(character: string): ReadonlySet<string> | null {
  const scripts = new Set<string>();
  for (const { code, pattern } of SCRIPTS) {
    if (pattern.test(character)) {
      scripts.add(code);
      for (const system of WRITING_SYSTEMS[code] ?? []) {
        scripts.add(system);
      }
    }
  }
  if (scripts.size > 0) {
    return scripts;
  }
  return ANY_SCRIPT.test(character) ? null : new Set(["Zzzz"]);
}

/**
 * Scripts that are written together in one language and are no sign of a
 * lookalike (UTS #39, "highly restrictive"): Latin beside Japanese, beside
 * Chinese with Bopomofo, or beside Korean. A domain such as `例え-shop.jp` is
 * ordinary.
 */
const WRITTEN_TOGETHER: readonly ReadonlySet<string>[] = [
  new Set(["Latn", "Jpan"]),
  new Set(["Latn", "Hanb"]),
  new Set(["Latn", "Kore"]),
];

/**
 * Whether one label draws its letters from scripts that are not written
 * together (UTS #39 section 5.2). A label is in one script when some script is
 * shared by every character in it, which is how a combining mark used by Latin
 * and Cyrillic alike stays with the letter it sits on.
 */
function labelMixesScripts(label: string): boolean {
  // Scripts belong to code points, so the label is read one code point at a
  // time and not by what a reader would take for one character.
  const characters: ReadonlySet<string>[] = [];
  for (const character of label) {
    const scripts = scriptsOf(character);
    if (scripts !== null) {
      characters.push(scripts);
    }
  }
  const [first] = characters;
  if (
    first === undefined ||
    [...first].some((script) =>
      characters.every((scripts) => scripts.has(script)),
    )
  ) {
    return false;
  }
  return !WRITTEN_TOGETHER.some((allowed) =>
    characters.every((scripts) =>
      [...scripts].some((script) => allowed.has(script)),
    ),
  );
}

/**
 * The labels of a domain as IDNA reads them: mapped (case, width,
 * normalisation) and split on every dot IDNA takes for one, including the
 * ideographic full stop. A domain that does not convert is split as written.
 */
function labelsOf(domain: string, ascii: string | null): string[] {
  return ascii === null
    ? domain.split(/[.\u3002\uff0e\uff61]/u)
    : domainToUnicode(ascii).split(".");
}

/**
 * An ASCII character a hostname has no use for. Node reads a domain the way a
 * URL reads its host, so `example.test/é` converts to `example.test` and
 * `example.test%41é` to `example.testaé`: what follows a delimiter is dropped
 * or decoded, and the result names a domain the address never had.
 */
const NOT_IN_A_HOSTNAME =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u002c\u002f\u003a-\u0040\u005b-\u005e\u0060\u007b-\u007f]/u;

/**
 * The domain as punycode, or null when it is not one that converts. A domain
 * with a character outside a hostname is not converted at all, so that the
 * result never differs from the domain by more than its spelling.
 */
function toAscii(domain: string): string | null {
  if (NOT_IN_A_HOSTNAME.test(domain)) {
    return null;
  }
  const converted = domainToASCII(domain);
  return converted === "" ? null : converted;
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

  const ascii = toAscii(domain);
  return {
    ascii,
    mixedScript: labelsOf(domain, ascii).some(labelMixesScripts),
  };
}
