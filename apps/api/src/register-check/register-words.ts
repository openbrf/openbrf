/**
 * Finding the register's words in a text: names and apartment numbers as words,
 * and the email addresses and phone numbers a text might hold (ADR 0032).
 *
 * Pure. What the register holds is handed in, and the email addresses and phone
 * numbers are only cut out of the text here: whether one of them is in the
 * register is a blind index lookup, which is the service's.
 */

/** A name or an apartment number as the check looks for it. */
interface RegisterTerm {
  /** Its words, folded, in order. */
  readonly words: readonly string[];
  /**
   * A given name. It matches only where its first word begins with a capital
   * letter in the text, because several Swedish given names are everyday words
   * as well (Per, Bo).
   */
  readonly capitalOnly: boolean;
  /** Whether every person it is the name of has protected personal data. */
  readonly protectedOnly: boolean;
  /**
   * A name, which matches in the genitive as well: "Svenssons grill" names
   * Svensson as surely as "Svensson" does.
   */
  readonly genitive: boolean;
}

/** One person's name as the register holds it. */
export interface RegisterName {
  readonly givenName: string;
  readonly familyName: string;
  readonly protectedPersonalData: boolean;
}

/** The register's names and apartment numbers, ready to be looked for. */
export interface RegisterWords {
  /** The terms, by their first folded word. */
  readonly byFirstWord: ReadonlyMap<string, readonly RegisterTerm[]>;
}

/**
 * A place in a text where the register's words were found.
 *
 * `words` is the text's own spelling, for the editor to show. `protectedOnly`
 * says the words are the name of nobody but persons with protected personal
 * data, whose words the editor does not show.
 */
export interface RegisterWordMatch {
  readonly words: string;
  readonly protectedOnly: boolean;
}

/**
 * The text as it is checked: compatibility forms folded (a full-width letter is
 * the letter) and invisible characters taken out, so that a soft hyphen or a
 * zero-width space inside a name does not hide it.
 */
