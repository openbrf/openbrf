import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { ImportError } from "./import-errors";
import type { ImportPlan, PlannedRow } from "./import-plan";
import type {
  ImportPlannerService,
  ImportPlanRequest,
} from "./import-planner.service";
import {
  IMPORT_PREVIEW_QUEUE,
  ImportPreviewService,
  PREVIEW_PROGRESS_ROWS,
  PREVIEW_UNWATCHED_MS,
} from "./import-preview.service";

/**
 * The preview job against a session held in memory.
 *
 * The integration suite drives it through the queue against a real database;
 * this drives the decisions that suite can only reach by timing - a preview
 * replaced or abandoned halfway through its rows - by changing the session
 * from inside the plan, at exactly the row a case names.
 */

interface FakeSession {
  id: string;
  columns: string[];
  rowsCipher: string;
  rowCount: number;
  mapping: string[];
  defaultRole: "MEMBER" | "RESIDENT" | null;
  defaultMovedInOn: string | null;
  status: string;
  previewId: string | null;
  previewStatus: "PLANNING" | "READY" | "FAILED" | null;
  previewRowsDone: number;
  previewFailureReason: string | null;
  previewWatchedAt: Date | null;
  previewCipher: string | null;
  previewToken: string | null;
  ambiguousRows: unknown;
  previewedAt: Date | null;
  expiresAt: Date;
}

const ROWS = 120;

function session(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    id: "session-1",
    columns: ["Namn", "Lgh"],
    rowsCipher: "rows",
    rowCount: ROWS,
    mapping: ["fullName", "apartmentNumber"],
    defaultRole: "MEMBER",
    defaultMovedInOn: "2020-01-01",
    status: "MAPPING",
    previewId: "preview-1",
    previewStatus: "PLANNING",
    previewRowsDone: 0,
    previewFailureReason: null,
    previewWatchedAt: new Date(),
    previewCipher: null,
    previewToken: null,
    ambiguousRows: null,
    previewedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

/** Whether a stored session satisfies the part of a where clause used here. */
function matches(row: FakeSession, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof FakeSession];
    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const { gte, gt } = condition as { gte?: Date; gt?: Date };
      if (!(value instanceof Date)) {
        return false;
      }
      return (
        (gte === undefined || value.getTime() >= gte.getTime()) &&
        (gt === undefined || value.getTime() > gt.getTime())
      );
    }
    return value === condition;
  });
}

function planned(
  rowNumber: number,
  outcome: PlannedRow["outcome"],
): PlannedRow {
  return {
    rowNumber,
    outcome,
    person: {
      firstName: "Anna",
      lastName: "Exempel",
      email: "anna@exempel.se",
      phone: null,
      personalIdentityNumber: "19800101-0000",
      postalStreet: null,
      postalCode: null,
      postalCity: null,
    },
    apartment: null,
    role: "MEMBER",
    movedInOn: "2020-01-01",
    movedInStated: true,
    movedOutOn: null,
    matchedPersonId: null,
    matchedPersonName: null,
    matchedBy: null,
    foundUnder: outcome === "ambiguous" ? "apartmentAndName" : null,
    mismatch: null,
    sameAsRowNumber: null,
    candidates:
      outcome === "ambiguous"
        ? [
            { personId: "twin-a", name: "Anna Exempel" },
            { personId: "twin-b", name: "Anna Exempel" },
          ]
        : [],
    problems: [],
  };
}

/**
 * A preview service whose planner prepares {@link ROWS} rows, and runs
 * `duringRow` before reporting each one.
 */
