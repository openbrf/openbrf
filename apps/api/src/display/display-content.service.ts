import { Injectable } from "@nestjs/common";
import {
  availabilityWindow,
  buildRotation,
  type PictureFileInput,
  type RotationInput,
  SCREEN_CONTENT_VERSION,
  type ScreenContent,
  type Slide,
} from "@openbrf/display";
import type { DeviceTokenSummary, PluginNewsItem } from "@openbrf/plugin-sdk";
import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";
import { createHash } from "node:crypto";

import { PrismaService } from "../database/prisma.service";
import { MediaService, type ServedFile } from "../media/media.service";
import { PluginBookingsService } from "../plugins/plugin-bookings.service";
import { PluginCalendarService } from "../plugins/plugin-calendar.service";
import type { ContentReader } from "../plugins/plugin-content";
import { PluginNewsService } from "../plugins/plugin-news.service";
import {
  type DisplayLocale,
  type DisplayOptions,
  MAX_DISPLAY_RESOURCES,
} from "./display-options";

/**
 * Every read the display route makes: through the narrowed reads a plugin with
 * a device route gets, the register check included, and only what the board
 * marked "show on screens" (ADR 0050).
 */
const DISPLAY_READER: ContentReader = {
  forDevices: true,
  onScreensOnly: true,
};

/** The most news items the rotation holds, a slide each. */
const MAX_NEWS = 10;

/**
 * How far either side of the fetch the occurrences are read: an occurrence
 * that began before the fetch and has not ended is still coming up, and the
 * rotation holds those starting within 31 days. The builder keeps the ones
 * that matter; 62 days is inside the 92 one read may span.
 */
const OCCURRENCE_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often a screen fetches again. The contract's longest. */
const REFRESH_SECONDS = 60;

/** A document, and the strong entity tag a screen asks again with. */
export interface DisplayAnswer {
  content: ScreenContent;
  etag: string;
}

/**
 * The display mode's screen content: the document the core's display route
 * serves a screen holding a display link (ADR 0050).
 *
 * Built on every request that is not answered 304, from the published content
 * the board marked for screens and from nothing else: it calls no extension
 * point and no plugin, so no path leads from it to the register or to an
 * addon. What it reads, it reads as a plugin with a device route does, so an
 * item whose text names somebody in the register, or an apartment number, is
 * absent here as on every device, and no busy interval that ended before the
 * fetch is in it. The rotation is the shared builder's, the one the signage
 * module's route uses as well.
 */
