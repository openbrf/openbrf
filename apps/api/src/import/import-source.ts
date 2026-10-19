import { createHash } from "node:crypto";

import type { Prisma } from "../generated/prisma/client";
import { type ImportField, readMapping } from "./import-columns";
import type { ImportRole } from "./import-plan";

/**
 * The file a board imports from again and again.
 *
 * A member list is rarely imported once. The manager sends a new export every
 * quarter, or the board keeps its own spreadsheet and loads it after each
 * change, and every one of those files comes back with the same column titles.
 * The titles are therefore what names the source, and two things are kept for
 * it (`ImportSource`):
 *
 * - The mapping the board last started an import with. The next file from the
 *   same source is offered it in place of the guess from the titles, which is
 *   what a board that mapped a column by hand last time expects to see again.
 *   It is still only offered: the mapping screen shows it and the board
 *   confirms it, as it does a guess.
 * - The digest of the last file from it that was applied to the end. The same
 *   rows uploaded again are answered as unchanged, before anything is stored
 *   or planned, and only reviewed when the board asks for it. A review of a
 *   file the register already holds would be one of nothing, and it would
 *   cost an Argon2id hash per identity number to show it (ADR 0002).
 */

/** What the upload says about a source the file's titles name. */
export interface ImportSourceView {
  /** The mapping offered in place of the guess, one entry per column. */
  mapping: (ImportField | null)[];
  defaultRole: ImportRole | null;
  defaultMovedInOn: string | null;
  /** When the board last started an import with this mapping. */
  mappingSavedAt: string;
}

/**
 * The key a header is recognised by: its titles trimmed and lower-cased, in
 * file order.
 *
 * Exact apart from case and the space around a title. Two files whose titles
 * differ in any other way are two sources, because a mapping is a list of
 * columns by position, and offering one to a file whose columns moved would
 * put one field's values into another.
 */
export function sourceKeyOf(columns: readonly string[]): string {
  const titles = columns.map((title) =>
    title.normalize("NFC").trim().toLowerCase(),
  );
  return createHash("sha256").update(JSON.stringify(titles)).digest("hex");
}

/**
 * The digest of a file's rows as the import read them, header included.
 *
 * Of the rows rather than the bytes, so the same list saved again - another
 * line ending, a workbook opened and saved without a change - is the same file.
 * A plain hash and not a keyed one: it is taken over a whole member list, which
 * nobody can guess well enough to confirm by hashing a candidate.
 */
export function contentDigestOf(rows: readonly (readonly string[])[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * The mapping saved for a source, when it still fits the file.
 *
 * A source whose key matches has the same number of columns by construction;
 * the length is checked anyway, since a mapping that does not fit would be
 * refused by the preview.
 */
export function savedMapping(
  source: {
    mapping: string[];
    defaultRole: ImportRole | null;
    defaultMovedInOn: string | null;
    mappingSavedAt: Date;
  } | null,
  columnCount: number,
): ImportSourceView | null {
  if (source === null || source.mapping.length !== columnCount) {
    return null;
  }
  return {
    mapping: [...readMapping(source.mapping)],
    defaultRole: source.defaultRole,
    defaultMovedInOn: source.defaultMovedInOn,
    mappingSavedAt: source.mappingSavedAt.toISOString(),
  };
}

/**
 * Keeps the mapping a session is being applied with, for the next file from
 * the same source.
 *
 * Called in the transaction that claims the session, so the mapping saved is
 * the one the preview was taken with and the board started the import on. A
 * session uploaded before sources were recorded has no key and saves nothing.
 */
export async function saveSourceMapping(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  const session = await tx.importSession.findUnique({
    where: { id: sessionId },
    select: {
      sourceKey: true,
      columns: true,
      mapping: true,
      defaultRole: true,
      defaultMovedInOn: true,
    },
  });
  if (session === null || session.sourceKey === null) {
    return;
  }
  const saved = {
    columns: session.columns,
    mapping: session.mapping,
    defaultRole: session.defaultRole,
    defaultMovedInOn: session.defaultMovedInOn,
    mappingSavedAt: new Date(),
  };
  await tx.importSource.upsert({
    where: { key: session.sourceKey },
    create: { key: session.sourceKey, ...saved },
    update: saved,
  });
}

/**
 * Records the file a session applied as the last one from its source.
 *
 * Called once the session is marked applied, after the statement that marks it
 * so. Only a file the register now holds whole is recorded: one that stopped
 * part way, or one with rows the apply refused as problems, has rows the
 * register does not hold, and uploading it again - after the apartment a row
 * named has been added, say - has to be reviewed rather than waved through.
 * Rows the board chose to leave out were its decision, and do not count.
 */
export async function recordSourceApplied(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  const session = await tx.importSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      sourceKey: true,
      contentDigest: true,
      fileName: true,
      finishedAt: true,
      rowsWithProblems: true,
    },
  });
  if (
    session === null ||
    session.status !== "APPLIED" ||
    session.rowsWithProblems > 0 ||
    session.sourceKey === null ||
    session.contentDigest === null
  ) {
    return;
  }
  await tx.importSource.updateMany({
    where: { key: session.sourceKey },
    data: {
      appliedDigest: session.contentDigest,
      appliedFileName: session.fileName,
      appliedAt: session.finishedAt ?? new Date(),
    },
  });
}
