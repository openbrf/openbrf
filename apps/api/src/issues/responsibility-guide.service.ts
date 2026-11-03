import { Injectable, Logger } from "@nestjs/common";
import {
  type MaintenanceResponsibility,
  RESPONSIBILITY_GUIDE_LIMITS,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { lockResponsibilityGuide } from "./issue-lock";
import {
  ResponsibilityGuideError,
  type ResponsibilityGuideTextLocation,
} from "./responsibility-guide.error";

/** One line of the guide, as it is read and as it is written. */
export interface ResponsibilityGuideItemView {
  /** "Golvbrunn, rensning". */
  part: string;
  responsibility: MaintenanceResponsibility;
  note: string | null;
}

/**
 * The association's responsibility guide (ansvarsfördelning).
 *
 * `adoptedAt` is null while the guide is an example the board has not said
 * follows its bylaws, and every screen that shows it then says so.
 */
export interface ResponsibilityGuideView {
  adoptedAt: string | null;
  items: ResponsibilityGuideItemView[];
}

/** What the board saves: the whole guide, and whether it adopts it. */
export interface SaveResponsibilityGuideInput {
  items: readonly ResponsibilityGuideItemView[];
  adopted: boolean;
}

/**
 * The association's responsibility guide (ansvarsfördelning, decision 27 of
 * the issue module plan): which part of the home or the building the
 * association maintains and which the tenant-owner does, as the board reads
 * its own bylaws.
 *
 * ## A template, never a legal fact
 *
 * BRL 7 kap. 12 § puts the upkeep of the apartment on the tenant-owner "om
 * inte något annat bestämts i stadgarna", so the line between the two is each
 * association's own and moves with its bylaws. Nothing here states where it
 * runs. The product offers an example to start from, which the board's screen
 * loads into the form, and the guide stays labelled as an example until the
 * board adopts it - says that it follows its bylaws.
 *
 * Who reads it follows from that. A handler deciding who pays reads it either
 * way, with the label. A reporter is shown it before they file only once it is
 * adopted: an example shown to a resident as if it were the association's
 * answer is the legal fact this module refuses to state.
 *
 * ## Saved whole
 *
 * The board edits the table and saves it, so a save replaces every line in
 * one transaction under a lock of its own: two saves at once would otherwise
 * each delete what the other had not yet written and leave both sets behind.
 */
@Injectable()
export class ResponsibilityGuideService {
  private readonly logger = new Logger(ResponsibilityGuideService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The guide as the board and the handlers read it, adopted or not. */
  async read(): Promise<ResponsibilityGuideView> {
    return readGuide(this.prisma);
  }

  /**
   * The guide as a reporter is shown it before filing: the adopted guide, or
   * null while it is an example or has no lines.
   */
  async readForReporter(): Promise<ResponsibilityGuideView | null> {
    const guide = await this.read();
    return guide.adoptedAt === null || guide.items.length === 0 ? null : guide;
  }

  /**
   * Replaces the guide with the board's lines, and adopts it or withdraws the
   * adoption.
   *
   * Adopting keeps the first date it was adopted on while it stays adopted, so
   * correcting a line in an adopted guide does not move the day the board
   * first said it follows the bylaws.
   */
  async save(
    input: SaveResponsibilityGuideInput,
    now: Date = new Date(),
  ): Promise<ResponsibilityGuideView> {
    const items = readItems(input.items);

    const view = await this.prisma.$transaction(async (tx) => {
      await lockResponsibilityGuide(tx);

      const existing = await tx.responsibilityGuide.findUnique({
        where: { id: 1 },
        select: { adoptedAt: true },
      });
      const adoptedAt = input.adopted ? (existing?.adoptedAt ?? now) : null;

      await tx.responsibilityGuide.upsert({
        where: { id: 1 },
        create: { id: 1, adoptedAt },
        update: { adoptedAt },
      });
      await tx.responsibilityGuideItem.deleteMany({});
      await tx.responsibilityGuideItem.createMany({
        data: items.map((item, sortOrder) => ({ ...item, sortOrder })),
      });

      return readGuide(tx);
    });

    this.logger.log(
      `Saved the responsibility guide with ${String(items.length)} lines, ` +
        (view.adoptedAt === null ? "not adopted" : "adopted"),
    );
    return view;
  }
}

async function readGuide(
  db: PrismaService | Prisma.TransactionClient,
): Promise<ResponsibilityGuideView> {
  const [guide, items] = await Promise.all([
    db.responsibilityGuide.findUnique({
      where: { id: 1 },
      select: { adoptedAt: true },
    }),
    db.responsibilityGuideItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { part: true, responsibility: true, note: true },
    }),
  ]);
  return {
    adoptedAt: guide?.adoptedAt?.toISOString() ?? null,
    items,
  };
}

/**
 * The lines as they are stored: trimmed, an empty note as none, and refused
 * where a line has no part, runs past a limit or carries a personal identity
 * number.
 */
function readItems(
  items: readonly ResponsibilityGuideItemView[],
): ResponsibilityGuideItemView[] {
  if (items.length > RESPONSIBILITY_GUIDE_LIMITS.items) {
    throw new ResponsibilityGuideError(
      "The guide holds more lines than it may.",
      "too-many-items",
    );
  }

  const read = items.map((item) => {
    const part = item.part.trim();
    const note = item.note?.trim() ?? "";
    if (part === "") {
      throw new ResponsibilityGuideError(
        "Every line names the part it is about.",
        "part-required",
      );
    }
    if (
      part.length > RESPONSIBILITY_GUIDE_LIMITS.part ||
      note.length > RESPONSIBILITY_GUIDE_LIMITS.note
    ) {
      throw new ResponsibilityGuideError(
        "A line is longer than the guide holds.",
        "text-too-long",
      );
    }
    return {
      part,
      responsibility: item.responsibility,
      note: note === "" ? null : note,
    };
  });

  /*
   * The guide is shown to every resident before they file, so a personnummer
   * pasted into it would be published to the house. The refusal names where,
   * never what.
   */
  const locations: ResponsibilityGuideTextLocation[] = read.flatMap(
    (item, index) => [
      ...scanForPersonalIdentityNumbers(item.part).map((hit) => ({
        item: index,
        field: "part" as const,
        offset: hit.index,
      })),
      ...scanForPersonalIdentityNumbers(item.note ?? "").map((hit) => ({
        item: index,
        field: "note" as const,
        offset: hit.index,
      })),
    ],
  );
  if (locations.length > 0) {
    throw new ResponsibilityGuideError(
      "The guide carries a personal identity number and cannot be saved.",
      "personal-identity-number",
      locations,
    );
  }

  return read;
}
