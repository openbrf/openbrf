import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { MediaService } from "../media/media.service";
import type { IssueTypeService } from "./issue-type.service";
import { IssueService } from "./issue.service";

/**
 * A page of the triage queue over a fake database, for the one interleaving
 * the integration suite cannot order on purpose: a reporter whose personal
 * data becomes protected after the page's query has left that person's issues
 * in, and before the page's reporters are read.
 *
 * The rows come back in the order the fake is told to give them, so the test
 * says exactly which read sees which state. The queue is read one meaning at a
 * time, NEW first, so the fake's first answer is the NEW meaning's, and a
 * meaning it has nothing more for answers empty.
 */

const PROTECTED_REPORTER = "person-protected";
const RESIDENT = "person-resident";

function issueRow(id: string, filed: string, reporterPersonId: string) {
  const createdAt = new Date(filed);
  return {
    id,
    status: {
      id: "status-new",
      label: "Ny",
      meaning: "NEW" as const,
      sortOrder: 0,
    },
    waitingReason: null,
    outcome: null,
    location: null,
    description: `Description of ${id}`,
    closedAt: null,
    createdAt,
    updatedAt: createdAt,
    type: {
      id: "type-1",
      name: "Laundry",
      reporters: ["HANDLERS" as const],
      handledBy: "EVERY_HANDLER" as const,
    },
    apartment: null,
    photos: [],
    priority: "NORMAL" as const,
    targetDate: null,
    boardOnly: false,
    assigneePersonId: null,
    enteredByPersonId: null,
    enteredByHandler: false,
    reporterPersonId,
    reporterNameCipher: null,
    reporterEmailCipher: null,
  };
}

const PROTECTED_ISSUE = issueRow(
  "protected-issue-id",
  "2026-03-01T08:00:00.000Z",
  PROTECTED_REPORTER,
);
const ORDINARY_ISSUE = issueRow(
  "ordinary-issue-id",
  "2026-03-02T08:00:00.000Z",
  RESIDENT,
);
const LATER_ISSUE = issueRow(
  "later-issue-id",
  "2026-03-03T08:00:00.000Z",
  RESIDENT,
);

const PERSONS = [
  { id: PROTECTED_REPORTER, firstName: "Ada", lastName: "Skyddad" },
  { id: RESIDENT, firstName: "Bo", lastName: "Boende" },
];

/**
 * The queue answers `issueReads` in turn. The protected flag is off until the
 * persons are read for the `protectedFrom`th time: by default the first read is
 * the query's exclusion and the second the page's reporters.
 */
function build(issueReads: (typeof PROTECTED_ISSUE)[][], protectedFrom = 2) {
  let personReads = 0;
  const issueFindMany = vi.fn();
  for (const rows of issueReads) {
    issueFindMany.mockResolvedValueOnce(rows);
  }
  issueFindMany.mockResolvedValue([]);

  const personFindMany = vi.fn(
    async (args: {
      where: { protectedPersonalData?: true; id?: { in: string[] } };
    }) => {
      personReads += 1;
      const persons = PERSONS.map((person) => ({
        ...person,
        protectedPersonalData:
          personReads >= protectedFrom && person.id === PROTECTED_REPORTER,
      }));
      if (args.where.protectedPersonalData === true) {
        return persons
          .filter((person) => person.protectedPersonalData)
          .map(({ id }) => ({ id }));
      }
      const ids = args.where.id?.in ?? [];
      return persons.filter((person) => ids.includes(person.id));
    },
  );

  const client = {
    issue: { findMany: issueFindMany },
    // The reader is a board member, whom every issue lets in: what the board
    // only rule leaves out is shown against a real database in
    // `issues.int-spec.ts`.
    person: {
      findMany: personFindMany,
      findFirst: vi.fn(async () => ({ id: "person-board" })),
    },
  };
  // The meanings of one read share a transaction; the fake runs it on itself.
  const prisma = {
    ...client,
    $transaction: async (work: (tx: typeof client) => Promise<unknown>) =>
      work(client),
  } as unknown as PrismaService;

  const service = new IssueService(
    prisma,
    {} as IssueTypeService,
    {} as MediaService,
    {} as FieldEncryptionService,
    {} as AuditLogService,
  );
  return { service, issueFindMany };
}

