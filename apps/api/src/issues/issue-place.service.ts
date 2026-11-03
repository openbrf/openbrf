import { Injectable, Logger } from "@nestjs/common";
import { ISSUE_FIT_LIMITS } from "@openbrf/shared";
import type { TFunction } from "i18next";

import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { issueReaderScope, issuesHandledWhere } from "./issue-handlers";
import { lockIssuePlaces } from "./issue-lock";
import { IssueError } from "./issue.error";

/** A place as a reporter or a handler picks it. */
export interface IssuePlaceChoice {
  id: string;
  name: string;
}

/** A place as the board edits it, with how many issues name it. */
export interface ConfiguredIssuePlaceView extends IssuePlaceChoice {
  active: boolean;
  sortOrder: number;
  /** Every issue that names it, whoever may read them. */
  issueCount: number;
}

/**
 * A place with how many issues the reader handles name it (decision 30): the
 * count that makes a repeat fault visible. Closed issues count, because the
 * place stays on a case when its free text is purged (ADR 0057); `open` is
 * the ones still being worked.
 */
export interface IssuePlaceCount extends IssuePlaceChoice {
  active: boolean;
  issues: number;
  open: number;
}

/** What the board writes for a place. */
export interface IssuePlaceInput {
  name: string;
  active?: boolean;
  sortOrder?: number;
}

/**
 * The places a new instance starts with, by their keys under
 * `issues.seededPlaces`, in the language the setup wizard was finished in. None
 * is an apartment. An instance whose setup finished before places existed got
 * the same list from the migration that introduced them.
 */
const SEEDED_PLACES = [
  "laundryRoom",
  "lift",
  "yard",
  "stairwell",
  "basement",
  "attic",
  "bicycleRoom",
  "garage",
  "wasteRoom",
] as const;

/**
 * A name that is an apartment: the word for one, or a number alone, with the
 * letter an apartment number can carry (`1202A`). The list is of common areas
 * (decision 30); an apartment is named by the issue's own apartment, and a list
 * that held them would enumerate the building to everyone who files a report.
 */
const APARTMENT_NAME =
  /^\s*(?:(?:lgh|lägenhet|lägenheten|apt|apartment|flat)\b|\d+\p{L}?\s*$)/iu;

/**
 * The association's list of common-area places (decision 30): a short list such
 * as laundry room, lift, yard, offered beside the free-text location so a
 * repeat fault in the same place can be counted.
 *
 * Written by `issues:configure`, read by everybody who files or handles an
 * issue. The board's own words, monolingual and stored as written like an issue
 * type's name. A place an issue names is switched off and never removed, so the
 * count of faults in the lift survives the board tidying its list.
 */
