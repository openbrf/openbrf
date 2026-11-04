import {
  ISSUE_STATUS_MEANINGS,
  type IssueHandledBy,
  type IssuePriority,
  type IssueReporterGroup,
  type IssueStatusMeaning,
} from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";

/** An issue type a suite writes directly, with the ids of its statuses. */
export interface IssueTypeFixture {
  id: string;
  /** The default status of each meaning, by meaning. */
  statusIds: Record<IssueStatusMeaning, string>;
}

/**
 * Writes an issue type with its default set of statuses, one of each meaning,
 * as the type service writes one, and answers with their ids.
 *
 * For suites that arrange rows directly rather than through the board's route.
 * The status ids are derived from the type's, so a suite that names its type
 * per run names its statuses per run as well.
 */
export async function createIssueTypeFixture(
  db: Prisma.TransactionClient,
  input: {
    id: string;
    name: string;
    reporters: readonly IssueReporterGroup[];
    active?: boolean;
    sortOrder?: number;
    handledBy?: IssueHandledBy;
    defaultPriority?: IssuePriority;
    defaultAssigneePersonId?: string | null;
    /** Written as it stands, so a fenced type is also handled by the board. */
    ringFenced?: boolean;
  },
): Promise<IssueTypeFixture> {
  const statusIds = Object.fromEntries(
    ISSUE_STATUS_MEANINGS.map((meaning) => [
      meaning,
      `${input.id}-${meaning.toLowerCase()}`,
    ]),
  ) as Record<IssueStatusMeaning, string>;

  await db.issueType.create({
    data: {
      id: input.id,
      name: input.name,
      reporters: [...input.reporters],
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
      handledBy: input.handledBy ?? "EVERY_HANDLER",
      defaultPriority: input.defaultPriority ?? "NORMAL",
      defaultAssigneePersonId: input.defaultAssigneePersonId ?? null,
      ringFenced: input.ringFenced ?? false,
      statuses: {
        create: ISSUE_STATUS_MEANINGS.map((meaning) => ({
          id: statusIds[meaning],
          meaning,
          label: STATUS_LABELS[meaning],
          isDefault: true,
        })),
      },
    },
  });

  return { id: input.id, statusIds };
}

/** The Swedish defaults, as a new instance names them. */
const STATUS_LABELS: Readonly<Record<IssueStatusMeaning, string>> = {
  NEW: "Ny",
  IN_PROGRESS: "Pågår",
  WAITING: "Väntar",
  DONE: "Klar",
};
