import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { PluginCalendarService } from "./plugin-calendar.service";

/**
 * What calendar:read releases: the occurrences of published events and the
 * notices of the meetings called, and a count at most about who is coming
 * (ADR 0032).
 */

const RANGE = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" };

const OCCURRENCE = {
  id: "occurrence-1",
  startsAt: new Date("2026-11-15T09:00:00Z"),
  endsAt: new Date("2026-11-15T12:00:00Z"),
  cancelledAt: null,
  event: {
    id: "event-1",
    title: "Städdag",
    description: "Ta med arbetshandskar.",
    category: "Städning",
    location: "Gården",
    visibility: "PUBLIC",
    signupOpen: true,
    capacity: 20,
  },
  _count: { signups: 25 },
};

const NOTICE = {
  startsAt: new Date("2026-11-20T17:00:00Z"),
  place: "Föreningslokalen",
  digitalParticipation: null,
  meeting: {
    id: "meeting-1",
    kind: "EXTRAORDINARY",
    agendaItems: [
      { position: 1, title: "Stämmans öppnande" },
      { position: 2, title: "Val av ordförande" },
    ],
  },
};

function serviceReading(occurrences: unknown[], notices: unknown[] = []) {
  const findOccurrences = vi.fn(async () => occurrences);
  const findNotices = vi.fn(async () => notices);
  const prisma = {
    eventOccurrence: { findMany: findOccurrences },
    meetingNotice: { findMany: findNotices },
  } as unknown as PrismaService;
  return {
    service: new PluginCalendarService(prisma),
    findOccurrences,
    findNotices,
  };
}

/** Every key a select names, at every depth. */
function selectedKeys(select: unknown, prefix = ""): string[] {
  if (typeof select !== "object" || select === null) {
    return [];
  }
  return Object.entries(select).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (key === "where" || key === "orderBy") {
      return [];
    }
    return [path, ...selectedKeys(value, path)];
  });
}

describe("occurrences", () => {
  it("reads the occurrences of published events in the window, and no person", async () => {
    const { service, findOccurrences } = serviceReading([]);

    await service.occurrences(RANGE);

    const [query] = findOccurrences.mock.calls[0] as unknown as [
      { where: unknown; select: unknown },
    ];
    expect(query.where).toEqual({
      event: { published: true },
      startsAt: { gte: new Date(RANGE.from), lt: new Date(RANGE.to) },
    });
    const keys = selectedKeys(query.select);
    // Sign-ups are counted and never read; who entered a series is not read.
    expect(keys).toContain("_count.select.signups");
    expect(keys.filter((key) => /person|author/i.test(key))).toEqual([]);
  });

  it("projects an occurrence, places left floored at none", async () => {
    const { service } = serviceReading([OCCURRENCE]);

    await expect(service.occurrences(RANGE)).resolves.toEqual([
      {
        eventId: "event-1",
        occurrenceId: "occurrence-1",
        title: "Städdag",
        description: "Ta med arbetshandskar.",
        category: "Städning",
        location: "Gården",
        startsAt: "2026-11-15T09:00:00.000Z",
        endsAt: "2026-11-15T12:00:00.000Z",
        calledOff: false,
        placesLeft: 0,
        audience: "anyone",
      },
    ]);
  });

  it("says when an occurrence is called off, and has no places to count without sign-ups", async () => {
    const { service } = serviceReading([
      {
        ...OCCURRENCE,
        cancelledAt: new Date("2026-11-10T08:00:00Z"),
        event: { ...OCCURRENCE.event, signupOpen: false, visibility: "MEMBER" },
      },
    ]);

    const [occurrence] = await service.occurrences(RANGE);

    expect(occurrence).toMatchObject({
      calledOff: true,
      placesLeft: null,
      audience: "members",
    });
  });

  it("narrows by audience when asked", async () => {
    const { service, findOccurrences } = serviceReading([]);

    await service.occurrences({ ...RANGE, audience: "members" });

    const [query] = findOccurrences.mock.calls[0] as unknown as [
      { where: { event: unknown } },
    ];
    expect(query.where.event).toEqual({
      published: true,
      visibility: "MEMBER",
    });
  });

  it("refuses a window longer than 92 days", async () => {
    const { service, findOccurrences } = serviceReading([]);

    await expect(
      service.occurrences({ ...RANGE, to: "2027-02-02T00:00:00Z" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(findOccurrences).not.toHaveBeenCalled();
  });
});

describe("meetingNotices", () => {
  it("reads the notices of meetings not recorded as held whose day has not passed", async () => {
    const { service, findNotices } = serviceReading([]);

    // Half past midnight on 20 November in Stockholm, still the 19th in UTC:
    // the day compared is the association's own (ADR 0013).
    await service.meetingNotices(new Date("2026-11-19T23:30:00Z"));

    const [query] = findNotices.mock.calls[0] as unknown as [
      { where: unknown; select: unknown },
    ];
    expect(query.where).toEqual({
      meeting: {
        concludedAt: null,
        heldOn: { gte: new Date("2026-11-20T00:00:00Z") },
      },
    });
    // What the notice states, and nothing about who was summoned, who attended
    // or who issued it.
    expect(selectedKeys(query.select).sort()).toEqual([
      "digitalParticipation",
      "meeting",
      "meeting.select",
      "meeting.select.agendaItems",
      "meeting.select.agendaItems.select",
      "meeting.select.agendaItems.select.position",
      "meeting.select.agendaItems.select.title",
      "meeting.select.id",
      "meeting.select.kind",
      "place",
      "startsAt",
    ]);
  });

  it("projects a notice", async () => {
    const { service } = serviceReading([], [NOTICE]);

    await expect(service.meetingNotices()).resolves.toEqual([
      {
        meetingId: "meeting-1",
        kind: "extraordinary",
        startsAt: "2026-11-20T17:00:00.000Z",
        place: "Föreningslokalen",
        digitalParticipation: null,
        agenda: [
          { position: 1, title: "Stämmans öppnande" },
          { position: 2, title: "Val av ordförande" },
        ],
      },
    ]);
  });
});
