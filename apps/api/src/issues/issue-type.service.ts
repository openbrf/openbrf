import { Injectable, Logger } from "@nestjs/common";
import {
  ISSUE_REPORTER_GROUPS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  type IssueReporterGroup,
  type IssueStatusMeaning,
} from "@openbrf/shared";
import type { TFunction } from "i18next";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import { reporterGroupsOf } from "./issue-reporter-groups";
import { lockIssueType } from "./issue-lock";
import { IssueError } from "./issue.error";

/** A status as the board configures it. */
export interface IssueStatusView {
  id: string;
  meaning: IssueStatusMeaning;
  /** The board's own text, stored as written. */
  label: string;
  /** The status of its meaning an issue enters when none is named. */
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  /**
   * How many issues stand in it now. A count, for the reason a type's report
   * count is one: nothing about who reported what belongs on this screen.
   */
  issueCount: number;
}

/** A type as the board configures it. */
export interface IssueTypeView {
  id: string;
  name: string;
  reporters: IssueReporterGroup[];
  active: boolean;
  sortOrder: number;
  /**
   * How many issues have been reported under it. The board needs it to see why
   * a type cannot be deleted, and it is a count rather than a list: nothing
   * about who reported what belongs on a configuration screen.
   */
  reportCount: number;
  /** In the queue's order: by meaning, then the board's order within it. */
  statuses: IssueStatusView[];
}

/** A type as a reporter is offered it. */
export interface ReportableIssueTypeView {
  id: string;
  name: string;
  /**
   * Who may report it. Carried so the resident preview can narrow a handler's
   * list to what a resident would be offered (viewer-preview.ts in the web
   * application); a reporter learns from it only who else may report the type
   * they are looking at.
   */
  reporters: IssueReporterGroup[];
}

export interface IssueTypeInput {
  name: string;
  reporters: readonly IssueReporterGroup[];
  active?: boolean;
  sortOrder?: number;
}

export interface IssueStatusInput {
  meaning: IssueStatusMeaning;
  label: string;
}

export interface IssueStatusChange {
  label: string;
  active?: boolean;
  /** Only `true`: a default stops being one when another takes its place. */
  isDefault?: true;
  sortOrder?: number;
}

/**
 * The set of types a new instance starts with (ADR 0054), so the website's
 * form takes reports on the first day. Named in the association's language as
 * the wizard set it, and then the board's own text like any other type.
 *
 * Only types every handler handles. The board-only types the plan names - an
 * insurance type and Störningar - come with the change that holds a type to
 * the board, because seeding them before that would hand them to the property
 * manager.
 */
const SEEDED_TYPES = [
  { key: "waterLeak", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "heatingAndVentilation", reporters: ["RESIDENTS"] },
  { key: "electricityAndLighting", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "lift", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "laundryRoom", reporters: ["RESIDENTS"] },
  { key: "doorsAndLocks", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "outdoorAreas", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "pests", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "other", reporters: ["PUBLIC", "RESIDENTS"] },
] as const satisfies readonly {
  key: string;
  reporters: readonly IssueReporterGroup[];
}[];

/**
 * The issue types, their statuses, and who is offered which.
 *
 * The catalogue is the board's own vocabulary for its building, so it is
 * configured rather than shipped: a cooperative with a lift, a laundry and a
 * garage does not sort its problems the way one with a courtyard does. What
 * every status means is not the board's to configure (ADR 0054): each belongs
 * to one of four fixed meanings, a type always has one of each, and the board
 * names them, adds to them and switches them off.
 *
 * The reporter filter lives here, in the only place that reads the table, so
 * there is no path to a type list that has not been filtered for the principal
 * asking.
 */
@Injectable()
export class IssueTypeService {
  private readonly logger = new Logger(IssueTypeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Every type, active or not, with its statuses. Reached with
   * issues:configure on the board's screen, and with issues:handle through
   * `issue_type_list` (ADR 0040).
   */
  async listAll(): Promise<IssueTypeView[]> {
    const types = await this.prisma.issueType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: TYPE_INCLUDE,
    });

