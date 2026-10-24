import { Injectable } from "@nestjs/common";
import type {
  PluginContentAudience,
  PluginMeetingNotice,
  PluginOccurrence,
} from "@openbrf/plugin-sdk";
import { dateColumnOf, localDayOf } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { placesLeftOf } from "../events/event-signup.service";
import {
  eventTexts,
  meetingNoticeTexts,
} from "../register-check/checked-texts";
import { RegisterCheckService } from "../register-check/register-check.service";
import {
  type ContentReader,
  contentAudience,
  readWindow,
  visibilityOf,
} from "./plugin-content";

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
 *
 * ## For a device
 *
 * For a plugin with a device route, an event whose title, description,
 * category or location fails the register check is absent with every
 * occurrence, and a notice whose place, digital participation or any agenda
 * title fails it is absent whole, as if the meeting had not been called.
 */
@Injectable()
export class PluginCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registerCheck: RegisterCheckService,
  ) {}

  /**
   * The occurrences of published events starting in [from, to), soonest first.
   *
   * An occurrence the board called off is present and says so: it was
   * announced, and a screen that silently dropped it would leave a reader
   * expecting it.
   */
  async occurrences(
    range: {
      from: string;
      to: string;
      audience?: PluginContentAudience;
    },
    reader: ContentReader,
  ): Promise<PluginOccurrence[]> {
    const { from, to } = readWindow(range, MAX_OCCURRENCE_DAYS);
    const visibility =
      range.audience === undefined ? undefined : visibilityOf(range.audience);

    const rows = await this.prisma.eventOccurrence.findMany({
      where: {
        event: {
          published: true,
          ...(reader.onScreensOnly === true ? { onScreens: true } : {}),
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
            onScreens: true,
          },
        },
        _count: { select: { signups: { where: { withdrawnAt: null } } } },
      },
    });

    const passing = reader.forDevices
      ? await this.passingEvents(rows.map((row) => row.event))
      : null;

    return rows
      .filter((row) => passing === null || passing.has(row.event.id))
      .map((row) => ({
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
        onScreens: row.event.onScreens,
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
  async meetingNotices(
    reader: ContentReader,
    now: Date = new Date(),
  ): Promise<PluginMeetingNotice[]> {
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

    const notices: PluginMeetingNotice[] = rows.map((row) => ({
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
    if (!reader.forDevices) {
      return notices;
    }
    const passes = await this.registerCheck
      .load()
      .then((check) => check.passes(notices.map(meetingNoticeTexts)));
    return notices.filter((_, index) => passes[index]);
  }

  /** The ids of the events that pass the register check, each checked once. */
  private async passingEvents(
    events: readonly {
      id: string;
      title: string;
      description: string | null;
      category: string | null;
      location: string | null;
    }[],
  ): Promise<Set<string>> {
    const distinct = [
      ...new Map(events.map((event) => [event.id, event])).values(),
    ];
    if (distinct.length === 0) {
      return new Set();
    }
    const passes = await this.registerCheck
      .load()
      .then((check) => check.passes(distinct.map(eventTexts)));
    return new Set(
      distinct.filter((_, index) => passes[index]).map((event) => event.id),
    );
  }
}