function harness(
  stored: FakeSession,
  options: {
    duringRow?: (rowsPrepared: number, row: FakeSession) => void;
    planFails?: unknown;
  } = {},
) {
  const sessions = new Map([[stored.id, stored]]);
  const updateMany = vi.fn(
    ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<FakeSession>;
    }) => {
      const row = sessions.get(where.id as string);
      if (row === undefined || !matches(row, where)) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, data);
      return Promise.resolve({ count: 1 });
    },
  );
  const prisma = {
    importSession: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(sessions.get(where.id) ?? null),
      ),
      findMany: vi.fn(() =>
        Promise.resolve(
          [...sessions.values()].filter(
            (row) =>
              row.status === "MAPPING" && row.previewStatus === "PLANNING",
          ),
        ),
      ),
      updateMany,
    },
  } as unknown as PrismaService;

  const plan = vi.fn(
    async (request: ImportPlanRequest): Promise<ImportPlan> => {
      if (options.planFails !== undefined) {
        throw options.planFails;
      }
      const rows: PlannedRow[] = [];
      for (let index = 0; index < request.rows.length; index++) {
        rows.push(planned(index + 1, index === 0 ? "ambiguous" : "create"));
        options.duringRow?.(rows.length, stored);
        await request.onRowPrepared?.(rows.length);
      }
      return {
        rows,
        summary: { create: rows.length - 1, update: 0, ambiguous: 1, error: 0 },
      };
    },
  );
  const decryptRows = vi.fn(() =>
    Promise.resolve(Array.from({ length: ROWS }, () => ["Anna", "1101"])),
  );
  const planner = { decryptRows, plan } as unknown as ImportPlannerService;

  const encryption = {
    encrypt: vi.fn((_id: string, plaintext: string) =>
      Promise.resolve({ cipher: `sealed:${plaintext}`, index: null }),
    ),
    decrypt: vi.fn((_id: string, cipher: string) =>
      Promise.resolve(cipher.slice("sealed:".length)),
    ),
  } as unknown as FieldEncryptionService;

  const send = vi.fn().mockResolvedValue("job");
  const service = new ImportPreviewService(
    { NODE_ENV: "test" } as Env,
    prisma,
    encryption,
    planner,
    { send } as unknown as JobQueueService,
  );

  /** The progress the job reported, in the order it reported it. */
  const reported = (): number[] =>
    updateMany.mock.calls.flatMap(([call]) =>
      call.data.previewStatus === undefined &&
      typeof call.data.previewRowsDone === "number"
        ? [call.data.previewRowsDone]
        : [],
    );

  return { service, plan, decryptRows, send, reported };
}

describe("planning a preview", () => {
  it("records the plan, the rows needing a decision and a token", async () => {
    const stored = session();
    const { service, reported } = harness(stored);

    await service.runPreview("session-1", "preview-1");

    expect(stored).toMatchObject({
      previewStatus: "READY",
      previewRowsDone: ROWS,
      previewFailureReason: null,
      ambiguousRows: { "1": ["twin-a", "twin-b"] },
    });
    expect(stored.previewToken).toEqual(expect.any(String));
    expect(stored.previewedAt).toBeInstanceOf(Date);
    expect(reported()).toEqual([
      PREVIEW_PROGRESS_ROWS,
      2 * PREVIEW_PROGRESS_ROWS,
    ]);
  });

  it("stores the preview encrypted, with no identity number in it", async () => {
    const stored = session();
    const { service } = harness(stored);

    await service.runPreview("session-1", "preview-1");

    expect(stored.previewCipher).toMatch(/^sealed:/);
    expect(stored.previewCipher).not.toContain("19800101");
    const view = await service.view("session-1", stored);
    expect(view.preview?.rows[0]?.person).toMatchObject({
      hasPersonalIdentityNumber: true,
    });
    expect(view.preview?.previewToken).toBe(stored.previewToken);
  });

  it("does nothing for a preview the session no longer wants", async () => {
    const stored = session({ previewId: "preview-2" });
    const { service, plan } = harness(stored);

    await service.runPreview("session-1", "preview-1");

    expect(plan).not.toHaveBeenCalled();
    expect(stored.previewStatus).toBe("PLANNING");
  });
});

describe("a preview overtaken halfway through", () => {
  it("stops at the next progress report and leaves the new preview alone", async () => {
    // Somebody changed the mapping and asked again while row 30 was planned.
    const stored = session();
    const { service, reported } = harness(stored, {
      duringRow: (rowsPrepared, row) => {
        if (rowsPrepared === 30) {
          row.previewId = "preview-2";
        }
      },
    });

    await service.runPreview("session-1", "preview-1");

    expect(reported()).toEqual([PREVIEW_PROGRESS_ROWS]);
    expect(stored).toMatchObject({
      previewId: "preview-2",
      previewStatus: "PLANNING",
      previewToken: null,
      previewCipher: null,
      previewFailureReason: null,
    });
  });

  it("stops when the import is started from another preview meanwhile", async () => {
    const stored = session();
    const { service } = harness(stored, {
      duringRow: (rowsPrepared, row) => {
        if (rowsPrepared === 10) {
          row.status = "QUEUED";
        }
      },
    });

    await service.runPreview("session-1", "preview-1");

    expect(stored.previewToken).toBeNull();
    expect(stored.previewStatus).toBe("PLANNING");
  });
});

