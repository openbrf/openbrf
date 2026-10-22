import { MAX_WITHHELD_IDS } from "@openbrf/shared";
import { Injectable } from "@nestjs/common";
import { z } from "zod";

import { PrismaService } from "../database/prisma.service";
import {
  proseParagraphs,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import {
  bookableResourceTexts,
  eventTexts,
  meetingNoticeTexts,
  newsItemTexts,
} from "./checked-texts";
import {
  type CheckedItem,
  RegisterCheckService,
  type WithheldFromDevices,
  withheldFromDevices,
} from "./register-check.service";

/** One item an editor shows that the register check withholds from devices. */
export interface WithheldItem {
  readonly id: string;
  readonly withheldFromDevices: WithheldFromDevices;
}

/**
 * The mark the core's own editors show on an item the register check withholds
 * from devices, and the words that caused it (ADR 0032, "The core's own editors
 * say so").
 *
 * Each read checks the strings a device's read would check (checked-texts.ts),
 * of the items the editor names, whether or not they are published yet: a
 * board writing a notice for the stairwell wants to know before it goes up. It
 * answers only the items that are withheld, each with what the editor may show
 * of the words.
 */
@Injectable()
export class WithheldFromDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registerCheck: RegisterCheckService,
  ) {}

  async news(ids: readonly string[]): Promise<WithheldItem[]> {
    const rows = await this.prisma.news.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true, content: true },
    });
    return this.marked(
      rows.map((row) => ({
        id: row.id,
        texts: newsItemTexts({
          title: row.title,
          paragraphs: proseParagraphs(
            textBlocksOnly(readPageContent(row.content)),
          ),
        }),
      })),
    );
  }

  async events(ids: readonly string[]): Promise<WithheldItem[]> {
    const rows = await this.prisma.event.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        location: true,
      },
    });
    return this.marked(
      rows.map((row) => ({ id: row.id, texts: eventTexts(row) })),
    );
  }

  /**
   * A meeting's agenda titles and, once it is issued, its notice's place and
   * digital participation: what a device would be handed of the notice.
   */
  async meetings(ids: readonly string[]): Promise<WithheldItem[]> {
    const rows = await this.prisma.meeting.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        agendaItems: { select: { title: true } },
        notice: { select: { place: true, digitalParticipation: true } },
      },
    });
    return this.marked(
      rows.map((row) => ({
        id: row.id,
        texts: meetingNoticeTexts({
          place: row.notice?.place ?? null,
          digitalParticipation: row.notice?.digitalParticipation ?? null,
          agenda: row.agendaItems,
        }),
      })),
    );
  }

  async bookableResources(ids: readonly string[]): Promise<WithheldItem[]> {
    const rows = await this.prisma.bookableResource.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return this.marked(
      rows.map((row) => ({ id: row.id, texts: bookableResourceTexts(row) })),
    );
  }

  private async marked(
    items: readonly { id: string; texts: CheckedItem }[],
  ): Promise<WithheldItem[]> {
    if (items.length === 0) {
      return [];
    }
    const matches = await this.registerCheck.matches(
      items.map((item) => item.texts),
    );
    return items.flatMap((item, index) => {
      const mark = withheldFromDevices(matches[index] ?? []);
      return mark === null ? [] : [{ id: item.id, withheldFromDevices: mark }];
    });
  }
}

/**
 * The ids an editor asked about, from `?ids=a,b,c`: at most
 * {@link MAX_WITHHELD_IDS}, each one an id and not free text. Absent asks
 * about none.
 */
export const withheldIdsSchema = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value === "" ? [] : [...new Set(value.split(","))],
  )
  .pipe(
    z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(MAX_WITHHELD_IDS),
  );
