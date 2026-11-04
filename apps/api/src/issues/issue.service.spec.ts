import { dateColumnOf, localDayOf, parseLocalDay } from "@openbrf/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { MediaService } from "../media/media.service";
import type { IssueReporterLinkService } from "./issue-reporter-link.service";
import type { IssueTypeService } from "./issue-type.service";
import { IssueService } from "./issue.service";
import type { IssueMailer } from "./issue-mailer.service";

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
 *
 * The last block reads the board's screen across the association's midnight,
 * which the integration suite cannot do on purpose either: the clock turns
 * between the transaction and the conversion of its rows.
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
    mergedIntoIssueId: null,
    mergedInto: null,
    knownFault: null,
    knownFaultSignature: null,
    knownFaultPublishedAt: null,
    location: null,
    description: `Description of ${id}`,
    descriptionRedactedAt: null,
    locationRedactedAt: null,
    freeTextRemovedAt: null,
    legalHoldAt: null,
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
    {} as IssueReporterLinkService,
    {} as IssueMailer,
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
          descriptionRedactedAt: null,
          locationRedactedAt: null,
          freeTextRemovedAt: null,
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
          knownFault: null,
          legalHoldAt: null,
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

/**
 * The queue read across midnight: the day is taken inside the transaction, and
 * the clock turns before the rows become views. A row's `overdue` must then
 * agree with the day the list and the counts were read by, not with the day it
 * is serialised on.
 */
describe("the queue read as the association's day turns", () => {
  // Winter time, so the offset to UTC is a plain hour: 23:59:59 on the 10th
  // is 22:59:59 UTC, and one second on 00:00:01 on the 11th.
  const BEFORE_MIDNIGHT = new Date("2026-03-10T22:59:59.000Z");
  const AFTER_MIDNIGHT = new Date("2026-03-10T23:00:01.000Z");
  const DUE_TODAY = dayOf("2026-03-10");
  const DUE_YESTERDAY = dayOf("2026-03-09");

  function dayOf(text: string) {
    const day = parseLocalDay(text);
    if (day === null) {
      throw new Error(`The fixture's day ${text} does not parse.`);
    }
    return day;
  }

  /** The `lt` bound of the target date a where carries, if it carries one. */
  function targetDateBefore(where: unknown): Date | undefined {
    if (Array.isArray(where)) {
      return where.map(targetDateBefore).find((bound) => bound !== undefined);
    }
    if (typeof where !== "object" || where === null) {
      return undefined;
    }
    const { targetDate, AND } = where as {
      targetDate?: { lt?: Date };
      AND?: unknown;
    };
    return targetDate?.lt ?? targetDateBefore(AND);
  }

  /**
   * A database holding one issue due on the day the clock reads as the
   * transaction starts and one due the day before, both new and unassigned. It
   * answers the target-date bound a view is read or counted by, so what the
   * list and the counts say depends on the day they were given. The clock is
   * turned past midnight when the transaction ends: the rows have then been
   * read and the conversion to views has not begun.
   */
  function build() {
    const rows = [
      {
        ...issueRow("due-today", "2026-03-01T08:00:00.000Z", RESIDENT),
        targetDate: dateColumnOf(DUE_TODAY),
      },
      {
        ...issueRow("due-yesterday", "2026-03-02T08:00:00.000Z", RESIDENT),
        targetDate: dateColumnOf(DUE_YESTERDAY),
      },
    ];
    const heldBy = (where: unknown) => {
      const before = targetDateBefore(where);
      return rows.filter(
        (row) => before === undefined || row.targetDate < before,
      );
    };
    const client = {
      issue: {
        findMany: vi.fn(async (args: { where: unknown }) =>
          // Only the NEW meaning holds anything.
          JSON.stringify(args.where).includes('"meaning":"NEW"')
            ? heldBy(args.where)
            : [],
        ),
        count: vi.fn(async (args: { where: unknown }) =>
          JSON.stringify(args.where).includes('"NEW"')
            ? heldBy(args.where).length
            : 0,
        ),
      },
      person: {
        findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
          PERSONS.filter((person) => args.where.id?.in.includes(person.id)).map(
            (person) => ({
              ...person,
              protectedPersonalData: false,
            }),
          ),
        ),
        findFirst: vi.fn(async () => ({ id: "person-board" })),
      },
    };
    const prisma = {
      ...client,
      $transaction: async (work: (tx: typeof client) => Promise<unknown>) => {
        const result = await work(client);
        vi.setSystemTime(AFTER_MIDNIGHT);
        return result;
      },
    } as unknown as PrismaService;
    const service = new IssueService(
      prisma,
      {} as IssueTypeService,
      {} as MediaService,
      {} as FieldEncryptionService,
      {} as AuditLogService,
      {} as IssueReporterLinkService,
      {} as IssueMailer,
    );
    return { service };
  }

  /** Reads the queue from the last second of the 10th, whatever came before. */
  async function fromTheEve<T>(read: () => Promise<T>): Promise<T> {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    return read();
  }

  const overdueIds = (views: readonly { id: string; overdue: boolean }[]) =>
    views.filter((view) => view.overdue).map((view) => view.id);

  beforeEach(() => {
    // Date alone, and put back below: no other test reads a fixed clock.
    vi.useFakeTimers({ toFake: ["Date"], now: BEFORE_MIDNIGHT });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags in the snapshot the issues its list and counts call overdue", async () => {
    const { service } = build();

    const snapshot = await fromTheEve(() =>
      service.readQueueSnapshot("person-board", "ALL"),
    );
    const overdueView = await fromTheEve(() =>
      service.readQueueSnapshot("person-board", "OVERDUE"),
    );

    // The clock did turn: serialised on the new day, today's issue would pass.
    expect(localDayOf(new Date())).toEqual(dayOf("2026-03-11"));
    // The issue due on the day the queue was read is not overdue on it.
    expect(overdueIds(snapshot.issues)).toEqual(["due-yesterday"]);
    // The fake tells views apart by the target date and the meaning only, so
    // these are the two counts it can answer for.
    expect(snapshot.counts).toMatchObject({ overdue: 1, all: 2 });
    expect(overdueView.issues.map((issue) => issue.id)).toEqual([
      "due-yesterday",
    ]);
    expect(overdueIds(snapshot.issues)).toHaveLength(snapshot.counts.overdue);
    expect(overdueView.issues.every((issue) => issue.overdue)).toBe(true);
  });

  it("flags in the list the issues its view calls overdue", async () => {
    const { service } = build();

    const all = await fromTheEve(() =>
      service.listQueue("person-board", "ALL"),
    );
    const overdueView = await fromTheEve(() =>
      service.listQueue("person-board", "OVERDUE"),
    );

    expect(localDayOf(new Date())).toEqual(dayOf("2026-03-11"));
    expect(all.map((issue) => issue.id)).toEqual([
      "due-today",
      "due-yesterday",
    ]);
    expect(overdueIds(all)).toEqual(["due-yesterday"]);
    expect(overdueView.map((issue) => issue.id)).toEqual(["due-yesterday"]);
  });
});