describe("a preview nobody is watching", () => {
  it("is stopped and recorded as interrupted", async () => {
    // The screen last asked long enough ago by the time row 10 is planned.
    const stored = session();
    const { service, reported } = harness(stored, {
      duringRow: (rowsPrepared, row) => {
        if (rowsPrepared === 10) {
          row.previewWatchedAt = new Date(
            Date.now() - PREVIEW_UNWATCHED_MS - 1000,
          );
        }
      },
    });

    await service.runPreview("session-1", "preview-1");

    expect(reported()).toEqual([PREVIEW_PROGRESS_ROWS]);
    expect(stored).toMatchObject({
      previewStatus: "FAILED",
      previewFailureReason: "preview-interrupted",
      previewToken: null,
    });
  });

  it("is not decrypted when its job starts after the screen has gone", async () => {
    const stored = session({
      previewWatchedAt: new Date(Date.now() - PREVIEW_UNWATCHED_MS - 1000),
    });
    const { service, plan, decryptRows } = harness(stored);

    await service.runPreview("session-1", "preview-1");

    expect(decryptRows).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      previewStatus: "FAILED",
      previewFailureReason: "preview-interrupted",
    });
  });

  it("goes on while the screen keeps asking", async () => {
    const stored = session({
      previewWatchedAt: new Date(Date.now() - PREVIEW_UNWATCHED_MS + 60_000),
    });
    const { service } = harness(stored);

    await service.runPreview("session-1", "preview-1");

    expect(stored.previewStatus).toBe("READY");
  });
});

describe("a preview the screen stopped waiting for", () => {
  it("frees the worker at the next progress report", async () => {
    // The board picked another file while row 10 was planned. The job lets go
    // at its first report rather than planning on until the preview is found
    // unwatched, so the next preview on the instance does not wait behind it.
    const stored = session();
    let furthest = 0;
    const { service, reported } = harness(stored, {
      duringRow: (rowsPrepared) => {
        furthest = rowsPrepared;
        if (rowsPrepared === 10) {
          void service.cancel("session-1", "preview-1");
        }
      },
    });

    await service.runPreview("session-1", "preview-1");

    expect(reported()).toEqual([PREVIEW_PROGRESS_ROWS]);
    expect(furthest).toBe(PREVIEW_PROGRESS_ROWS);
    expect(stored).toMatchObject({
      previewStatus: "FAILED",
      previewFailureReason: "preview-cancelled",
      previewToken: null,
      previewCipher: null,
    });
  });

  it("leaves a preview alone once it is ready", async () => {
    const stored = session();
    const { service } = harness(stored);
    await service.runPreview("session-1", "preview-1");
    const token = stored.previewToken;

    await service.cancel("session-1", "preview-1");

    expect(stored).toMatchObject({
      previewStatus: "READY",
      previewToken: token,
    });
  });

  it("leaves the preview that replaced it alone", async () => {
    const stored = session({ previewId: "preview-2" });
    const { service } = harness(stored);

    await service.cancel("session-1", "preview-1");

    expect(stored).toMatchObject({
      previewId: "preview-2",
      previewStatus: "PLANNING",
      previewFailureReason: null,
    });
  });
});

describe("a preview that fails", () => {
  it("records a refusal instead of retrying it", async () => {
    const stored = session();
    const { service } = harness(stored, {
      planFails: new ImportError("No.", "mapping-invalid"),
    });

    await service.runPreview("session-1", "preview-1");

    expect(stored).toMatchObject({
      previewStatus: "FAILED",
      previewFailureReason: "mapping-invalid",
    });
  });

  it("throws anything else on for the queue to retry", async () => {
    const stored = session();
    const { service } = harness(stored, {
      planFails: new Error("connection lost"),
    });

    await expect(service.runPreview("session-1", "preview-1")).rejects.toThrow(
      "connection lost",
    );
    expect(stored.previewStatus).toBe("PLANNING");
  });
});

describe("reading a preview", () => {
  it("shows the progress and no plan while it is planned", async () => {
    const stored = session({ previewRowsDone: 50 });
    const { service } = harness(stored);

    expect(await service.view("session-1", stored)).toEqual({
      sessionId: "session-1",
      previewId: "preview-1",
      status: "PLANNING",
      rowsDone: 50,
      rowsTotal: ROWS,
      failureReason: null,
      preview: null,
    });
  });
});

describe("resuming after a restart", () => {
  it("queues every preview that was being planned", async () => {
    const stored = session();
    const { service, send } = harness(stored);

    expect(await service.resumeInterruptedPreviews()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      IMPORT_PREVIEW_QUEUE,
      { sessionId: "session-1", previewId: "preview-1" },
      expect.objectContaining({ retryLimit: expect.any(Number) }),
    );
  });

  it("records one nobody has asked about since as interrupted", async () => {
    // The process was down longer than a screen keeps waiting: re-queuing it
    // would only decrypt the file to find nobody is looking.
    const stored = session({
      previewWatchedAt: new Date(Date.now() - PREVIEW_UNWATCHED_MS - 1000),
    });
    const { service, send } = harness(stored);

    expect(await service.resumeInterruptedPreviews()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      previewStatus: "FAILED",
      previewFailureReason: "preview-interrupted",
    });
  });
});
