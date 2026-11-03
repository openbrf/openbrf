/**
 * What an issue (ärende) carries that is particular to a Swedish house: the
 * resident's entry permission (tillträde), the common-area place an issue is
 * about, and the mark of an inspection finding (ADR 0054, decisions 29 to 31 of
 * the issue module plan).
 *
 * Here rather than beside the schema, for the reason `ISSUE_REPORT_LIMITS`
 * gives: the forms have to know the same numbers and the same rules the API
 * enforces, and a door code the form lets through and the API refuses is a
 * form that fails after the resident has finished typing.
 */

/** The resident's answer to whether the association may enter. */
export const ISSUE_ENTRY_ANSWERS = ["YES", "NO"] as const;

export type IssueEntryAnswer = (typeof ISSUE_ENTRY_ANSWERS)[number];

/**
 * The statutory inspection an issue is a finding of: the compulsory
 * ventilation inspection (OVK), a lift inspection and a fire safety
 * inspection.
 */
export const ISSUE_FINDING_KINDS = ["OVK", "LIFT", "FIRE"] as const;

export type IssueFindingKind = (typeof ISSUE_FINDING_KINDS)[number];

export const ISSUE_FIT_LIMITS = {
  /**
   * The note on how to get in. A line or two: who to ring, when someone is at
   * home. Short on purpose, because a long note is where a code ends up.
   */
  entryNote: 300,
  /** A common-area place's name: "Tvättstuga", "Cykelrum, hus 2". */
  placeName: 60,
  /** Places one association keeps. A list to pick from, not a map. */
  places: 50,
} as const;

/**
 * How long after an inspection a lift's remaining faults may stay unrectified:
 * one month (BFS 2025:11, 1 kap. 17 §). The only date the law sets for a
 * finding; an OVK or fire finding has the date the handler sets, and the
 * schedule of the inspections themselves is the 2027 reminders' (decision 31).
 */
export const LIFT_FINDING_MONTHS = 1;

/**
 * The last day a finding of this kind may be due, given the day of the
 * inspection, or null where the law sets none.
 *
 * One calendar month on: 15 March is due by 15 April, and 31 January by the
 * last day of February, since there is no 31 February to land on. Leap years
 * follow from the calendar, so 31 January is due on 29 February in a leap
 * year and 28 February in any other.
 *
 * @param inspectedOn A calendar day, `YYYY-MM-DD`.
 */
export function latestFindingTargetDate(
  kind: IssueFindingKind,
  inspectedOn: string,
): string | null {
  if (kind !== "LIFT") {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inspectedOn);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthIndex = month - 1 + LIFT_FINDING_MONTHS;
  const dueYear = year + Math.floor(monthIndex / 12);
  const dueMonth = (monthIndex % 12) + 1;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(dueYear, dueMonth, 0)).getUTCDate();
  const dueDay = Math.min(day, lastDay);
  return [
    String(dueYear).padStart(4, "0"),
    String(dueMonth).padStart(2, "0"),
    String(dueDay).padStart(2, "0"),
  ].join("-");
}

/** Where in a text a likely door code starts. A position, never the value. */
export interface DoorCodeMatch {
  offset: number;
}

/**
 * A word that says the number after it opens something: port code, door code,
 * PIN, password. Swedish and English, with the compounds a note is written in.
 * Case-insensitive; the stem may end in the definite form ("koden").
 */
const CODE_WORD =
  /(?<![\p{L}\p{N}])(?:port|dörr|entré|entre|nyckel|tagg|pin|gate|door|entry|access|lås|las)?[-\s]?(?:kod(?:en|er|erna)?|code|codes|lösenord(?:et)?|losenord|password|passcode|pin)(?![\p{L}\p{N}])/giu;

/**
 * After a code word: a few words, then something that has a digit in it. Not
 * across a full stop or a line, so "Koden finns hos grannen. Ring 112" is not
 * a code.
 */
