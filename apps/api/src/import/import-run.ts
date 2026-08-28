/**
 * The import as the screen that started it reads it back.
 *
 * The apply is a background job, so the only honest source for "what is
 * happening" is the session row itself: the job advances it as it commits each
 * chunk, and every reader - the request that started it, a reload of the same
 * screen, another board member's browser - re-reads that one row. Nothing is
 * held in a worker's memory that a restart would lose, and there is no second
 * copy of the truth to drift.
 */

export type ImportRunStatus =
  "MAPPING" | "QUEUED" | "APPLYING" | "APPLIED" | "FAILED";

/** What an import has written. Counted as chunks commit, not at the end. */
export interface ImportApplyResult {
  personsCreated: number;
  personsUpdated: number;
  residenciesCreated: number;
  memberRegisterEntriesCreated: number;
  skipped: number;
  errors: number;
}

export interface ImportRunView {
  sessionId: string;
  /** So a board member returning to the screen knows which file this was. */
  fileName: string;
  status: ImportRunStatus;
  /** Rows done against rows total: the file's data rows, header excluded. */
  rowsDone: number;
  rowsTotal: number;
  result: ImportApplyResult;
  /** The import's own reason code when it stopped early, else null. */
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The columns a run view is built from. */
export const IMPORT_RUN_SELECT = {
  id: true,
  fileName: true,
  status: true,
  rowCount: true,
  rowsDone: true,
  personsCreated: true,
  personsUpdated: true,
  residenciesCreated: true,
  memberRegisterEntriesCreated: true,
  rowsSkipped: true,
  rowsWithProblems: true,
  failureReason: true,
  startedAt: true,
  finishedAt: true,
} as const;

export interface ImportRunRow {
  id: string;
  fileName: string;
  status: ImportRunStatus;
  rowCount: number;
  rowsDone: number;
  personsCreated: number;
  personsUpdated: number;
  residenciesCreated: number;
  memberRegisterEntriesCreated: number;
  rowsSkipped: number;
  rowsWithProblems: number;
  failureReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export function toRunView(session: ImportRunRow): ImportRunView {
  return {
    sessionId: session.id,
    fileName: session.fileName,
    status: session.status,
    rowsDone: session.rowsDone,
    rowsTotal: session.rowCount,
    result: {
      personsCreated: session.personsCreated,
      personsUpdated: session.personsUpdated,
      residenciesCreated: session.residenciesCreated,
      memberRegisterEntriesCreated: session.memberRegisterEntriesCreated,
      skipped: session.rowsSkipped,
      errors: session.rowsWithProblems,
    },
    failureReason: session.failureReason,
    startedAt: session.startedAt?.toISOString() ?? null,
    finishedAt: session.finishedAt?.toISOString() ?? null,
  };
}

/** Whether the job still has work to do, and the screen still has to watch. */
export function isRunning(status: ImportRunStatus): boolean {
  return status === "QUEUED" || status === "APPLYING";
}