    return types.map(toView);
  }

  /**
   * The types this principal may file a report under.
   *
   * Pass null for a caller with no session, which is the public form's case.
   * That call is refused outright while the board has the public form switched
   * off, rather than answering with an empty list: a form the board has closed
   * does not exist, and the difference matters to whoever renders it.
   */
  async listReportable(
    principal: Principal | null,
  ): Promise<ReportableIssueTypeView[]> {
    if (principal === null && !(await this.publicReportingEnabled())) {
      throw new IssueError(
        "This association does not take issue reports from the public.",
        "public-reporting-disabled",
      );
    }

    return this.prisma.issueType.findMany({
      where: {
        active: true,
        reporters: { hasSome: [...reporterGroupsOf(principal)] },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, reporters: true },
    });
  }

  /**
   * The type a report may be filed under, with the status a new report enters,
   * or a refusal.
   *
   * Resolved through the same reporter filter as the list rather than beside
   * it: a caller who posts an identifier they were never offered has to be
   * refused by the rule that decided not to offer it, not by a second copy of
   * that rule which could drift.
   */
  async requireReportable(
    principal: Principal | null,
    typeId: string,
  ): Promise<ReportableIssueTypeView & { newStatusId: string }> {
    const offered = await this.listReportable(principal);
    const type = offered.find((candidate) => candidate.id === typeId);
    if (type === undefined) {
      throw new IssueError("No such issue type.", "type-not-found");
    }
    const status = await this.prisma.issueStatus.findFirst({
      where: { typeId: type.id, meaning: "NEW", isDefault: true },
      select: { id: true },
    });
    // A type is written with its four defaults and the default of a meaning
    // cannot be switched off or demoted, so this is a type removed since the
    // read above.
    if (status === null) {
      throw new IssueError("No such issue type.", "type-not-found");
    }
    return { ...type, newStatusId: status.id };
  }

  /** Whether the association takes reports through the public website. */
  async publicReportingEnabled(): Promise<boolean> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { issueReportingPublic: true },
    });

    // A missing association row means an instance whose wizard has not run.
    // There is no website to carry the form yet, so the answer is no.
    return association?.issueReportingPublic === true;
  }

  /**
   * Adds a type, with the default set of statuses: one of each meaning, named
   * in the association's language. A type works with no further setup.
   */
  async create(input: IssueTypeInput): Promise<IssueTypeView> {
    const t = await this.associationTranslator();
    const type = await this.prisma.issueType.create({
      data: {
        name: input.name,
        reporters: uniqueGroups(input.reporters),
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
        statuses: { create: defaultStatuses(t) },
      },
      include: TYPE_INCLUDE,
    });

    this.logger.log(`Added issue type ${type.id}`);
    return toView(type);
  }

  async update(id: string, input: IssueTypeInput): Promise<IssueTypeView> {
    const updating = this.prisma.issueType.update({
      where: { id },
      data: {
        name: input.name,
        reporters: uniqueGroups(input.reporters),
        // Only the fields the caller actually sent. The defaults above belong
        // to create alone: an update that leaves out `active` must not reopen a
        // category the board deliberately closed, and one that leaves out
        // `sortOrder` must not move the type to the top of every picker.
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
      include: TYPE_INCLUDE,
    });
    // Removed by somebody else, or never there.
    const type = await updating.catch((cause: unknown) => {
      throw failedWith(cause, "P2025") ? notFound() : cause;
    });

    return toView(type);
  }

  /**
   * Removes a type nobody has reported under, and its statuses with it.
   *
   * A type that has been used is refused rather than cascaded away. The issues
   * filed under it say what they were about only through it, and a board
   * tidying its categories must not be able to make last winter's reports
   * unreadable. Deactivating is the answer, and the refusal says so.
   */
  async remove(id: string): Promise<void> {
    const type = await this.prisma.issueType.findUnique({
      where: { id },
      select: { _count: { select: { issues: true } } },
    });
    if (type === null) {
      throw notFound();
    }
    if (type._count.issues > 0) {
      throw inUse();
    }

    try {
      await this.prisma.issueType.delete({ where: { id } });
    } catch (cause) {
      /*
       * The count above narrows the window; the foreign key closes it. A
       * report filed between the count and the delete makes the delete raise
       * P2003 against the restrictive key, and a second removal that got there
       * first leaves this one nothing to delete. Both are the refusals above.
       */
      if (failedWith(cause, "P2003")) {
        throw inUse();
      }
      throw failedWith(cause, "P2025") ? notFound() : cause;
    }
    this.logger.log(`Removed issue type ${id}`);
  }

  /**
   * Adds a status to a type, last within its meaning.
   *
   * The meaning is chosen here and never changes: a status that moved from one
   * meaning to another would silently reopen or close every issue standing in
   * it. Under the type's lock, so two additions cannot both pass the bound.
   */
  async addStatus(
    typeId: string,
    input: IssueStatusInput,
  ): Promise<IssueTypeView> {
    await this.prisma.$transaction(async (tx) => {
      await this.requireLockedType(tx, typeId);

      const statuses = await tx.issueStatus.findMany({
        where: { typeId },
        select: { meaning: true, sortOrder: true },
      });
      if (statuses.length >= ISSUE_STATUS_LIMITS.perType) {
        throw new IssueError(
          "This issue type already has as many statuses as it may.",
          "too-many-statuses",
        );
      }
      const last = Math.max(
        -1,
        ...statuses
          .filter((status) => status.meaning === input.meaning)
          .map((status) => status.sortOrder),
      );

      await tx.issueStatus.create({
        data: {
          typeId,
          meaning: input.meaning,
          label: input.label,
          sortOrder: last + 1,
        },
      });
    });

    this.logger.log(`Added a ${input.meaning} status to issue type ${typeId}`);
    return this.view(typeId);
  }

  /**
   * Renames a status, switches it on or off, moves it within its meaning, or
   * makes it the default of its meaning.
   *
   * The default of a meaning is the status an issue enters when none is named,
   * so it stays switched on, and it stops being the default only when another
   * status of the meaning takes its place - never by being demoted on its own,
   * which would leave the meaning with none. Under the type's lock, so two
   * boards making two statuses the default at once settle on one of them
   * rather than on a constraint error.
   *
   * A status issues stand in can be switched off: they stay in it, and a
   * handler can no longer move another issue into it. Statuses are never
   * deleted on their own, because the timeline goes on naming the ones an issue
   * has stood in.
   */
  async updateStatus(
    typeId: string,
    statusId: string,
    change: IssueStatusChange,
  ): Promise<IssueTypeView> {
    await this.prisma.$transaction(async (tx) => {
      await this.requireLockedType(tx, typeId);

      const status = await tx.issueStatus.findFirst({
        where: { id: statusId, typeId },
        select: { id: true, meaning: true, isDefault: true, active: true },
      });
      if (status === null) {
        throw new IssueError("No such status.", "status-not-found");
      }

      const becomesDefault = change.isDefault === true && !status.isDefault;
      const active = change.active ?? status.active;
      if ((status.isDefault || becomesDefault) && !active) {
        throw new IssueError(
          "The default status of a meaning cannot be switched off. Make another status the default first.",
          "default-status-required",
        );
      }

      if (becomesDefault) {
        await tx.issueStatus.updateMany({
          where: { typeId, meaning: status.meaning, isDefault: true },
          data: { isDefault: false },
        });
      }

      await tx.issueStatus.update({
        where: { id: statusId },
        data: {
          label: change.label,
          active,
          ...(becomesDefault ? { isDefault: true } : {}),
          ...(change.sortOrder === undefined
            ? {}
            : { sortOrder: change.sortOrder }),
        },
      });
    });

    this.logger.log(`Changed status ${statusId} of issue type ${typeId}`);
    return this.view(typeId);
  }

  /**
   * Writes the set of types a new instance starts with, unless the instance
   * has any type at all.
   *
   * Called when the wizard finishes, beside the association's first pages and
   * for their reason: the website's form should take a report from the day
   * the instance answers. Writes nothing on a second run, so re-running the
   * wizard from settings cannot bring back a type the board removed.
   */
  async seedDefaultTypes(t: TFunction): Promise<{ created: number }> {
    return this.prisma.$transaction(async (tx) => {
      // Serialised with any other seed, so two completions at once cannot
      // both find the catalogue empty.
      await lockIssueType(tx, "seed");
      if ((await tx.issueType.count()) > 0) {
        return { created: 0 };
      }
      for (const [sortOrder, seeded] of SEEDED_TYPES.entries()) {
        await tx.issueType.create({
          data: {
            name: t(`issues.seededTypes.${seeded.key}`),
            reporters: [...seeded.reporters],
            sortOrder,
            statuses: { create: defaultStatuses(t) },
          },
        });
      }
      this.logger.log(`Wrote the ${SEEDED_TYPES.length} starting issue types`);
      return { created: SEEDED_TYPES.length };
    });
  }

  /** One type as the board's screen shows it, after a write to it. */
  private async view(typeId: string): Promise<IssueTypeView> {
    const type = await this.prisma.issueType.findUnique({
      where: { id: typeId },
      include: TYPE_INCLUDE,
    });
    if (type === null) {
      throw notFound();
    }
    return toView(type);
  }

  private async requireLockedType(
    tx: Prisma.TransactionClient,
    typeId: string,
  ): Promise<void> {
    await lockIssueType(tx, typeId);
    const type = await tx.issueType.findUnique({
      where: { id: typeId },
      select: { id: true },
    });
    if (type === null) {
      throw notFound();
    }
  }

  /** The association's language, which a type and its statuses are named in. */
  private async associationTranslator(): Promise<TFunction> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    return this.i18n.translatorFor(association?.defaultLocale);
  }
}