const CODE_AFTER_WORD =
  /^[^\n.;!?]{0,30}?(?<![\p{L}\p{N}])[\p{L}\p{N}*#-]*\p{Nd}/u;

/**
 * A run of digits, joined by single spaces or hyphens: "1234", "12 34",
 * "1-2-3-4". A colon or a full stop does not join, so "14.30" and "14:30" are
 * a time and not a code.
 */
const DIGIT_RUN = /(?<![\p{N}])\p{Nd}+(?:[ \-–]\p{Nd}+)*(?![\p{N}])/gu;

/** The fewest and most digits a door code has in practice. */
const CODE_DIGITS = { min: 4, max: 8 } as const;

/**
 * A word that makes the number after it something other than a code: the
 * apartment or the house the resident lives in. Checked on the word directly
 * before the run.
 */
const NOT_A_CODE_BEFORE =
  /(?:lgh|lägenhet|lägenheten|apartment|apt|flat|nr|no|number|nummer|hus|våning)\.?\s*$/iu;

/**
 * A month's name before a year: "12 maj 2026" says when, not what opens the
 * door. Swedish and English, in full and abbreviated.
 */
const MONTH_BEFORE =
  /(?:jan(?:uari|uary)?|feb(?:ruari|ruary)?|mar(?:s|ch)?|apr(?:il)?|maj|may|jun(?:i|e)?|jul(?:i|y)?|aug(?:usti|ust)?|sep(?:tember)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*$/iu;

/**
 * Whether a text holds what looks like a door code, and where it starts.
 *
 * A door code is the one thing an entry note must not hold: written into a
 * note it is read by every handler, kept with the issue and copied into any
 * export, and a code is a key. So the note is refused when it reads like one,
 * and the form says why instead of silently dropping it.
 *
 * Two readings, and either is enough:
 * - a code word ("kod", "port code", "PIN", "lösenord") followed within a few
 *   words by something with a digit in it, and
 * - a run of four to eight digits, which is how nearly every door code is
 *   written, unless the word before it makes it an apartment or house number
 *   or a month makes it a year. A longer run is a telephone number, which a
 *   note asking someone to ring is allowed to hold.
 *
 * Likely, not certain: a number the check passes may still be a code, and a
 * four-digit number it refuses may be an apartment written without the word
 * "lgh". Refusing is the safe side, and the resident can say it in words.
 *
 * @returns The first position, or null.
 */
export function findDoorCode(text: string): DoorCodeMatch | null {
  const { clean, positions } = withoutInvisibleCharacters(text);
  const found: number[] = [];

  for (const word of clean.matchAll(CODE_WORD)) {
    const after = clean.slice(word.index + word[0].length);
    if (CODE_AFTER_WORD.test(after)) {
      found.push(word.index);
    }
  }

  for (const run of clean.matchAll(DIGIT_RUN)) {
    const digits = run[0].replace(/[^\p{Nd}]/gu, "").length;
    if (digits < CODE_DIGITS.min || digits > CODE_DIGITS.max) {
      continue;
    }
    const before = clean.slice(0, run.index);
    if (NOT_A_CODE_BEFORE.test(before)) {
      continue;
    }
    if (/^(?:19|20)\p{Nd}{2}$/u.test(run[0]) && MONTH_BEFORE.test(before)) {
      continue;
    }
    found.push(run.index);
  }

  if (found.length === 0) {
    return null;
  }
  // Back to a position in the text as it was written.
  return { offset: positions[Math.min(...found)] ?? 0 };
}

/**
 * The text without its invisible characters, and where each remaining
 * character stood in the original.
 *
 * A zero-width space or joiner between two digits is not seen by the person who
 * reads the note, and it splits a code in two for a pattern that reads it
 * literally: "48\u200b21" is 4821 on the screen. They are format characters
 * (Unicode category Cf), and removing them is what makes the scan read what the
 * reader reads. The positions map a match back to the text as written, which is
 * what a refusal reports.
 */
function withoutInvisibleCharacters(text: string): {
  clean: string;
  positions: number[];
} {
  let clean = "";
  const positions: number[] = [];
  let index = 0;
  for (const character of text) {
    if (!/^\p{Cf}$/u.test(character)) {
      clean += character;
      for (let unit = 0; unit < character.length; unit += 1) {
        positions.push(index + unit);
      }
    }
    index += character.length;
  }
  return { clean, positions };
}
