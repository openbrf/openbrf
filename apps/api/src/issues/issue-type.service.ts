import { Injectable, Logger } from "@nestjs/common";
import {
  type AuthorView,
  ISSUE_REPORTER_GROUPS,
  ISSUE_STATUS_LIMITS,
  ISSUE_STATUS_MEANINGS,
  type IssueHandledBy,
  type IssuePriority,
  type IssueReporterGroup,
  type IssueStatusMeaning,
} from "@openbrf/shared";
import type { TFunction } from "i18next";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { readAuthors } from "../feed/feed-author";
import { Prisma } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import {
  handlesIssues,
  issueHandlersWhere,
  issueReaderScope,
  readIssueHandlers,
  typesHandledWhere,
} from "./issue-handlers";
import { reporterGroupsOf } from "./issue-reporter-groups";
import {
  lockIssueType,
  lockIssueTypeRingFence,
  MAIL_TRANSACTION_MS,
} from "./issue-lock";
import { IssueError } from "./issue.error";
import { issueTextClockYears, issueTextClocks } from "./issue-free-text";
import { revokeWorkOrderLinks } from "./work-order-link";

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
  /** Who handles its issues: every handler, or the board only. */
  handledBy: IssueHandledBy;
  /** The priority its issues are filed with. */
  defaultPriority: IssuePriority;
  /**
   * Whether its issues are ring-fenced (decision 32): read by the board alone,
   * with nothing about them leaving it, and their free text removed one year
   * after closing. Only a board member or an administrator is shown a type
   * that carries it, because only they handle one.
   */
  ringFenced: boolean;
  /**
   * How many issues have been reported under it. The board needs it to see why
   * a type cannot be deleted, and it is a count rather than a list: nothing
   * about who reported what belongs on a configuration screen.
   */
  reportCount: number;
  /** In the queue's order: by meaning, then the board's order within it. */
  statuses: IssueStatusView[];
}

/**
 * A type as the board configures it, with its default assignee.
 *
 * Only on the configuration screen: a type's setting naming a person is
 * configuration, and neither the handlers' list of types nor the catalogue's
 * `issue_type_list` reads a person (ADR 0056).
 */
export type ConfiguredIssueTypeView = IssueTypeView & {
  defaultAssignee: AuthorView | null;
};

/**
 * Somebody a type's issues may be given to by default, and whether the board
 * keeps them when the type is handled by the board only.
 */
export interface IssueHandlerChoice {
  handler: AuthorView;
  /** A board member with a seat or an administrator, not only a handler. */
  board: boolean;
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
  /**
   * Whether the type is ring-fenced (decision 32), so the form can warn the
   * reporter before they write: only the board reads it, what to write and
   * what not to, and that a report here is no formal step under the
   * bostadsrättslag. Never true on the website's form, which offers no
   * ring-fenced type.
   */
  ringFenced: boolean;
  /**
   * How many years after closing the free text of an issue of this type is
   * removed (`issueTextClockYears`), so the form tells the reporter the clock
   * the purge keeps (GDPR art. 13(2)(a)): the board's setting, or the board's
   * ring-fenced one.
   */
  textRetentionYears: number;
}