describe("a page of the queue read while a reporter's data becomes protected", () => {
  it("names neither the protected issue nor its place in the queue, and reads on to the next issue", async () => {
    const { service, issueFindMany } = build([
      [PROTECTED_ISSUE, ORDINARY_ISSUE],
    ]);

    const page = await service.pageOfQueue(
      "person-board",
      { limit: 1 },
      "omit",
    );

    expect(page.issues.map((issue) => issue.id)).toEqual([ORDINARY_ISSUE.id]);
    expect(page.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toContain(PROTECTED_ISSUE.id);
    expect(JSON.stringify(page)).not.toContain(
      PROTECTED_ISSUE.createdAt.toISOString(),
    );

    // The second read starts after the last row read, so it does not read the
    // protected issue again, and asks for the one row the page still lacks -
    // in the NEW meaning from just after that row, and then in each meaning
    // behind it, which is how it learns the queue ends there.
    expect(issueFindMany).toHaveBeenCalledTimes(5);
    expect(issueFindMany.mock.calls[1]?.[0]).toMatchObject({ take: 1 });
    expect(JSON.stringify(issueFindMany.mock.calls[1]?.[0].where)).toContain(
      ORDINARY_ISSUE.id,
    );
    expect(
      issueFindMany.mock.calls
        .slice(1)
        .map(
          (call) =>
            JSON.stringify(call[0].where).match(/"meaning":"(\w+)"/)?.[1],
        ),
    ).toEqual(["NEW", "IN_PROGRESS", "WAITING", "DONE"]);
  });

  it("hands back a cursor at the last issue kept when the queue goes on", async () => {
    const { service } = build([
      [PROTECTED_ISSUE, ORDINARY_ISSUE],
      [LATER_ISSUE],
    ]);

    const page = await service.pageOfQueue(
      "person-board",
      { limit: 1 },
      "omit",
    );

    expect(JSON.parse(JSON.stringify(page))).toEqual({
      issues: [
        {
          id: ORDINARY_ISSUE.id,
          meaning: "NEW",
          status: { id: "status-new", label: "Ny" },
          waitingReason: null,
          outcome: null,
          typeId: "type-1",
          typeName: "Laundry",
          location: null,
          description: "Description of ordinary-issue-id",
          apartment: null,
          photos: [],
          enteredByHandler: false,
          createdAt: "2026-03-02T08:00:00.000Z",
          updatedAt: "2026-03-02T08:00:00.000Z",
          typeReporters: ["HANDLERS"],
          typeHandledBy: "EVERY_HANDLER",
          reporter: { kind: "resident", personId: RESIDENT, name: "Bo Boende" },
          closedAt: null,
          priority: "NORMAL",
          targetDate: null,
          overdue: false,
          assignee: null,
          enteredBy: null,
          boardOnly: false,
        },
      ],
      nextCursor: "NEW.0|2026-03-02T08:00:00.000Z|ordinary-issue-id",
    });
  });

  it("reads past a whole page of newly protected issues", async () => {
    const { service } = build([
      [PROTECTED_ISSUE, { ...PROTECTED_ISSUE, id: "protected-issue-2" }],
      [ORDINARY_ISSUE, LATER_ISSUE],
    ]);

    const page = await service.pageOfQueue(
      "person-board",
      { limit: 1 },
      "omit",
    );

    expect(page.issues.map((issue) => issue.id)).toEqual([ORDINARY_ISSUE.id]);
    expect(page.nextCursor).toBe(
      "NEW.0|2026-03-02T08:00:00.000Z|ordinary-issue-id",
    );
    expect(JSON.stringify(page)).not.toContain("protected-issue");
  });

  it("shows the protected issue to the board's own screen", async () => {
    const { service, issueFindMany } = build(
      [[PROTECTED_ISSUE, ORDINARY_ISSUE]],
      1,
    );

    const page = await service.pageOfQueue(
      "person-board",
      { limit: 1 },
      "show",
    );

    expect(page.issues.map((issue) => issue.id)).toEqual([PROTECTED_ISSUE.id]);
    expect(page.issues[0]?.reporter).toEqual({ kind: "protected" });
    expect(page.nextCursor).toBe(
      "NEW.0|2026-03-01T08:00:00.000Z|protected-issue-id",
    );
    expect(issueFindMany).toHaveBeenCalledTimes(1);
  });
});