@Injectable()
export class DisplayContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly news: PluginNewsService,
    private readonly calendar: PluginCalendarService,
    private readonly bookings: PluginBookingsService,
    private readonly media: MediaService,
  ) {}

  /** The document for one screen's token and options, at `now`. */
  async content(
    device: DeviceTokenSummary,
    options: DisplayOptions,
    now: Date = new Date(),
  ): Promise<DisplayAnswer> {
    const [rotation, locale] = await Promise.all([
      this.rotation(options, now),
      this.locale(options.locale),
    ]);
    const content: ScreenContent = {
      version: SCREEN_CONTENT_VERSION,
      // The token's id: the display route needs no other name for a screen.
      screenId: device.id,
      generatedAt: wholeSeconds(now),
      refreshSeconds: REFRESH_SECONDS,
      locale,
      timeZone: ASSOCIATION_TIME_ZONE,
      // Read by no one: a screen on a display link takes no player releases.
      releaseChannel: "stable",
      layout: {
        orientation: options.orientation,
        header: options.header,
        theme: options.theme,
      },
      // Empty: the screen shows the rotation all day. A schedule is decided
      // per screen, which is the module's remote configuration.
      schedule: { on: [] },
      rotation,
    };
    return { content, etag: entityTag(content) };
  }

  /**
   * A picture the display mode shows, when the news it shows refers to it and
   * `media:read` would open it (ADR 0032), or null.
   *
   * A picture's address is resolved against the content request's without its
   * query, so the screen's options are not known here: the picture is looked
   * for among the news items the display mode shows any screen, which are the
   * only slides that carry one.
   */
  async picture(mediaFileId: string): Promise<ServedFile | null> {
    const items = await this.news.published(
      { limit: MAX_NEWS },
      DISPLAY_READER,
    );
    const shown = await this.firstPictures(items);
    return shown.has(mediaFileId)
      ? await this.media.openForPlugin(mediaFileId)
      : null;
  }

  private async rotation(options: DisplayOptions, now: Date): Promise<Slide[]> {
    const wanted = new Set(options.sources);
    const [news, occurrences, meetingNotices, availability] = await Promise.all(
      [
        wanted.has("news") ? this.newsWithPictures() : undefined,
        wanted.has("events")
          ? this.calendar.occurrences(
              {
                from: new Date(
                  now.getTime() - OCCURRENCE_DAYS * DAY_MS,
                ).toISOString(),
                to: new Date(
                  now.getTime() + OCCURRENCE_DAYS * DAY_MS,
                ).toISOString(),
              },
              DISPLAY_READER,
            )
          : undefined,
        wanted.has("meeting")
          ? this.calendar.meetingNotices(DISPLAY_READER, now)
          : undefined,
        wanted.has("availability")
          ? this.availability(options.resources, now)
          : undefined,
      ],
    );

    return buildRotation({
      now,
      ...(news === undefined ? {} : news),
      ...(occurrences === undefined ? {} : { occurrences }),
      ...(meetingNotices === undefined ? {} : { meetingNotices }),
      ...(availability === undefined ? {} : { availability }),
    });
  }

  /** The marked news, and the picture each shows. */
  private async newsWithPictures(): Promise<
    Pick<RotationInput, "news" | "pictures">
  > {
    const news = await this.news.published({ limit: MAX_NEWS }, DISPLAY_READER);
    return { news, pictures: await this.firstPictures(news) };
  }

  /**
   * Each item's first picture that `media:read` would open (ADR 0050), by
   * media file id, with what the document says of it. A picture it would not
   * open is passed over for the next.
   */
  private async firstPictures(
    items: readonly PluginNewsItem[],
  ): Promise<Map<string, PictureFileInput>> {
    const pictures = new Map<string, PictureFileInput>();
    for (const item of items) {
      for (const { mediaFileId } of item.pictures) {
        const known = pictures.get(mediaFileId);
        if (known !== undefined) {
          break;
        }
        const file = await this.media.openForPlugin(mediaFileId);
        if (file === null) {
          continue;
        }
        // Only what the document names; the bytes are the pictures route's.
        file.stream.destroy();
        pictures.set(mediaFileId, {
          contentType: file.contentType,
          byteSize: file.byteSize,
          version: file.checksum,
        });
        break;
      }
    }
    return pictures;
  }

  /**
   * The chosen resources, in the board's order, or every open one up to
   * twelve, with when each is taken from the minute of the fetch to the end of
   * the next day. A chosen id that is not an open resource, or one the
   * register check withholds, is left out as if it had not been chosen.
   */
  private async availability(
    chosen: readonly string[] | null,
    now: Date,
  ): Promise<NonNullable<RotationInput["availability"]>> {
    const window = availabilityWindow(now, ASSOCIATION_TIME_ZONE);
    const offered = await this.bookings.resources(DISPLAY_READER);
    const resources =
      chosen === null
        ? offered.slice(0, MAX_DISPLAY_RESOURCES)
        : chosen.flatMap((id) =>
            offered.filter((resource) => resource.id === id),
          );
    const busy =
      resources.length === 0
        ? []
        : await this.bookings.busy(
            {
              from: window.from.toISOString(),
              to: window.to.toISOString(),
              resourceIds: resources.map((resource) => resource.id),
            },
            DISPLAY_READER,
            now,
          );
    return { from: window.from, to: window.to, resources, busy };
  }

  /** The link's language, or the instance's default one. */
  private async locale(chosen: DisplayLocale | null): Promise<DisplayLocale> {
    if (chosen !== null) {
      return chosen;
    }
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    return association?.defaultLocale === "en" ? "en" : "sv";
  }
}

/** An instant as the contract writes one: UTC, whole seconds, "Z". */
function wholeSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * The strong entity tag of a document.
 *
 * Over everything but `generatedAt`, which changes on every request: a screen
 * whose content has not changed is answered 304 and keeps the document it has.
 */
function entityTag(content: ScreenContent): string {
  const { generatedAt: _generatedAt, ...rest } = content;
  const digest = createHash("sha256")
    .update(JSON.stringify(rest))
    .digest("base64url");
  return `"${digest}"`;
}
