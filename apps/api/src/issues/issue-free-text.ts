import {
  ISSUE_TEXT_RETENTION_YEARS,
  RING_FENCED_ISSUE_TEXT_RETENTION_YEARS,
} from "@openbrf/shared";

import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * The free-text layer of an issue, and the clock it is removed on (ADR 0057,
 * decision 33 of the issue module plan).
 *
 * An issue is two layers. The building record stays for as long as the issue
 * does: its type, its status and the meanings it passed through, its priority,
 * its outcome, the apartment, and when it was reported and closed. None of it
 * is text a person wrote, and a record with no words in it is still what makes
 * a repeat fault countable.
 *
 * The free-text layer is everything a person wrote or photographed: the
 * description, the free-text location, every issue message and internal note,
 * every photograph and file a handler attached, and every note and photograph
 * a contractor sent through a work order's link (ADR 0055). It is removed on the
 * board's clock after the issue closes, a clock of its own for a ring-fenced
 * type, unless a legal hold stands on the issue or a legal hold or a
 * restriction on its reporter; on the reporter's granted erasure request; and,
 * a piece at a time, whenever a handler redacts it.
 *
 * The free-text location goes with the rest because decision 33 removes free
 * text, and "the bathroom in 1101, the neighbour's dog" is free text whatever
 * field it was typed into.
 */

/**
 * An issue on which some of the free-text layer still stands.
 *
 * What both purges select by and the closing job counts by, rather than a flag
 * the purge sets: text written after a reopening, or a file attached to a closed
 * issue, stands again and is reached on the next clock without anybody keeping
 * a flag in step. A redacted message or note still counts, because the row
 * stands until the purge takes it, and a redacted description or location does
 * not, because nothing of it is left.
 *
 * An object to put under `AND`, never to spread: its `OR` would replace one
 * beside it.
 */
export const ISSUE_FREE_TEXT_STANDING = standing({});

/**
 * The same, except that a contractor's note a handler has redacted does not
 * count: its row stands for the clock to take, but nothing of what was written
 * is left in it.
 *
 * What the detaching of a reporter whose erasure was carried out reads, so that
 * a handler's redaction of the last contractor note frees the reporter at once
 * instead of leaving them attached until the clock takes the blank row (ADR
 * 0057). The clock still selects by `ISSUE_FREE_TEXT_STANDING`.
 */
export const ISSUE_FREE_TEXT_STANDING_UNREDACTED = standing({
  redactedAt: null,
});

function standing(
  contractorNote: Prisma.WorkOrderNoteWhereInput,
): Prisma.IssueWhereInput {
  return {
    OR: [
      { description: { not: "" } },
      { location: { not: null } },
      { messages: { some: {} } },
      { notes: { some: {} } },
      { photos: { some: {} } },
      { attachments: { some: {} } },
      // What a contractor wrote or photographed through a work order's link
      // (ADR 0055). The work order's own text has a clock of its own.
      {
        workOrders: {
          some: {
            OR: [{ notes: { some: contractorNote } }, { files: { some: {} } }],
          },
        },
      },
    ],
  };
}

/**
 * The number of days a clock of whole years counts.
 *
 * Three hundred and sixty-five a year, as the motions' two years are 730 days:
 * day arithmetic on the UTC instant, the way every retention clock here is
 * counted, rather than calendar years, which would put a 29 February closing's
 * date on a day that does not exist.
 */
export function issueTextRetentionDays(years: number): number {
  return years * 365;
}

/**
 * The board's two clocks on an issue's free text, in whole years after
 * closing: one for the ordinary types, and one of its own for a ring-fenced
 * type (decision 32), each from one to ten.
 */
export interface IssueTextClocks {
  /** The ordinary types' clock; two by default. */
  years: number;
  /** A ring-fenced type's clock; one by default. */
  ringFencedYears: number;
}

/**
 * The clock an issue's free text is on, in whole years, by its type.
 *
 * The board's setting for an ordinary type, and the board's ring-fenced
 * setting for a ring-fenced one (decision 32), which may be shorter or longer.
 * The one rule the purge selects by, the access report dates by and the report
 * forms tell a reporter, so none of them can state a clock the purge does not
 * keep.
 */
export function issueTextClockYears(
  clocks: IssueTextClocks,
  ringFenced: boolean,
): number {
  return ringFenced ? clocks.ringFencedYears : clocks.years;
}

/**
 * The board's clocks, in whole years, as the association's row holds them, or
 * the defaults where there is no row yet.
 */
export async function issueTextClocks(
  client: Pick<PrismaService, "association"> | Prisma.TransactionClient,
): Promise<IssueTextClocks> {
  const association = await client.association.findUnique({
    where: { id: 1 },
    select: {
      issueTextRetentionYears: true,
      ringFencedIssueTextRetentionYears: true,
    },
  });
  return {
    years:
      association?.issueTextRetentionYears ??
      ISSUE_TEXT_RETENTION_YEARS.default,
    ringFencedYears:
      association?.ringFencedIssueTextRetentionYears ??
      RING_FENCED_ISSUE_TEXT_RETENTION_YEARS.default,
  };
}