export function checkedText(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/**
 * The words of a text, with where each starts and ends.
 *
 * A word is a run of letters or a run of digits, so a hyphen, an apostrophe or
 * a change from letters to digits ends one: "lgh1101" is the words "lgh" and
 * "1101", and "Svensson-Berg" is "Svensson" and "Berg".
 */
function wordsOf(
  text: string,
): { word: string; folded: string; start: number; end: number }[] {
  const words: { word: string; folded: string; start: number; end: number }[] =
    [];
  for (const match of text.matchAll(/\p{L}[\p{L}\p{M}]*|\p{N}+/gu)) {
    words.push({
      word: match[0],
      folded: fold(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

function fold(word: string): string {
  return word.toLowerCase();
}

const CAPITAL = /^\p{Lu}/u;

/**
 * The register's names and apartment numbers, as terms.
 *
 * Each given name counts word by word, so that "Anna Maria" is found as
 * "Maria" as well. Each family name counts whole, and word by word where the
 * register writes the word with a capital, so that "Svensson Berg" is found as
 * "Berg" while the "von" of "von Platen" is not a name on its own. The whole
 * name counts too. A word of one letter never counts on its own: it is an
 * initial, and found as one it would withhold every text with an "A" in it.
 */
export function registerWordsOf(
  names: readonly RegisterName[],
  apartmentNumbers: readonly string[],
): RegisterWords {
  const terms = new Map<
    string,
    {
      words: string[];
      capitalOnly: boolean;
      protectedOnly: boolean;
      genitive: boolean;
    }
  >();
  const add = (
    words: readonly string[],
    capitalOnly: boolean,
    protectedOnly: boolean,
    genitive = true,
  ): void => {
    const [first] = words;
    if (first === undefined || (words.length === 1 && first.length < 2)) {
      return;
    }
    const key = `${capitalOnly ? "^" : ""}${words.join(" ")}`;
    const known = terms.get(key);
    if (known === undefined) {
      terms.set(key, {
        words: [...words],
        capitalOnly,
        protectedOnly,
        genitive,
      });
    } else {
      known.protectedOnly &&= protectedOnly;
      known.genitive ||= genitive;
    }
  };

  for (const name of names) {
    const given = wordsOf(checkedText(name.givenName));
    const family = wordsOf(checkedText(name.familyName));
    const isProtected = name.protectedPersonalData;
    for (const word of given) {
      add([word.folded], true, isProtected);
    }
    add(
      family.map((word) => word.folded),
      false,
      isProtected,
    );
    for (const word of family) {
      if (CAPITAL.test(word.word)) {
        add([word.folded], false, isProtected);
      }
    }
    add(
      [...given, ...family].map((word) => word.folded),
      false,
      isProtected,
    );
  }
  for (const number of apartmentNumbers) {
    add(
      wordsOf(checkedText(number)).map((word) => word.folded),
      false,
      false,
      false,
    );
  }

  const byFirstWord = new Map<string, RegisterTerm[]>();
  for (const term of terms.values()) {
    const [first = ""] = term.words;
    const list = byFirstWord.get(first);
    if (list === undefined) {
      byFirstWord.set(first, [term]);
    } else {
      list.push(term);
    }
  }
  return { byFirstWord };
}

/**
 * Where a text holds a name or an apartment number of the register.
 *
 * A term matches whole words only and ignores case, a given name only where it
 * begins with a capital, and a name in the genitive as well ("Svenssons",
 * "Annas"), which errs towards leaving an item out as ADR 0032 does. The matches are reported word by word rather than
 * term by term: a run of words that a term of somebody without protected
 * personal data covers is one match the editor may show, so that "Anna
 * Svensson" is one match and not three, and a run that only the terms of
 * persons with protected personal data cover is one it may not. A protected
 * word is never shown because a shown name stands next to it.
 */
export function findRegisterWords(
  text: string,
  register: RegisterWords,
): RegisterWordMatch[] {
  const checked = checkedText(text);
  const words = wordsOf(checked);
  /** For each word: not found, found and showable, or found and protected. */
  const found: ("shown" | "protected" | undefined)[] = words.map(
    () => undefined,
  );
  for (const [first, start] of words.entries()) {
    const candidates = [
      ...(register.byFirstWord.get(start.folded) ?? []),
      // A one-word name in the genitive is found under the word without its s.
      ...(start.folded.endsWith("s")
        ? (register.byFirstWord.get(start.folded.slice(0, -1)) ?? [])
        : []),
    ];
    for (const term of candidates) {
      const covered = words.slice(first, first + term.words.length);
      if (
        covered.length === term.words.length &&
        covered.every((word, offset) => {
          const wanted = term.words[offset];
          return (
            word.folded === wanted ||
            (term.genitive &&
              offset === covered.length - 1 &&
              word.folded === `${wanted ?? ""}s`)
          );
        }) &&
        (!term.capitalOnly || CAPITAL.test(start.word))
      ) {
        for (let index = first; index < first + covered.length; index += 1) {
          found[index] =
            term.protectedOnly && found[index] !== "shown"
              ? "protected"
              : "shown";
        }
      }
    }
  }

  const matches: RegisterWordMatch[] = [];
  let run: { from: number; to: number; protectedOnly: boolean } | null = null;
  const close = (): void => {
    if (run !== null) {
      matches.push({
        words: checked.slice(run.from, run.to),
        protectedOnly: run.protectedOnly,
      });
      run = null;
    }
  };
  for (const [index, word] of words.entries()) {
    const state = found[index];
    if (state === undefined) {
      close();
      continue;
    }
    const protectedOnly = state === "protected";
    if (run !== null && run.protectedOnly === protectedOnly) {
      run.to = word.end;
    } else {
      close();
      run = { from: word.start, to: word.end, protectedOnly };
    }
  }
  close();
  return matches;
}

/**
 * Whatever in a text is written as an email address, as written.
 *
 * Looked up whole, so "anna@example.se" inside "joanna@example.se" is not
 * found: the address is cut out from the first character an address can hold.
 */
export function emailAddressesIn(text: string): string[] {
  return [
    ...checkedText(text).matchAll(
      /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
    ),
  ].map((match) => match[0]);
}

/** The fewest and most digits a phone number is written with. */
const PHONE_DIGITS = { min: 6, max: 15 } as const;

/**
 * Whatever in a text could be a phone number, as written.
 *
 * A phone number matches by its digits however they are spaced, so a run of
 * digit groups ("070-123 45 67", "+46 (0)70 123 45 67") gives every unbroken
 * stretch of whole groups that holds enough digits to be one. Groups are never
 * split: "1234567" is not found inside "112345678". A stretch ends once it
 * holds more digits than a phone number has, which bounds the work by the
 * number of groups however long the run is.
 */
export function phoneNumbersIn(text: string): string[] {
  const found = new Set<string>();
  for (const run of checkedText(text).matchAll(/\+?\d(?:[\d ()./-]*\d)?/gu)) {
    const groups = run[0].match(/\d+/gu) ?? [];
    const plus = run[0].startsWith("+") ? "+" : "";
    for (let first = 0; first < groups.length; first += 1) {
      let digits = "";
      for (let last = first; last < groups.length; last += 1) {
        digits += groups[last];
        if (digits.length > PHONE_DIGITS.max) {
          break;
        }
        if (digits.length >= PHONE_DIGITS.min) {
          found.add(`${first === 0 ? plus : ""}${digits}`);
        }
      }
    }
  }
  return [...found];
}
