/**
 * Documents the suites build on: valid version 1 documents and slides, which
 * a test changes in the one place it is about.
 */
import type { ScreenContent, Slide } from "../src/contract.ts";

export function screenContent(
  rotation: Slide[],
  overrides: Partial<ScreenContent> = {},
): ScreenContent {
  return {
    version: 1,
    screenId: "screen-1",
    generatedAt: "2026-10-23T10:00:00Z",
    refreshSeconds: 60,
    locale: "en",
    timeZone: "Europe/Stockholm",
    releaseChannel: "stable",
    layout: { orientation: 0, header: "none", theme: "dark" },
    schedule: { on: [] },
    rotation,
    ...overrides,
  };
}

export function newsSlide(id: string, overrides: Partial<Slide> = {}): Slide {
  return {
    id,
    seconds: 15,
    until: null,
    source: "news",
    addon: null,
    body: {
      kind: "news",
      title: `Title of ${id}`,
      paragraphs: [`Text of ${id}`],
      picture: null,
      publishedAt: "2026-10-20T08:00:00Z",
    },
    ...overrides,
  };
}

export function eventsSlide(): Slide {
  return {
    id: "events",
    seconds: 20,
    until: null,
    source: "events",
    addon: null,
    body: {
      kind: "events",
      occurrences: [
        {
          title: "Cleaning day",
          description: "Bring gloves.",
          location: "The courtyard",
          startsAt: "2026-10-24T08:00:00Z",
          endsAt: "2026-10-24T11:00:00Z",
          calledOff: false,
          placesLeft: 3,
        },
        {
          title: "Sauna evening",
          description: null,
          location: null,
          startsAt: "2026-10-25T16:00:00Z",
          endsAt: "2026-10-25T18:00:00Z",
          calledOff: true,
          placesLeft: null,
        },
        {
          title: "Board meeting",
          description: null,
          location: null,
          startsAt: "2026-10-26T17:00:00Z",
          endsAt: "2026-10-26T19:00:00Z",
          calledOff: false,
          placesLeft: 0,
        },
      ],
    },
  };
}

export function meetingSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: "meeting.m1",
    seconds: 20,
    until: "2026-11-12T17:30:00Z",
    source: "meeting",
    addon: null,
    body: {
      kind: "meeting",
      meetingKind: "ordinary",
      startsAt: "2026-11-12T17:30:00Z",
      place: "The common room",
      digitalParticipation: "Join by video at the address in the notice.",
      agenda: [
        { position: 1, title: "Opening of the meeting" },
        { position: 2, title: "Election of a chair" },
      ],
    },
    ...overrides,
  };
}

export function availabilitySlide(): Slide {
  return {
    id: "availability",
    seconds: 20,
    until: null,
    source: "availability",
    addon: null,
    body: {
      kind: "availability",
      from: "2026-10-23T10:00:00Z",
      to: "2026-10-24T22:00:00Z",
      resources: [
        {
          name: "Laundry room",
          mode: "timeSlots",
          slotMinutes: 120,
          opensAtMinute: 420,
          closesAtMinute: 1320,
          busy: [
            { start: "2026-10-23T12:00:00Z", end: "2026-10-23T14:00:00Z" },
          ],
        },
      ],
    },
  };
}

export function pictureSlide(id: string): Slide {
  return {
    id,
    seconds: 10,
    until: null,
    source: "picture",
    addon: null,
    body: {
      kind: "picture",
      picture: {
        mediaFileId: `file-${id}`,
        contentType: "image/png",
        byteSize: 1234,
        version: "v1",
        alt: "The courtyard in autumn",
      },
      caption: "Autumn in the courtyard",
    },
  };
}

export function addonSlides(): Slide[] {
  return [
    {
      id: "addon.text",
      seconds: 10,
      until: null,
      source: "addon",
      addon: "residents",
      body: { kind: "text", heading: "Welcome", body: ["Shoes off, please."] },
    },
    {
      id: "addon.table",
      seconds: 10,
      until: null,
      source: "addon",
      addon: "residents",
      body: {
        kind: "table",
        heading: "Waste collection",
        columns: ["Kind", "Day"],
        rows: [
          ["Paper", "Monday"],
          ["Glass", "Thursday"],
        ],
      },
    },
    {
      id: "addon.doors",
      seconds: 10,
      until: null,
      source: "addon",
      addon: "residents",
      body: {
        kind: "doors",
        heading: "Entrance A",
        doors: [{ floor: 2, apartment: "1201", names: ["Andersson", "Berg"] }],
      },
    },
  ];
}
