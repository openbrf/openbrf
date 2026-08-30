import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import {
  type BoardRosterEntry,
  publishableRoster,
  type BoardSeat,
} from "./board-roster";

/**
 * Who the association's board is, as the association publishes it.
 *
 * The one place that turns held seats into names on a page. It exists outside
 * src/site on purpose: the public website may not read the registers, the
 * address book or the encryption layer - site-boundary.spec.ts holds that as a
 * property of the module graph - and a roster query written inside that
 * directory would be the first personal-data read in it. The website asks this
 * service a question and is handed names and positions; what may be asked is
 * decided here, where the rule can be stated once and tested.
 *
 * The select list is the boundary, in the same sense the broker page's is. Four
 * columns are read about a person - two halves of a name, the protected-data
 * flag, and the dates on their consent rows - and there is nothing else in it:
 * no address, no apartment, no residency, no cipher column, and no
 * personalIdentityNumberIndex to look one up by. This file imports nothing from
 * the encryption layer, so a contact detail could not be turned back into
 * plaintext here even if a column were selected by mistake.
 *
 * Both refusals are made twice, in the query and again in the pure filter, and
 * that is deliberate rather than redundant. The query means a protected
 * person's name never enters this process at all; the filter means the rule is
 * asserted where it is written, against every ordering of grants and
 * withdrawals, without a database. They are also not the same expression: the
 * query asks whether any BOARD_ROSTER row stands, which is what an index can
 * answer, and the filter asks whether the most recent grant stands, which is
 * what the consent model actually means.
 */
@Injectable()
export class BoardRosterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The board as the website may print it, in the order it is read.
   *
   * Empty is an ordinary answer and not a failure: an association whose board
   * has not been asked for publication consent publishes no roster, and the
   * block renders as nothing rather than as a heading over an empty list.
   *
   * A seat with an end date in the future is still held. That is how every
   * other reader of this table decides - the principal that grants a board
   * member their capabilities, the notice that emails the board - and a roster
   * that dropped somebody on the day their term was recorded as ending would
   * disagree with the access they still have.
   */
  async published(now: Date = new Date()): Promise<BoardRosterEntry[]> {
    const seats = await this.prisma.boardPosition.findMany({
      where: {
        OR: [{ endedOn: null }, { endedOn: { gt: now } }],
        person: {
          protectedPersonalData: false,
          publicationConsents: {
            some: { scope: "BOARD_ROSTER", withdrawnAt: null },
          },
        },
      },
      select: {
        position: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            protectedPersonalData: true,
            publicationConsents: {
              where: { scope: "BOARD_ROSTER" },
              select: { scope: true, grantedAt: true, withdrawnAt: true },
            },
          },
        },
      },
    });

    return publishableRoster(
      seats.map((seat): BoardSeat => ({
        position: seat.position,
        firstName: seat.person.firstName,
        lastName: seat.person.lastName,
        protectedPersonalData: seat.person.protectedPersonalData,
        consents: seat.person.publicationConsents,
      })),
    );
  }
}
