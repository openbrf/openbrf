import { isValidPersonalIdentityNumber } from "../personal-identity-number.ts";

/**
 * A valid personal identity number for a test fixture, drawn from a number the
 * caller derives from its own seed.
 *
 * This is the one place that decides what a generated number looks like. The
 * integration suites (`runIdentityNumber` in apps/api) and the end-to-end specs
 * (`uniquePersonalIdentityNumber` in e2e) each hash a seed their own way and
 * hand the result here, so the reserved range below cannot drift between them.
 *
 * The years 1940 to 1979 are chosen, not arbitrary: every identity number
 * written to a database anywhere in this repository today falls outside them -
 * the demo data holds 1981 and 2012, the site suite 1985, and the end-to-end
 * specs that still write a fixed number hold 1985 and 1990 - so a collision
 * needs a deliberate choice rather than luck. A fixture that moves into that
 * range has to move this one too. Everyone in it is an adult, and days 1 to 28
 * are a real date in every month of every year, leap or not.
 *
 * The draw is spent from the lowest digits up: the year, then the month, the
 * day and the birth number. Any non-negative safe integer is accepted, so a
 * caller can hand over whatever its hash produces; it takes 13 426 560
 * different draws (40 years, 12 months, 28 days and 999 birth numbers) to
 * reach every number in the range, and the next draw starts over.
 *
 * Twelve digits rather than the six-plus-four form. The short form has no
 * century, so the parser infers one from today's date, and a fixture that
 * resolves to 1958 now would resolve to 2058 once the reference year passes it.
 * The twelve-digit form is also what normalization produces, so the value
 * stored and the value indexed are the same string.
 *
 * The check digit is found by asking the shared validator rather than by
 * computing Luhn a second time: exactly one of the ten digits satisfies it, and
 * a second implementation is a second thing that can disagree with the parser
 * the blind index depends on.
 */
export function testPersonalIdentityNumber(draw: number): string {
  if (!Number.isSafeInteger(draw) || draw < 0) {
    throw new RangeError(
      `A draw is a non-negative safe integer, not ${String(draw)}.`,
    );
  }

  const year = 1940 + (draw % 40);
  const month = 1 + (Math.floor(draw / 40) % 12);
  const day = 1 + (Math.floor(draw / 480) % 28);
  // 001 to 999: a birth number of 000 is never issued, and a fixture is read
  // by people who should not have to wonder whether that is deliberate.
  const birthNumber = 1 + (Math.floor(draw / 13_440) % 999);

  const base =
    `${String(year)}` +
    `${String(month).padStart(2, "0")}` +
    `${String(day).padStart(2, "0")}` +
    `${String(birthNumber).padStart(3, "0")}`;

  for (let checkDigit = 0; checkDigit < 10; checkDigit += 1) {
    const candidate = `${base}${String(checkDigit)}`;
    if (isValidPersonalIdentityNumber(candidate)) {
      return candidate;
    }
  }
  /* c8 ignore next 4 -- unreachable: one of ten digits always satisfies Luhn */
  throw new Error(
    `No check digit completes ${base} into a valid personal identity number.`,
  );
}
