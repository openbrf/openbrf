import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import type { MediaService } from "../media/media.service";
import type { PluginBookingsService } from "../plugins/plugin-bookings.service";
import type { PluginCalendarService } from "../plugins/plugin-calendar.service";
import type { ContentReader } from "../plugins/plugin-content";
import type { PluginNewsService } from "../plugins/plugin-news.service";
import { DisplayContentService } from "./display-content.service";
import { readDisplayOptions } from "./display-options";

const NOW = new Date("2026-12-01T09:00:30.250Z");

const DEVICE: DeviceTokenSummary = {
  id: "token-1",
  route: "display",
  subject: "display",
  label: "Entrance B",
  issuedAt: "2026-11-01T09:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

function service(
  pictures: readonly { mediaFileId: string; alt: string }[] = [],
) {
  const readers: ContentReader[] = [];
  const seen = (reader: ContentReader) => {
    readers.push(reader);
  };
  const news = {
    published: vi.fn(async (_options: unknown, reader: ContentReader) => {
      seen(reader);
      return [
        {
          id: "n1",
          title: "Städdag",
          paragraphs: ["Ta med krattor."],
          pictures,
          audience: "members",
          publishedAt: "2026-11-30T08:00:00.000Z",
          onScreens: true,
        },
      ];
    }),
  };
  const calendar = {
    occurrences: vi.fn(async (_range: unknown, reader: ContentReader) => {
      seen(reader);
      return [];
    }),
    meetingNotices: vi.fn(async (reader: ContentReader) => {
      seen(reader);
      return [];
    }),
  };
  const bookings = {
    resources: vi.fn(async (reader: ContentReader) => {
      seen(reader);
      return [
        {
          id: "room-a",
          name: "Tvättstuga A",
          mode: "timeSlots" as const,
          slotMinutes: 60,
          opensAtMinute: 420,
          closesAtMinute: 1260,
        },
        {
          id: "room-b",
          name: "Tvättstuga B",
          mode: "timeSlots" as const,
          slotMinutes: 60,
          opensAtMinute: 420,
          closesAtMinute: 1260,
        },
      ];
    }),
    busy: vi.fn(async (_range: unknown, reader: ContentReader) => {
      seen(reader);
      return [];
    }),
  };
  const prisma = {
    association: {
      findUnique: vi.fn(async () => ({ defaultLocale: "en" })),
    },
  };
  // Only "picture-open" is a picture media:read would open.
  const media = {
    openForPlugin: vi.fn(async (id: string) =>
      id === "picture-open"
        ? {
            contentType: "image/png",
            byteSize: 12,
            checksum: "sum-1",
            fileName: "x.png",
            visibility: "PUBLIC",
            stream: { destroy: vi.fn() },
          }
        : null,
    ),
  };
  return {
    readers,
    media,
    news,
    calendar,
    bookings,
    display: new DisplayContentService(
      prisma as unknown as PrismaService,
      news as unknown as PluginNewsService,
      calendar as unknown as PluginCalendarService,
      bookings as unknown as PluginBookingsService,
      media as unknown as MediaService,
    ),
  };
}

describe("DisplayContentService", () => {
  it("reads everything as a device, and only what the board marked for screens", async () => {
    const { display, readers } = service();

    await display.content(DEVICE, readDisplayOptions({}), NOW);

    // News, occurrences, notices, resources and busy: five reads, each one
    // through the register check and the mark.
    expect(readers).toHaveLength(5);
    for (const reader of readers) {
      expect(reader).toEqual({ forDevices: true, onScreensOnly: true });
    }
  });

  it("reads nothing for a source the link leaves out", async () => {
    const { display, news, calendar, bookings } = service();

    await display.content(
      DEVICE,
      readDisplayOptions({ sources: "meeting" }),
      NOW,
    );

    expect(news.published).not.toHaveBeenCalled();
    expect(calendar.occurrences).not.toHaveBeenCalled();
    expect(bookings.resources).not.toHaveBeenCalled();
    expect(calendar.meetingNotices).toHaveBeenCalledTimes(1);
  });

  it("writes the document the display route serves", async () => {
    const { display } = service();

    const { content, etag } = await display.content(
      DEVICE,
      readDisplayOptions({ theme: "light", orientation: "90" }),
      NOW,
    );

    expect(content).toMatchObject({
      version: 1,
      screenId: "token-1",
      generatedAt: "2026-12-01T09:00:30Z",
      refreshSeconds: 60,
      locale: "en",
      timeZone: "Europe/Stockholm",
      releaseChannel: "stable",
      layout: { orientation: 90, header: "clock", theme: "light" },
      schedule: { on: [] },
    });
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it("gives the same tag to the same content at another second", async () => {
    const { display } = service();
    const options = readDisplayOptions({ sources: "news" });

    const first = await display.content(DEVICE, options, NOW);
    const later = await display.content(
      DEVICE,
      options,
      new Date(NOW.getTime() + 20_000),
    );

    expect(later.content.generatedAt).not.toBe(first.content.generatedAt);
    expect(later.etag).toBe(first.etag);
  });

  it("shows the chosen resources in the board's order, and leaves out one it does not offer", async () => {
    const { display, bookings } = service();

    const { content } = await display.content(
      DEVICE,
      readDisplayOptions({
        sources: "availability",
        resources: "room-b,gone,room-a",
      }),
      NOW,
    );

    const slide = content.rotation[0];
    expect(slide?.body.kind).toBe("availability");
    expect(
      slide?.body.kind === "availability"
        ? slide.body.resources.map((resource) => resource.name)
        : [],
    ).toEqual(["Tvättstuga B", "Tvättstuga A"]);
    expect(bookings.busy).toHaveBeenCalledWith(
      expect.objectContaining({ resourceIds: ["room-b", "room-a"] }),
      { forDevices: true, onScreensOnly: true },
      NOW,
    );
  });

  it("takes the link's language over the instance's", async () => {
    const { display } = service();

    const { content } = await display.content(
      DEVICE,
      readDisplayOptions({ locale: "sv" }),
      NOW,
    );

    expect(content.locale).toBe("sv");
  });

  it("shows a news item's first picture that media:read would open", async () => {
    const { display } = service([
      { mediaFileId: "picture-closed", alt: "Stängd" },
      { mediaFileId: "picture-open", alt: "Gården" },
    ]);

    const { content } = await display.content(
      DEVICE,
      readDisplayOptions({ sources: "news" }),
      NOW,
    );

    const body = content.rotation[0]?.body;
    expect(body?.kind === "news" ? body.picture : null).toEqual({
      mediaFileId: "picture-open",
      contentType: "image/png",
      byteSize: 12,
      version: "sum-1",
      alt: "Gården",
    });
  });

  it("serves only the picture a news slide shows", async () => {
    const { display } = service([
      { mediaFileId: "picture-closed", alt: "Stängd" },
      { mediaFileId: "picture-open", alt: "Gården" },
    ]);

    await expect(display.picture("picture-open")).resolves.toMatchObject({
      checksum: "sum-1",
    });
    await expect(display.picture("picture-closed")).resolves.toBeNull();
    await expect(display.picture("picture-elsewhere")).resolves.toBeNull();
  });
});
