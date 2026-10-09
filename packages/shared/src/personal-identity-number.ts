import { compareLocalDays, localDayOf } from "./stockholm-calendar.ts";

/**
 * The Swedish personal identity number (personnummer), as parsed, normalized,
 * checksum-verified and searched for in free text.
 *
 * These functions live here rather than beside the encryption layer because
 * both sides of the platform need them: the server normalizes before it
 * computes a blind index, and the browser has to be able to say that a piece
 * of text a board member is about to publish carries an identity number before
 * it is sent anywhere. They are pure and dependency-free so that stays true.
 *
 * Normalization is part of the storage format, not a presentation detail. A
 * blind index is a keyed hash of the *normalized* plaintext (ADR 0002), so a
 * lookup only finds a row when the value is normalized identically at write
 * time and at search time:
 *
 *   Changing normalizePersonalIdentityNumber, or the parse it rests on,
 *   invalidates every blind index already stored. Such a change bumps the
 *   normalization version the API records (NORMALIZATION_VERSION in
 *   apps/api/src/crypto/personal-data.ts), which reindexes the stored rows.
 *
 * A number written without its century is the one input normalization cannot
 * make stable on its own: the same ten digits name a different person once the
 * day they are read on moves past a birthday (see parsePersonalIdentityNumber).
 * So a number is stored with the century it was read with
 * (withPersonalIdentityNumberCentury), and one whose reading is about to change,
 * or has just changed, is refused until somebody writes the century
 * (personalIdentityNumberNeedsCentury).
 *
 * Swedish domain terms follow GLOSSARY.md.
 */

export interface PersonalIdentityNumberParts {
  /** Full four-digit year. */
  year: number;
  month: number;
  /** Day as written, i.e. still carrying the +60 offset for a coordination number. */
  day: number;
  /** The four last digits, including the check digit. */
  suffix: string;
  /** True for a coordination number (samordningsnummer), where day is offset by 60. */
  isCoordinationNumber: boolean;
}

const PERSONAL_IDENTITY_NUMBER_PATTERN =
  /^(?<century>\d{2})?(?<year>\d{2})(?<month>\d{2})(?<day>\d{2})(?<separator>[-+])?(?<suffix>\d{4})$/;

/**
 * Parses a Swedish personal identity number in any of its written forms and
 * returns its parts with the century resolved.
 *
 * Returns null when the input is not shaped like a personal identity number.
 * Shape is not validity: use isValidPersonalIdentityNumber for the checksum.
 *
 * @param referenceDate Date the age is judged against. Injected so tests do
 *   not depend on the current date and so an import can be replayed.
 */
export function parsePersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): PersonalIdentityNumberParts | null {
  const groups = shapeOf(input);
  if (groups === null) {
    return null;
  }

  const { century, year, month, day, separator, suffix } = groups;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    suffix === undefined
  ) {
    return null;
  }

  const twoDigitYear = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const isCoordinationNumber = dayNumber > 60;
  const actualDay = isCoordinationNumber ? dayNumber - 60 : dayNumber;

  let fullYear: number;
  if (century !== undefined) {
    // Written with the century, so take it at face value.
    fullYear = Number(century) * 100 + twoDigitYear;
  } else {
    const referenceDay = localDayOf(referenceDate);
    const referenceYear = referenceDay.year;
    fullYear = Math.floor(referenceYear / 100) * 100 + twoDigitYear;
    if (separator === "+") {
      // A plus is written from the year a person turns 100, so here it is the
      // year that is compared rather than the birthday.
      if (fullYear > referenceYear) {
        fullYear -= 100;
      }
      fullYear -= 100;
    } else if (
      // Otherwise the most recent birth date that is not in the future wins.
      // The whole date rather than the year: in March 2026, 261201 is
      // 1926-12-01, because 2026-12-01 has not happened yet. Comparing years
      // alone said 2026 until that day came, so the blind index of one
      // unchanged input moved with the clock. The day is compared without a
      // coordination number's offset, which is no date at all.
      (fullYear * 100 + monthNumber) * 100 + actualDay >
      (referenceYear * 100 + referenceDay.month) * 100 + referenceDay.day
    ) {
      fullYear -= 100;
    }
  }

  if (monthNumber < 1 || monthNumber > 12 || actualDay < 1) {
    return null;
  }
  // A range check alone accepts 30 February and 31 April. Those dates never
  // existed, so a number carrying one is not a mis-typed real number: it is
  // not a personal identity number at all, and a valid Luhn digit must not
  // make it look like one.
  if (actualDay > daysInMonth(fullYear, monthNumber)) {
    return null;
  }

  return {
    year: fullYear,
    month: monthNumber,
    day: dayNumber,
    suffix,
    isCoordinationNumber,
  };
}