export interface IssueTypeInput {
  name: string;
  reporters: readonly IssueReporterGroup[];
  active?: boolean;
  sortOrder?: number;
  handledBy?: IssueHandledBy;
  defaultPriority?: IssuePriority;
  /** Null for none; absent leaves the setting as it is. */
  defaultAssigneePersonId?: string | null;
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
 * A water leak files at Akut, the plan's own example of a default priority
 * (decision 11). The insurance type is the board's own, handled by the board
 * only and offered on no form but the board's own (decisions 2 and 13): the
 * handlers' group, which `listReportable` narrows to the handlers of the type,
 * so the property manager is not offered it. Störningar, the other
 * board-only type the plan names, is ring-fenced (decision 32): offered to
 * residents on their own form, with its warning, and never on the website's,
 * whose reporter could only be answered by mail.
 */
const SEEDED_TYPES = [
  {
    key: "waterLeak",
    reporters: ["PUBLIC", "RESIDENTS"],
    defaultPriority: "URGENT",
  },
  { key: "heatingAndVentilation", reporters: ["RESIDENTS"] },
  { key: "electricityAndLighting", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "lift", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "laundryRoom", reporters: ["RESIDENTS"] },
  { key: "doorsAndLocks", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "outdoorAreas", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "pests", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "other", reporters: ["PUBLIC", "RESIDENTS"] },
  { key: "insurance", reporters: ["HANDLERS"], handledBy: "BOARD" },
  {
    key: "disturbances",
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
    ringFenced: true,
  },
] as const satisfies readonly {
  key: string;
  reporters: readonly IssueReporterGroup[];
  defaultPriority?: IssuePriority;
  handledBy?: IssueHandledBy;
  /** Set only with `handledBy: "BOARD"` and without `PUBLIC`, as the CHECK holds. */
  ringFenced?: true;
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
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The types, active or not, with their statuses, narrowed by the caller.
   * Reached with issues:handle on the queue and through `issue_type_list` (ADR
   * 0040), each narrowed to the types the reader handles by `IssueService`,
   * which is where that rule is read (ADR 0054).
   *
   * The counts are of `issues` alone, the issues the reader handles: a type
   * open to every handler can hold issues kept to the board one by one, and
   * how many there are, and in which status, is something about them the
   * board-only rule keeps from whoever it shuts out.
   */
  async list(
    types: Prisma.IssueTypeWhereInput,
    issues: Prisma.IssueWhereInput,
  ): Promise<IssueTypeView[]> {
    const rows = await this.prisma.issueType.findMany({
      where: types,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: countedTypeInclude(issues),
    });

    return rows.map(toView);
  }

  /**
   * Every type with its settings, the default assignee included. Reached with
   * issues:configure on the board's screen.
   */
  async listConfigured(): Promise<ConfiguredIssueTypeView[]> {
    const types = await this.prisma.issueType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: TYPE_INCLUDE,
    });
    return this.configuredViews(types);
  }

  /**
   * Who a type's issues may be given to by default: every handler, each
   * marked with whether the board keeps them on a type handled by the board
   * only. Names and nothing else, read by the rule an assignment is held to.
   */
  async handlerChoices(): Promise<IssueHandlerChoice[]> {
    const now = new Date();
    const [everyHandler, board] = await Promise.all([
      readIssueHandlers(this.prisma, "EVERY_HANDLER", now),
      readIssueHandlers(this.prisma, "BOARD", now),
    ]);
    const boardIds = new Set(
      board.map((handler) =>
        handler.kind === "unknown" ? "" : handler.personId,
      ),
    );
    return everyHandler.map((handler) => ({
      handler,
      board: handler.kind !== "unknown" && boardIds.has(handler.personId),
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

    const [types, clocks] = await Promise.all([
      this.prisma.issueType.findMany({
        where: { active: true, ...(await this.reportableWhere(principal)) },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, reporters: true, ringFenced: true },
      }),
      issueTextClocks(this.prisma),
    ]);
    return types.map((type) => ({
      ...type,
      textRetentionYears: issueTextClockYears(clocks, type.ringFenced),
    }));
  }

  /**
   * The reporter groups' filter, with the handlers' group narrowed to the
   * types the principal handles.
   *
   * A handler is offered the types written for handlers because they handle
   * them. A type the board keeps to itself is not one the property manager
   * handles, so it is not offered to them as a handler either: its name is
   * the board's, and an issue they filed under it would be one they could
   * never see in the queue (ADR 0054). A type the board also offers residents
   * or the public is still offered to them on that ground: the board chose to.
   */
  private async reportableWhere(
    principal: Principal | null,
  ): Promise<Prisma.IssueTypeWhereInput> {
    const groups = reporterGroupsOf(principal);
    if (
      principal === null ||
      !groups.includes("HANDLERS") ||
      (await issueReaderScope(this.prisma, principal.personId, new Date())) ===
        "BOARD"
    ) {
      return { reporters: { hasSome: [...groups] } };
    }
    return {
      OR: [
        {
          reporters: {
            hasSome: groups.filter((group) => group !== "HANDLERS"),
          },
        },
        {
          reporters: { has: "HANDLERS" },
          ...typesHandledWhere("EVERY_HANDLER"),
        },
      ],
    };
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
   *
   * A default assignee is somebody who handles the type as configured; anybody
   * else is refused rather than kept, because an issue filed under the type
   * would otherwise land with nobody while the board believes it lands with
   * somebody.
   *
   * Audited with the board member who added it, in the same transaction: who
   * may report the type and who handles it decide who reads its issues. The
   * entry carries those settings as facts and never the type's name, nor who
   * its default assignee is (ADR 0019).
   */
  async create(
    input: IssueTypeInput,
    actorPersonId: string,
  ): Promise<ConfiguredIssueTypeView> {
    const t = await this.associationTranslator();
    const handledBy = input.handledBy ?? "EVERY_HANDLER";
    const defaultAssigneePersonId = input.defaultAssigneePersonId ?? null;
    await this.requireDefaultAssignee(
      this.prisma,
      defaultAssigneePersonId,
      handledBy,
    );
    const type = await this.prisma.$transaction(async (tx) => {
      const created = await tx.issueType.create({
        data: {
          name: input.name,
          reporters: uniqueGroups(input.reporters),
          active: input.active ?? true,
          sortOrder: input.sortOrder ?? 0,
          handledBy,
          defaultPriority: input.defaultPriority ?? "NORMAL",
          defaultAssigneePersonId,
          statuses: { create: defaultStatuses(t) },
        },
        include: TYPE_INCLUDE,
      });
      await this.audit.record(
        {
          action: "ISSUE_TYPE_CREATED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issueType",
          targetId: created.id,
          context: {
            reporters: uniqueGroups(created.reporters),
            handledBy: created.handledBy,
            defaultPriority: created.defaultPriority,
            active: created.active,
            defaultAssignee: created.defaultAssigneePersonId !== null,
          },
        },
        tx,
      );
      return created;
    });

    this.logger.log(`Added issue type ${type.id}`);
    return this.configuredView(type);
  }

  /**
   * Changes a type's settings.
   *
   * Handing a type to the board only shuts out the property manager, from the
   * type's issues and from being given them. Whoever the new setting shuts out
   * is unassigned from every issue of the type in the same transaction, each
   * with an entry naming the board member who changed the type, and a default
   * assignee it shuts out is cleared, so no issue is left with an assignee who
   * can no longer open it. A default the same request names is held to the
   * new setting and refused if it does not handle the type. Under the type's
   * lock, which an assignment takes too (`IssueService.assign`), so an
   * assignment cannot slip in between the check and the change.
   *
   * A change is audited with the board member who made it, in the same
   * transaction, as one entry naming the fields that changed (see
   * {@link typeChanges}). A request that changes nothing writes none.
   */
  async update(
    id: string,
    input: IssueTypeInput,
    actorPersonId: string,
  ): Promise<ConfiguredIssueTypeView> {
    await this.prisma
      .$transaction(
        async (tx) => {
          await lockIssueType(tx, id);
          const existing = await tx.issueType.findUnique({
            where: { id },
            select: {
              name: true,
              reporters: true,
              active: true,
              sortOrder: true,
              handledBy: true,
              defaultPriority: true,
              defaultAssigneePersonId: true,
              ringFenced: true,
            },
          });
          if (existing === null) {
            throw notFound();
          }
          const now = new Date();
          const handledBy = input.handledBy ?? existing.handledBy;
          if (existing.ringFenced) {
            refuseOutsideRingFence(handledBy, input.reporters);
          }
          let defaultAssigneePersonId =
            input.defaultAssigneePersonId === undefined
              ? existing.defaultAssigneePersonId
              : input.defaultAssigneePersonId;
          if (input.defaultAssigneePersonId === undefined) {
            // Kept from before: cleared, not refused, when the new setting shuts
            // its person out, because the board did not name them in this request.
            if (
              defaultAssigneePersonId !== null &&
              !(await handlesIssues(
                tx,
                defaultAssigneePersonId,
                handledBy,
                now,
              ))
            ) {
              defaultAssigneePersonId = null;
            }
          } else {
            await this.requireDefaultAssignee(
              tx,
              defaultAssigneePersonId,
              handledBy,
            );
          }

          if (handledBy === "BOARD" && existing.handledBy !== "BOARD") {
            await this.unassignOutsideBoard(tx, id, actorPersonId, now);
          }

          await tx.issueType.update({
            where: { id },
            data: {
              name: input.name,
              reporters: uniqueGroups(input.reporters),
              // Only the fields the caller actually sent. The defaults above
              // belong to create alone: an update that leaves out `active` must
              // not reopen a category the board deliberately closed, and one that
              // leaves out `sortOrder` must not move the type to the top of every
              // picker.
              ...(input.active === undefined ? {} : { active: input.active }),
              ...(input.sortOrder === undefined
                ? {}
                : { sortOrder: input.sortOrder }),
              handledBy,
              ...(input.defaultPriority === undefined
                ? {}
                : { defaultPriority: input.defaultPriority }),
              defaultAssigneePersonId,
            },
          });

          const changes = typeChanges(existing, {
            name: input.name,
            reporters: input.reporters,
            active: input.active ?? existing.active,
            sortOrder: input.sortOrder ?? existing.sortOrder,
            handledBy,
            defaultPriority: input.defaultPriority ?? existing.defaultPriority,
            defaultAssigneePersonId,
          });
          if (changes !== null) {
            await this.audit.record(
              {
                action: "ISSUE_TYPE_CHANGED",
                channel: "WEB",
                actorPersonId,
                targetKind: "issueType",
                targetId: id,
                context: changes,
              },
              tx,
            );
          }
        },
        /*
         * Handing a type to the board writes one audit entry per shut-out
         * issue, each its own round trip, and nothing caps how many issues a
         * type has. The default five-second budget would abort the whole change
         * with P2028 after the type lock was held for the duration, which tells
         * the board nothing it can act on. The budget is stated rather than the
         * loop removed, because the entries must commit with the unassignment.
         */
        { timeout: 30_000 },
      )
      .catch((cause: unknown) => {
        // Removed by somebody else after it was read: the update finds no row.
        throw failedWith(cause, "P2025") ? notFound() : cause;
      });

    this.logger.log(`Changed issue type ${id}`);
    const type = await this.prisma.issueType.findUnique({
      where: { id },
      include: TYPE_INCLUDE,
    });
    if (type === null) {
      throw notFound();
    }
    return this.configuredView(type);
  }

  /**
   * Unassigns, from every issue of a type now handled by the board only, an
   * assignee the board does not include: the property manager. An issue the
   * board had already closed to itself has no such assignee to unassign.
   */
  private async unassignOutsideBoard(
    tx: Prisma.TransactionClient,
    typeId: string,
    actorPersonId: string,
    now: Date,
  ): Promise<void> {
    const shutOut = await tx.issue.findMany({
      where: {
        typeId,
        assigneePersonId: { not: null },
        NOT: {
          assigneePersonId: {
            in: (
              await tx.person.findMany({
                where: issueHandlersWhere("BOARD", now),
                select: { id: true },
              })
            ).map((person) => person.id),
          },
        },
      },
      select: { id: true, assigneePersonId: true },
    });
    for (const issue of shutOut) {
      await this.audit.record(
        {
          action: "ISSUE_ASSIGNED",
          channel: "WEB",
          actorPersonId,
          targetPersonId: null,
          targetKind: "issue",
          targetId: issue.id,
          context: { previousAssigneePersonId: issue.assigneePersonId },
        },
        tx,
      );
    }
    if (shutOut.length > 0) {
      await tx.issue.updateMany({
        where: { id: { in: shutOut.map((issue) => issue.id) } },
        data: { assigneePersonId: null },
      });
    }
  }

  /** Refuses a default assignee who does not handle a type of this setting. */
  private async requireDefaultAssignee(
    db: PrismaService | Prisma.TransactionClient,
    personId: string | null,
    handledBy: IssueHandledBy,
  ): Promise<void> {
    if (
      personId !== null &&
      !(await handlesIssues(db, personId, handledBy, new Date()))
    ) {
      throw new IssueError(
        "That person does not handle issues of this type.",
        "assignee-not-a-handler",
      );
    }
  }

  /**
   * Removes a type nobody has reported under, and its statuses with it.
   *
   * A type that has been used is refused rather than cascaded away. The issues
   * filed under it say what they were about only through it, and a board
   * tidying its categories must not be able to make last winter's reports
   * unreadable. Deactivating is the answer, and the refusal says so.
   *
   * Audited with the board member who removed it, in the same transaction.
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
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
      await this.prisma.$transaction(async (tx) => {
        await tx.issueType.delete({ where: { id } });
        await this.audit.record(
          {
            action: "ISSUE_TYPE_REMOVED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issueType",
            targetId: id,
          },
          tx,
        );
      });
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
   * Ring-fences a type, or lifts its ring-fence (decision 32 of the issue
   * module's plan; ADR 0054, question 5): while it holds, the type's issues
   * are read by the board alone and nothing about them leaves it. Any type may
   * carry it, and the board sets it, under issues:configure, which the
   * property manager does not hold.
   *
   * Ring-fencing hands the type to the board, as `update` does when the board
   * keeps a type to itself: whoever that shuts out - the property manager - is
   * unassigned from its issues, each with an entry, and cleared as its default
   * assignee. A type the website's form offers is refused, because that
   * form's reporter is answered by mail alone and nothing about a ring-fenced
   * issue is mailed: the board takes the form off the type first.
   *
   * Lifting it is refused once an issue has been reported under the type.
   * Lifting would hand those reports to whoever the ring-fence keeps out, and
   * move them off the ring-fenced clock onto the other types' one. A type the
   * board ring-fenced by mistake is switched off and replaced instead.
   *
   * A route of its own rather than a field of the type's settings, so the one
   * setting that decides what may leave the association is changed only by a
   * request that names it, and is audited with the board member who changed
   * it, with the handling it moved from when the fence hands the type to the
   * board, and whether it cleared the default assignee. Under the type's lock, which filing takes and a sending takes too, and
   * so does the mail worker before it claims a work order
   * (`WorkOrderMailerService`): a report filed, or a work order being written
   * or about to be mailed, while the board ring-fences its type is decided
   * either before the change or after it. A work order written before and
   * still queued is refused at its claim and recorded as not sent. A request
   * that changes nothing writes nothing.
   *
   * Ring-fencing a type also revokes every contractor's link to a work order on
   * its issues, in the same transaction (ADR 0055, control B5 of its threat
   * review). The lookup refuses them anyway; the revocation writes the end onto
   * the row, so a ring-fence changed outside this service (which itself never
   * lifts one from a type with issues, `ring-fence-in-use`, ADR 0054, decision
   * 32) brings no link back.
   *
   * Not a recall: a work order claimed before the type was ring-fenced is on
   * its way, and may have left.
   */
  async setRingFence(
    id: string,
    ringFenced: boolean,
    actorPersonId: string,
  ): Promise<ConfiguredIssueTypeView> {
    await this.prisma.$transaction(
      async (tx) => {
        // Waits for a mail about the type's issues that is being handed over,
        // before the type's lock: a filing or a handler's write on the type
        // does not queue behind the mail server while this waits.
        await lockIssueTypeRingFence(tx, id);
        await lockIssueType(tx, id);
        const type = await tx.issueType.findUnique({
          where: { id },
          select: {
            ringFenced: true,
            handledBy: true,
            reporters: true,
            defaultAssigneePersonId: true,
            _count: { select: { issues: true } },
          },
        });
        if (type === null) {
          throw notFound();
        }
        if (type.ringFenced === ringFenced) {
          return;
        }
        if (!ringFenced && type._count.issues > 0) {
          throw new IssueError(
            "Issues have been reported under this type, so it stays ring-fenced. Deactivate it instead.",
            "ring-fence-in-use",
          );
        }
        if (ringFenced) {
          refuseOutsideRingFence("BOARD", type.reporters);
        }
        const now = new Date();
        if (ringFenced && type.handledBy !== "BOARD") {
          await this.unassignOutsideBoard(tx, id, actorPersonId, now);
        }
        const keepsDefault =
          !ringFenced ||
          type.defaultAssigneePersonId === null ||
          (await handlesIssues(tx, type.defaultAssigneePersonId, "BOARD", now));
        await tx.issueType.update({
          where: { id },
          data: {
            ringFenced,
            ...(ringFenced ? { handledBy: "BOARD" } : {}),
            ...(keepsDefault ? {} : { defaultAssigneePersonId: null }),
          },
        });
        if (ringFenced) {
          // Nothing about the type's issues reaches a contractor from now on:
          // every link to one of their work orders ends in this transaction,
          // as a fact on the row (ADR 0055).
          await revokeWorkOrderLinks(tx, { issue: { typeId: id } });
        }
        await this.audit.record(
          {
            action: "ISSUE_TYPE_RING_FENCE_CHANGED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issueType",
            targetId: id,
            context: {
              ringFenced,
              // What ring-fencing changed besides the fence: handing the type
              // to the board narrows who may read its history, and clearing
              // the default assignee changes who is given its new issues. As
              // in {@link typeChanges}, the assignee is only named, never
              // identified (ADR 0019).
              ...(ringFenced && type.handledBy !== "BOARD"
                ? { handledBy: either(type.handledBy, "BOARD") }
                : {}),
              ...(keepsDefault ? {} : { defaultAssignee: true }),
            },
          },
          tx,
        );
        // The budget `update` states, for its reason: one entry per issue the
        // property manager is unassigned from, after as long as a mail's
        // handoff may hold the ring-fence.
      },
      { timeout: MAIL_TRANSACTION_MS + 30_000 },
    );
    this.logger.log(`Set the ring-fence of issue type ${id}`);
    return this.view(id);
  }

  /**
   * Adds a status to a type, last within its meaning.
   *
   * The meaning is chosen here and never changes: a status that moved from one
   * meaning to another would silently reopen or close every issue standing in
   * it. Under the type's lock, so two additions cannot both pass the bound.
   *
   * Audited with the board member who added it, in the same transaction: the
   * status and its meaning, never its label.
   */
  async addStatus(
    typeId: string,
    input: IssueStatusInput,
    actorPersonId: string,
  ): Promise<ConfiguredIssueTypeView> {
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

      const added = await tx.issueStatus.create({
        data: {
          typeId,
          meaning: input.meaning,
          label: input.label,
          sortOrder:
            last < ISSUE_STATUS_LIMITS.sortOrder
              ? last + 1
              : await this.renumberMeaning(tx, typeId, input.meaning),
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: "ISSUE_STATUS_CONFIGURED",
          channel: "WEB",
          actorPersonId,
          targetKind: "issueType",
          targetId: typeId,
          context: { statusId: added.id, meaning: input.meaning, added: true },
        },
        tx,
      );
    });

    this.logger.log(`Added a ${input.meaning} status to issue type ${typeId}`);
    return this.view(typeId);
  }

  /**
   * Numbers a meaning's statuses 0, 1, 2 and on, in the order they have, and
   * answers with the place after the last.
   *
   * For a status added behind one the board put at the highest place a status
   * can have. A queue cursor carries the place in the digits that bound
   * allows, so a status past it would end the queue's pagination on the first
   * page that ends in it; and a status sharing the highest place would mix its
   * issues with the other's in the queue. A type has far fewer statuses than
   * places, so after renumbering the next place is always free.
   */
  private async renumberMeaning(
    tx: Prisma.TransactionClient,
    typeId: string,
    meaning: IssueStatusMeaning,
  ): Promise<number> {
    const ordered = await tx.issueStatus.findMany({
      where: { typeId, meaning },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    for (const [sortOrder, status] of ordered.entries()) {
      await tx.issueStatus.update({
        where: { id: status.id },
        data: { sortOrder },
      });
    }
    return ordered.length;
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
   *
   * A change is audited with the board member who made it, in the same
   * transaction: the status, its meaning and the fields that changed, with
   * whether it is switched on and whether it is the default either side, and
   * never its label. A request that changes nothing writes no entry.
   */
  async updateStatus(
    typeId: string,
    statusId: string,
    change: IssueStatusChange,
    actorPersonId: string,
  ): Promise<ConfiguredIssueTypeView> {
    await this.prisma.$transaction(async (tx) => {
      await this.requireLockedType(tx, typeId);

      const status = await tx.issueStatus.findFirst({
        where: { id: statusId, typeId },
        select: {
          id: true,
          meaning: true,
          label: true,
          isDefault: true,
          active: true,
          sortOrder: true,
        },
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

      const changed = [
        ...(change.label === status.label ? [] : ["label"]),
        ...(active === status.active ? [] : ["active"]),
        ...(becomesDefault ? ["isDefault"] : []),
        ...(change.sortOrder === undefined ||
        change.sortOrder === status.sortOrder
          ? []
          : ["sortOrder"]),
      ];
      if (changed.length > 0) {
        await this.audit.record(
          {
            action: "ISSUE_STATUS_CONFIGURED",
            channel: "WEB",
            actorPersonId,
            targetKind: "issueType",
            targetId: typeId,
            context: {
              statusId,
              meaning: status.meaning,
              added: false,
              changed,
              ...(active === status.active
                ? {}
                : { active: { before: status.active, after: active } }),
              ...(becomesDefault
                ? { isDefault: { before: false, after: true } }
                : {}),
            },
          },
          tx,
        );
      }
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
            ...("handledBy" in seeded ? { handledBy: seeded.handledBy } : {}),
            ...("ringFenced" in seeded
              ? { ringFenced: seeded.ringFenced }
              : {}),
            ...("defaultPriority" in seeded
              ? { defaultPriority: seeded.defaultPriority }
              : {}),
            statuses: { create: defaultStatuses(t) },
          },
        });
      }
      this.logger.log(`Wrote the ${SEEDED_TYPES.length} starting issue types`);
      return { created: SEEDED_TYPES.length };
    });
  }

  /** Types with their default assignees, read in one query. */
  private async configuredViews(
    types: readonly TypeRecord[],
  ): Promise<ConfiguredIssueTypeView[]> {
    const viewOf = await readAuthors(
      this.prisma,
      types.map((type) => type.defaultAssigneePersonId),
    );
    return types.map((type) => ({
      ...toView(type),
      defaultAssignee:
        type.defaultAssigneePersonId === null
          ? null
          : viewOf(type.defaultAssigneePersonId),
    }));
  }

  private async configuredView(
    type: TypeRecord,
  ): Promise<ConfiguredIssueTypeView> {
    const [view] = await this.configuredViews([type]);
    if (view === undefined) {
      throw notFound();
    }
    return view;
  }

  /** One type as the board's screen shows it, after a write to it. */
  private async view(typeId: string): Promise<ConfiguredIssueTypeView> {
    const type = await this.prisma.issueType.findUnique({
      where: { id: typeId },
      include: TYPE_INCLUDE,
    });
    if (type === null) {
      throw notFound();
    }
    return this.configuredView(type);
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

/**
 * Refuses a setting a ring-fenced type may not have (decision 32): handled by
 * anybody but the board, or offered on the website's form, whose reporter is
 * answered by mail alone when nothing about a ring-fenced issue is mailed. The
 * database holds both by a CHECK as well; this says which, in words the board's
 * screen can show.
 */
function refuseOutsideRingFence(
  handledBy: IssueHandledBy,
  reporters: readonly IssueReporterGroup[],
): void {
  if (handledBy !== "BOARD") {
    throw new IssueError(
      "A ring-fenced issue type is handled by the board only.",
      "ring-fenced-board-only",
    );
  }
  if (reporters.includes("PUBLIC")) {
    throw new IssueError(
      "A ring-fenced issue type is not offered on the website's form.",
      "ring-fenced-public",
    );
  }
}

/** A type's settings as `update` compares them. */
interface TypeSettings {
  name: string;
  reporters: readonly IssueReporterGroup[];
  active: boolean;
  sortOrder: number;
  handledBy: IssueHandledBy;
  defaultPriority: IssuePriority;
  defaultAssigneePersonId: string | null;
}

/**
 * The context of the audit entry for a change to a type, or null when nothing
 * changed.
 *
 * `changed` names every field that changed. Who may report the type, who
 * handles it, its default priority and whether it is switched on are facts and
 * carried with the value either side. The name is the board's own text and its
 * place in the list says nothing, so each is only named. The default assignee
 * is a person, and an identifier here would need the person purge to reach it
 * (ADR 0019), so it too is only named as changed.
 */
function typeChanges(
  before: TypeSettings,
  after: TypeSettings,
): Record<string, unknown> | null {
  const reporters = {
    before: uniqueGroups(before.reporters),
    after: uniqueGroups(after.reporters),
  };
  const facts = {
    reporters:
      reporters.before.join() === reporters.after.join() ? null : reporters,
    handledBy: either(before.handledBy, after.handledBy),
    defaultPriority: either(before.defaultPriority, after.defaultPriority),
    active: either(before.active, after.active),
  };
  const changed = [
    ...(before.name === after.name ? [] : ["name"]),
    ...Object.entries(facts)
      .filter(([, value]) => value !== null)
      .map(([field]) => field),
    ...(before.sortOrder === after.sortOrder ? [] : ["sortOrder"]),
    ...(before.defaultAssigneePersonId === after.defaultAssigneePersonId
      ? []
      : ["defaultAssignee"]),
  ];
  if (changed.length === 0) {
    return null;
  }
  return {
    changed,
    ...Object.fromEntries(
      Object.entries(facts).filter(([, value]) => value !== null),
    ),
  };
}

/** A value either side of a change, or null when it did not change. */
function either<T extends string | boolean>(
  before: T,
  after: T,
): { before: T; after: T } | null {
  return before === after ? null : { before, after };
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

/** {@link TYPE_INCLUDE}, its counts narrowed to these issues. */
function countedTypeInclude(issues: Prisma.IssueWhereInput) {
  return {
    _count: { select: { issues: { where: issues } } },
    statuses: {
      ...TYPE_INCLUDE.statuses,
      include: { _count: { select: { issues: { where: issues } } } },
    },
  } satisfies Prisma.IssueTypeInclude;
}

type TypeRecord = Prisma.IssueTypeGetPayload<{ include: typeof TYPE_INCLUDE }>;

function toView(type: TypeRecord): IssueTypeView {
  return {
    id: type.id,
    name: type.name,
    reporters: uniqueGroups(type.reporters),
    active: type.active,
    sortOrder: type.sortOrder,
    handledBy: type.handledBy,
    defaultPriority: type.defaultPriority,
    ringFenced: type.ringFenced,
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
