import { Injectable, Logger } from "@nestjs/common";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { IssueAudience } from "../generated/prisma/enums";
import { reportableAudiences } from "./issue-audience";
import { IssueError } from "./issue.error";

/** A type as the board configures it. */
export interface IssueTypeView {
  id: string;
  name: string;
  audience: IssueAudience;
  active: boolean;
  sortOrder: number;
  /**
   * How many issues have been reported under it. The board needs it to see why
   * a type cannot be deleted, and it is a count rather than a list: nothing
   * about who reported what belongs on a configuration screen.
   */
  reportCount: number;
}

/** A type as a reporter is offered it. */
export interface ReportableIssueTypeView {
  id: string;
  name: string;
  audience: IssueAudience;
}

export interface IssueTypeInput {
  name: string;
  audience: IssueAudience;
  active?: boolean;
  sortOrder?: number;
}

/**
 * The issue types, and who is offered which.
 *
 * The catalogue is the board's own vocabulary for its building, so it is
 * configured rather than shipped: a cooperative with a lift, a laundry and a
 * garage does not sort its problems the way one with a courtyard does.
 *
 * The audience filter lives here, in the only place that reads the table, so
 * there is no path to a type list that has not been filtered for the principal
 * asking.
 */
@Injectable()
export class IssueTypeService {
  private readonly logger = new Logger(IssueTypeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every type, active or not. Reached with issues:configure. */
  async listAll(): Promise<IssueTypeView[]> {
    const types = await this.prisma.issueType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { issues: true } } },
    });

    return types.map((type) => ({
      id: type.id,
      name: type.name,
      audience: type.audience,
      active: type.active,
      sortOrder: type.sortOrder,
      reportCount: type._count.issues,
    }));
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

    const types = await this.prisma.issueType.findMany({
      where: {
        active: true,
        audience: { in: [...reportableAudiences(principal)] },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, audience: true },
    });

    return types;
  }

  /**
   * The type a report may be filed under, or a refusal.
   *
   * Resolved through the same audience filter as the list rather than beside
   * it: a caller who posts an identifier they were never offered has to be
   * refused by the rule that decided not to offer it, not by a second copy of
   * that rule which could drift.
   */
  async requireReportable(
    principal: Principal | null,
    typeId: string,
  ): Promise<ReportableIssueTypeView> {
    const offered = await this.listReportable(principal);
    const type = offered.find((candidate) => candidate.id === typeId);
    if (type === undefined) {
      throw new IssueError("No such issue type.", "type-not-found");
    }
    return type;
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

  async create(input: IssueTypeInput): Promise<IssueTypeView> {
    const type = await this.prisma.issueType.create({
      data: {
        name: input.name,
        audience: input.audience,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    this.logger.log(`Added issue type ${type.id} for ${type.audience}`);
    return { ...toView(type), reportCount: 0 };
  }

  async update(id: string, input: IssueTypeInput): Promise<IssueTypeView> {
    const existing = await this.prisma.issueType.findUnique({
      where: { id },
      select: { id: true, _count: { select: { issues: true } } },
    });
    if (existing === null) {
      throw new IssueError("No such issue type.", "type-not-found");
    }

    const type = await this.prisma.issueType.update({
      where: { id },
      data: {
        name: input.name,
        audience: input.audience,
        // Only the fields the caller actually sent. The defaults above belong
        // to create alone: an update that leaves out `active` must not reopen a
        // category the board deliberately closed, and one that leaves out
        // `sortOrder` must not move the type to the top of every picker.
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.sortOrder === undefined
          ? {}
          : { sortOrder: input.sortOrder }),
      },
    });

    return { ...toView(type), reportCount: existing._count.issues };
  }

  /**
   * Removes a type nobody has reported under.
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
      throw new IssueError("No such issue type.", "type-not-found");
    }
    if (type._count.issues > 0) {
      throw new IssueError(
        "Issues have been reported under this type. Deactivate it instead.",
        "type-in-use",
      );
    }

    await this.prisma.issueType.delete({ where: { id } });
    this.logger.log(`Removed issue type ${id}`);
  }
}

function toView(type: {
  id: string;
  name: string;
  audience: IssueAudience;
  active: boolean;
  sortOrder: number;
}): Omit<IssueTypeView, "reportCount"> {
  return {
    id: type.id,
    name: type.name,
    audience: type.audience,
    active: type.active,
    sortOrder: type.sortOrder,
  };
}