/** One status of each meaning, each the default of its meaning. */
function defaultStatuses(
  t: TFunction,
): Prisma.IssueStatusCreateWithoutTypeInput[] {
  return ISSUE_STATUS_MEANINGS.map((meaning) => ({
    meaning,
    label: t(`issues.status.${meaning}`),
    isDefault: true,
  }));
}

/** The groups in their declared order, each once. */
function uniqueGroups(
  groups: readonly IssueReporterGroup[],
): IssueReporterGroup[] {
  return ISSUE_REPORTER_GROUPS.filter((group) => groups.includes(group));
}

const TYPE_INCLUDE = {
  _count: { select: { issues: true } },
  statuses: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { issues: true } } },
  },
} as const satisfies Prisma.IssueTypeInclude;

type TypeRecord = Prisma.IssueTypeGetPayload<{ include: typeof TYPE_INCLUDE }>;

function toView(type: TypeRecord): IssueTypeView {
  return {
    id: type.id,
    name: type.name,
    reporters: uniqueGroups(type.reporters),
    active: type.active,
    sortOrder: type.sortOrder,
    reportCount: type._count.issues,
    statuses: [...type.statuses]
      .sort(
        (a, b) =>
          ISSUE_STATUS_MEANINGS.indexOf(a.meaning) -
          ISSUE_STATUS_MEANINGS.indexOf(b.meaning),
      )
      .map((status) => ({
        id: status.id,
        meaning: status.meaning,
        label: status.label,
        isDefault: status.isDefault,
        active: status.active,
        sortOrder: status.sortOrder,
        issueCount: status._count.issues,
      })),
  };
}

function notFound(): IssueError {
  return new IssueError("No such issue type.", "type-not-found");
}

function inUse(): IssueError {
  return new IssueError(
    "Issues have been reported under this type. Deactivate it instead.",
    "type-in-use",
  );
}

/** Whether a write failed with this Prisma error code. */
function failedWith(cause: unknown, code: "P2003" | "P2025"): boolean {
  return (
    cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === code
  );
}