/**
 * Canonical form for a personal identity number: twelve digits, no separator
 * (YYYYMMDDNNNN).
 *
 * Returns null when the input is not shaped like a personal identity number,
 * so a caller can reject the row rather than store an index that can never be
 * matched.
 */
export function normalizePersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): string | null {
  const parts = parsePersonalIdentityNumber(input, referenceDate);
  if (parts === null) {
    return null;
  }
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${String(parts.year)}${month}${day}${parts.suffix}`;
}

/**
 * Whether a number written without its century has to be given one before it
 * is stored or looked up.
 *
 * Without a century the reading depends on the day it is made, and it flips
 * once: 261201-1235 reads as 1926 until 1 December 2026 and as 2026 from then
 * on. A number stored on one side of that day and looked up on the other would
 * be two people, so a number whose reading a year earlier or a year later
 * differs from today's is refused instead of guessed. That leaves two numbers
 * accepted on dates less than a year apart reading the same on both, which is
 * what lets a file be previewed today and imported again next month. The cost
 * falls on numbers within a year of their flip: somebody born in the last
 * year, or turning 100 within one, is written with the century.
 *
 * False for a number written with its century, and for input that is not a
 * personal identity number at all, which the validity check reports.
 */
export function personalIdentityNumberNeedsCentury(
  input: string,
  referenceDate: Date = new Date(),
): boolean {
  const groups = shapeOf(input);
  if (groups === null || groups.century !== undefined) {
    return false;
  }
  const reading = normalizePersonalIdentityNumber(input, referenceDate);
  if (reading === null) {
    return false;
  }
  return [-1, 1].some(
    (years) =>
      normalizePersonalIdentityNumber(
        input,
        yearsFrom(referenceDate, years),
      ) !== reading,
  );
}

/**
 * The input with the century it is read with today written in front of it, so
 * that reading it again later gives the same person.
 *
 * What a stored ciphertext holds. The spelling is kept otherwise -
 * 811228-9874 is stored as 19811228-9874 - and a value that already carries a
 * century, or is not a personal identity number, comes back as it was.
 */
export function withPersonalIdentityNumberCentury(
  input: string,
  referenceDate: Date = new Date(),
): string {
  const groups = shapeOf(input);
  if (groups === null || groups.century !== undefined) {
    return input;
  }
  const parts = parsePersonalIdentityNumber(input, referenceDate);
  if (parts === null) {
    return input;
  }
  return `${String(Math.floor(parts.year / 100))}${input.trim()}`;
}

/**
 * Verifies the Luhn check digit, which the last ten digits of a Swedish
 * personal identity number carry.
 *
 * Coordination numbers use the same checksum over the offset day, so no
 * special case is needed here.
 *
 * A number written with its century is valid only where somebody alive can
 * have been born: the century is 18, 19 or 20 and the birth date has come. A
 * twelve-digit invoice or OCR reference whose last ten digits pass the check
 * is not a personal identity number. This is a check of what is entered, not a
 * rule of normalization, so a number already stored is indexed and found as it
 * always was.
 */
export function isValidPersonalIdentityNumber(
  input: string,
  referenceDate: Date = new Date(),
): boolean {
  const parts = parsePersonalIdentityNumber(input, referenceDate);
  if (parts === null || !isBornBy(input, parts, referenceDate)) {
    return false;
  }
  const normalized = normalizePersonalIdentityNumber(input, referenceDate);
  if (normalized === null) {
    return false;
  }

  // Luhn runs over the ten-digit form: YYMMDDNNNC.
  const tenDigits = normalized.slice(2);
  let sum = 0;
  for (let position = 0; position < 9; position++) {
    const digit = Number(tenDigits[position]);
    const weighted = position % 2 === 0 ? digit * 2 : digit;
    sum += weighted > 9 ? weighted - 9 : weighted;
  }
  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return expectedCheckDigit === Number(tenDigits[9]);
}

/** One personal identity number found in a piece of text. */
export interface PersonalIdentityNumberMatch {
  /** The number exactly as it is written in the text. */
  value: string;
  /** Offset of the first character of the match within the scanned text. */
  index: number;
}

/**
 * A character that is not on screen: the Unicode "other" category (control,
 * format, surrogate, private-use, unassigned) and the default-ignorable code
 * points, which include marks a renderer draws as nothing - the combining
 * grapheme joiner, the variation selectors - and the byte order mark.
 */
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}]/u;

/**
 * What separates one thing from the next: spaces, tabs, line breaks. The byte
 * order mark is not one, although a JavaScript `\s` says it is.
 */
const SEPARATOR = /[\t\n\v\f\r\u0085\p{Z}]/u;

/** {@link SEPARATOR} as a run, for collapsing to one space. */
const SEPARATOR_RUN = new RegExp(`${SEPARATOR.source}+`, "gu");

/**
 * Whether a character is dropped from free text before it is stored or scanned.
 *
 * Invisible, and not a separator: dropping a separator would join the two
 * halves either side of it into one run, which is how a number written across
 * a line break would become a number. One rule for the stored form and the
 * scanned form, so the scanner cannot be blind to what the store would join.
 */
function isDropped(character: string): boolean {
  return INVISIBLE.test(character) && !SEPARATOR.test(character);
}

/**
 * Free text as it is stored and scanned: the invisible removed, compatibility
 * forms folded.
 *
 * A soft hyphen, a zero-width space or a byte order mark is invisible on
 * screen and splits a number the scanner would otherwise see; a fullwidth
 * digit reads as a digit and is not one to a pattern written for ASCII. The
 * strip drops the first kind and NFKC turns the second into ASCII. The strip
 * runs first, so that a character removed from between a letter and a
 * combining mark lets the two compose in this call and not in the next: the
 * result is its own normal form. Line breaks and other separators stay, so two
 * lines do not join into one run of digits. Use it for a value that is written
 * to the database, so that what is stored is what was checked. The scanner
 * applies the same rule to what it is given and reports where the number sits
 * in the original.
 */
export function normalizeFreeText(text: string): string {
  let kept = "";
  for (const character of text) {
    if (!isDropped(character)) {
      kept += character;
    }
  }
  return kept.normalize("NFKC");
}

/**
 * {@link normalizeFreeText} for a value that is one line, a title or a name:
 * every run of separators, line breaks included, becomes one space, and the
 * ends are trimmed.
 */
export function normalizeSingleLineText(text: string): string {
  return normalizeFreeText(text).replace(SEPARATOR_RUN, " ").trim();
}

/** Text folded for scanning, with where each folded character came from. */
interface FoldedText {
  text: string;
  /** For every character of `text`: the span of the original it stands for. */
  starts: number[];
  ends: number[];
}

/**
 * {@link normalizeFreeText} for a scan, keeping a way back to the original.
 *
 * A line break stays: whitespace is a boundary in free text, and dropping it
 * would let any two runs of digits either side of it join. The candidate
 * pattern decides the one place a separator may sit inside a number.
 * What is dropped is decided by the same rule as in `normalizeFreeText`.
 * Folded one code point at a time so every character of the result has a known
 * origin; a compatibility form that expands to several characters (a ligature,
 * a circled digit) has them share one.
 */
function foldForScan(text: string): FoldedText {
  const folded: FoldedText = { text: "", starts: [], ends: [] };
  let offset = 0;

  for (const character of text) {
    const start = offset;
    offset += character.length;

    if (isDropped(character)) {
      continue;
    }
    const form = character.normalize("NFKC");
    folded.text += form;
    for (let position = 0; position < form.length; position++) {
      folded.starts.push(start);
      folded.ends.push(offset);
    }
  }

  return folded;
}

/**
 * Every candidate shape a personal identity number is written in, unanchored.
 *
 * Ten or twelve digits with an optional separator before the last four. The
 * lookarounds are what keep a longer run of digits - a bank account, a card
 * number, a reference - from yielding a ten-digit window out of its middle:
 * a candidate must not touch a digit on either side.
 *
 * Whitespace is accepted in one place only: between the date and the last
 * four, around the separator or instead of it (`811228 - 9874`, `811228 9874`,
 * the two halves on two lines). The parser takes those forms as a number, and a
 * reader does too, so a scan that let them through would let the number be
 * published. The date and the last four must each still be one run of digits:
 * accepting a space anywhere would let a phone number written in groups join
 * the figure after it, and the calendar and the Luhn check are what keep the
 * one place that is accepted from reporting a false match.
 *
 * The whitespace after the sign belongs to the sign. Two runs that could both
 * take the same whitespace, as `\s*[-+]?\s*` would, make a date followed by a
 * long run of spaces cost quadratic time before the match fails, and the text
 * scanned is a whole page block, which can be a megabyte.
 */
const CANDIDATE_PATTERN = new RegExp(
  `(?<!\\d)(?:\\d{2})?\\d{6}${SEPARATOR.source}*(?:[-+]${SEPARATOR.source}*)?\\d{4}(?!\\d)`,
  "gu",
);

/**
 * Finds the personal identity numbers in a piece of free text.
 *
 * Written for the moment before something is published: prose a board member
 * typed, a heading, a caption. Nothing on the association's public website may
 * carry an identity number, and a scanner is what lets the refusal happen at
 * the keyboard rather than after the page is live.
 *
 * Candidates are matched by shape and then put through the same anchored
 * validator a stored value goes through, so the calendar and the Luhn check
 * are what decide. That is what keeps the false-positive rate low enough for
 * the result to be worth refusing on: an invoice number, an amount or a date
 * range has to survive both to be reported.
 *
 * A Swedish organisation number (organisationsnummer) is the same shape and is
 * lawful on a public page - a housing cooperative prints its own in the
 * footer. It is excluded by the calendar check rather than by a special case:
 * the third digit pair of an organisation number is always 20 or more, which
 * is never a month.
 *
 * The text is folded first ({@link normalizeFreeText}), so a number cannot be
 * hidden behind an invisible character or written in fullwidth digits. `index`
 * and `value` still describe the text that was passed in.
 *
 * @param referenceDate Date the century inference is judged against, injected
 *   for the same reason as in the parser.
 */
export function scanForPersonalIdentityNumbers(
  text: string,
  referenceDate: Date = new Date(),
): PersonalIdentityNumberMatch[] {
  const found: PersonalIdentityNumberMatch[] = [];
  // A fresh regex per call: the global flag carries lastIndex, and a shared
  // instance would make one scan depend on the one before it.
  const pattern = new RegExp(CANDIDATE_PATTERN.source, CANDIDATE_PATTERN.flags);

  const folded = foldForScan(text);
  let match = pattern.exec(folded.text);
  while (match !== null) {
    const [candidate] = match;
    // The parser drops what JavaScript calls whitespace, which a next-line
    // character is not, so the separators the pattern let through go first.
    const compact = candidate.replace(SEPARATOR_RUN, "");
    if (isValidPersonalIdentityNumber(compact, referenceDate)) {
      const start = folded.starts[match.index] ?? 0;
      const end = folded.ends[match.index + candidate.length - 1] ?? start;
      found.push({ value: text.slice(start, end), index: start });
    }
    match = pattern.exec(folded.text);
  }

  return found;
}

/** The pattern's groups for a single typed value, or null when it does not fit. */
function shapeOf(input: string): Record<string, string | undefined> | null {
  const compact = input.trim().replace(/\s/g, "");
  return PERSONAL_IDENTITY_NUMBER_PATTERN.exec(compact)?.groups ?? null;
}

/**
 * Whether a number written with its century names a living person's birth: a
 * century of 18, 19 or 20, and a birth date on or before the association's day
 * (ADR 0013). A number without one is read into the past already.
 */
function isBornBy(
  input: string,
  parts: PersonalIdentityNumberParts,
  referenceDate: Date,
): boolean {
  const century = shapeOf(input)?.century;
  if (century === undefined) {
    return true;
  }
  if (!["18", "19", "20"].includes(century)) {
    return false;
  }
  const birth = {
    year: parts.year,
    month: parts.month,
    day: parts.isCoordinationNumber ? parts.day - 60 : parts.day,
  };
  return compareLocalDays(birth, localDayOf(referenceDate)) <= 0;
}

/** The same moment a number of years away; 29 February moves to 1 March. */
function yearsFrom(date: Date, years: number): Date {
  const moved = new Date(date.getTime());
  moved.setFullYear(moved.getFullYear() + years);
  return moved;
}

/**
 * Finds every run of digits shaped like a personal identity number, valid or
 * not.
 *
 * For hiding rather than refusing: a number mistyped so that its date or check
 * digit fails is still a person's number with a typo, and a screen that must
 * not show identity numbers must not show it either.
 */
export function scanForPersonalIdentityNumberCandidates(
  text: string,
): PersonalIdentityNumberMatch[] {
  return [...text.matchAll(new RegExp(CANDIDATE_PATTERN.source, "g"))].map(
    (match) => ({ value: match[0], index: match.index }),
  );
}

/** Days in a month, honouring the Gregorian leap-year rule. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
