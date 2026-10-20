import { Injectable } from "@nestjs/common";
import type {
  PluginContentAudience,
  PluginMeetingNotice,
  PluginOccurrence,
} from "@openbrf/plugin-sdk";
import { dateColumnOf, localDayOf } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { placesLeftOf } from "../events/event-signup.service";
import { contentAudience, readWindow, visibilityOf } from "./plugin-content";

/** The longest window one occurrence read may span: about a quarter. */
const MAX_OCCURRENCE_DAYS = 92;

/**
 * The association's calendar, as a plugin holding calendar:read reads it
 * (ADR 0032): the occurrences of its published events, and the notices of the
 * general meetings it has called.
 *
 * ## A count is the most this file can produce about who is coming
 *
 * The rule the website's calendar keeps, kept the same way. Sign-ups are read
 * as a filtered relation count, so the only thing this service can learn about
 * one is how many there are; there is no select of a person anywhere in this
 * file, and no shape below has anywhere to put one. Who entered a series is
 * not selected either.
 *
 * ## What a notice is, here
 *
 * A notice (kallelse) states the time, the place, how to take part digitally
 * and the agenda (EFL 6 kap. 22 §), and that is what is read. Who was summoned,
 * who attended, who holds a proxy and how anybody voted are the meeting's
 * records about named members, and none of them is selected. Who issued the
 * notice is not selected either.
 */
@Injectable()
export class PluginCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The occurrences of published events starting in [from, to), soonest first.
   *
   * An occurrence the board called off is present and says so: it was
   * announced, and a screen that silently dropped it would leave a reader
   * expecting it.
   */
  async occurrences(range: {
    from: string;
    to: string;
    audience?: PluginContentAudience;
  }): Promise<PluginOccurrence[]> {
    const { from, to } = readWindow(range, MAX_OCCURRENCE_DAYS);
    const visibility =
      range.audience === undefined ? undefined : visibilityOf(range.audience);

    const rows = await this.prisma.eventOccurrence.findMany({
      where: {
        event: {
          published: true,
          ...(visibility === undefined ? {} : { visibility }),
        },
        startsAt: { gte: from, lt: to },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        cancelledAt: true,
        event: {
          select: {
            id: true,
            title: true,
            description: true,
            category: true,
            location: true,
            visibility: true,
            signupOpen: true,
            capacity: true,
          },
        },
        _count: { select: { signups: { where: { withdrawnAt: null } } } },
      },
    });

    return rows.map((row) => ({
      eventId: row.event.id,
      occurrenceId: row.id,
      title: row.event.title,
      description: row.event.description,
      category: row.event.category,
      location: row.event.location,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      calledOff: row.cancelledAt !== null,
      // Only an event that takes sign-ups has places to be left.
      placesLeft: row.event.signupOpen
        ? placesLeftOf(row.event.capacity, row._count.signups)
        : null,
      audience: contentAudience(row.event.visibility),
    }));
  }

  /**
   * The notices of the general meetings called and not yet held, soonest
   * first.
   *
   * Not yet held is two facts, and both have to hold: the board has not
   * recorded the meeting as held, and its day has not passed. The second is
   * there for the meeting the board has not yet got round to recording, which
   * a screen should not go on announcing the week after.
   */
  async meetingNotices(now: Date = new Date()): Promise<PluginMeetingNotice[]> {
    const rows = await this.prisma.meetingNotice.findMany({
      where: {
        meeting: {
          concludedAt: null,
          heldOn: { gte: dateColumnOf(localDayOf(now)) },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: {
        startsAt: true,
        place: true,
        digitalParticipation: true,
        meeting: {
          select: {
            id: true,
            kind: true,
            agendaItems: {
              orderBy: { position: "asc" },
              select: { position: true, title: true },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      meetingId: row.meeting.id,
      kind: row.meeting.kind === "ORDINARY" ? "ordinary" : "extraordinary",
      startsAt: row.startsAt.toISOString(),
      place: row.place,
      digitalParticipation: row.digitalParticipation,
      agenda: row.meeting.agendaItems.map((item) => ({
        position: item.position,
        title: item.title,
      })),
    }));
  }
}
