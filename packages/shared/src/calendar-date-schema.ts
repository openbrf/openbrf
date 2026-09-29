import { z } from "zod";

import { parseLocalDay } from "./stockholm-calendar.ts";

/**
 * A request field holding a "YYYY-MM-DD" date that is on the calendar.
 *
 * The one schema every controller states a date with. A regular expression on
 * the shape alone accepts "2026-02-30", and the `Date` the value is then handed
 * to answers the 2nd of March: on an append-only statutory row that is a
 * different day nobody can correct, and a month of 13 is an Invalid Date that
 * reaches the database as a server error rather than a refusal. The check is
 * {@link parseLocalDay}'s, so a request and a service agree on what a date is.
 *
 * The value stays the text that was sent. A rule about whether the date may lie
 * in the future, or after another date on the row, belongs to the service that
 * knows the row, and it answers with a reason a screen can name.
 */
export const calendarDateSchema = z
  .string()
  .refine((text) => parseLocalDay(text) !== null, {
    message: "must be a calendar date, YYYY-MM-DD",
  });