@Injectable()
export class IssuePlaceService {
  private readonly logger = new Logger(IssuePlaceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The places offered for a new issue, in the board's order. */
  async offered(): Promise<IssuePlaceChoice[]> {
    return this.prisma.issuePlace.findMany({
      where: { active: true },
      orderBy: PLACE_ORDER,
      select: { id: true, name: true },
    });
  }

  /** Every place, switched off or not, for the board's screen. */
  async configured(): Promise<ConfiguredIssuePlaceView[]> {
    const places = await this.prisma.issuePlace.findMany({
      orderBy: PLACE_ORDER,
      select: {
        id: true,
        name: true,
        active: true,
        sortOrder: true,
        _count: { select: { issues: true } },
      },
    });
    return places.map(({ _count, ...place }) => ({
      ...place,
      issueCount: _count.issues,
    }));
  }

  /**
   * The places with how many of the issues this reader handles name each:
   * the count is of what the reader may open, as every other read of the
   * queue is (ADR 0054), so a property manager is not told how many board-only
   * issues the lift has. A place nobody has named still appears, with zeros,
   * while it is switched on.
   */
  async counts(readerPersonId: string): Promise<IssuePlaceCount[]> {
    const scope = await issueReaderScope(
      this.prisma,
      readerPersonId,
      new Date(),
    );
    const handled = issuesHandledWhere(scope);
    const [places, all, open] = await Promise.all([
      this.prisma.issuePlace.findMany({
        orderBy: PLACE_ORDER,
        select: { id: true, name: true, active: true },
      }),
      this.prisma.issue.groupBy({
        by: ["placeId"],
        where: { ...handled, placeId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.issue.groupBy({
        by: ["placeId"],
        where: {
          ...handled,
          placeId: { not: null },
          status: { meaning: { not: "DONE" } },
        },
        _count: { _all: true },
      }),
    ]);
    const countOf = (rows: typeof all, placeId: string): number =>
      rows.find((row) => row.placeId === placeId)?._count._all ?? 0;
    return places
      .map((place) => ({
        ...place,
        issues: countOf(all, place.id),
        open: countOf(open, place.id),
      }))
      .filter((place) => place.active || place.issues > 0);
  }

  async create(input: IssuePlaceInput): Promise<ConfiguredIssuePlaceView> {
    const name = checkedName(input.name);
    const created = await this.prisma.$transaction(async (tx) => {
      await lockIssuePlaces(tx);
      const count = await tx.issuePlace.count();
      if (count >= ISSUE_FIT_LIMITS.places) {
        throw new IssueError(
          "The association already keeps as many places as it may.",
          "too-many-places",
        );
      }
      return tx.issuePlace
        .create({
          data: {
            name,
            active: input.active ?? true,
            sortOrder: input.sortOrder ?? count,
          },
          select: PLACE_SELECT,
        })
        .catch(nameTaken);
    });
    this.logger.log(`Place ${created.id} added`);
    return toConfigured(created);
  }

  async update(
    id: string,
    input: IssuePlaceInput,
  ): Promise<ConfiguredIssuePlaceView> {
    const name = checkedName(input.name);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockIssuePlaces(tx);
      const { count } = await tx.issuePlace
        .updateMany({
          where: { id },
          data: {
            name,
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.sortOrder === undefined
              ? {}
              : { sortOrder: input.sortOrder }),
          },
        })
        .catch(nameTaken);
      if (count === 0) {
        throw notFound();
      }
      return tx.issuePlace.findUniqueOrThrow({
        where: { id },
        select: PLACE_SELECT,
      });
    });
    this.logger.log(`Place ${id} changed`);
    return toConfigured(updated);
  }

  /**
   * Removes a place nothing names. One an issue names is switched off instead:
   * the database refuses to remove it, and the answer is `place-in-use`.
   */
  async remove(id: string): Promise<void> {
    try {
      const { count } = await this.prisma.issuePlace.deleteMany({
        where: { id },
      });
      if (count === 0) {
        throw notFound();
      }
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2003"
      ) {
        throw new IssueError(
          "An issue names this place. Switch it off instead.",
          "place-in-use",
        );
      }
      throw cause;
    }
    this.logger.log(`Place ${id} removed`);
  }

  /**
   * Writes the places a new instance starts with, unless it has any. Called
   * when the setup wizard finishes, beside the starting issue types, and writes
   * nothing on a second run, so re-running the wizard cannot bring back a place
   * the board removed.
   */
  async seedDefaults(t: TFunction): Promise<{ created: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockIssuePlaces(tx);
      if ((await tx.issuePlace.count()) > 0) {
        return { created: 0 };
      }
      for (const [sortOrder, key] of SEEDED_PLACES.entries()) {
        await tx.issuePlace.create({
          data: { name: t(`issues.seededPlaces.${key}`), sortOrder },
        });
      }
      this.logger.log(`Wrote the ${SEEDED_PLACES.length} starting places`);
      return { created: SEEDED_PLACES.length };
    });
  }
}

const PLACE_ORDER = [
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.IssuePlaceOrderByWithRelationInput[];

const PLACE_SELECT = {
  id: true,
  name: true,
  active: true,
  sortOrder: true,
  _count: { select: { issues: true } },
} as const;

function toConfigured(
  place: Prisma.IssuePlaceGetPayload<{ select: typeof PLACE_SELECT }>,
): ConfiguredIssuePlaceView {
  const { _count, ...rest } = place;
  return { ...rest, issueCount: _count.issues };
}

/** The name as it is stored: trimmed, and not an apartment. */
function checkedName(name: string): string {
  const trimmed = name.trim();
  if (APARTMENT_NAME.test(trimmed)) {
    throw new IssueError(
      "A place is a common area, never an apartment.",
      "place-name-apartment",
    );
  }
  return trimmed;
}

/** The name is taken, whatever its capitalisation: the unique index said so. */
function nameTaken(cause: unknown): never {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2002"
  ) {
    throw new IssueError(
      "There is already a place of that name.",
      "place-name-taken",
    );
  }
  throw cause;
}

function notFound(): IssueError {
  return new IssueError("No such place.", "place-not-found");
}
