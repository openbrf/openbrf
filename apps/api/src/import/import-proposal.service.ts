import { Injectable, Logger } from "@nestjs/common";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type {
  ImportProposalOutcome,
  ImportSessionStatus,
} from "../generated/prisma/enums";
import { suggestMapping } from "./import-columns";
import { ImportError } from "./import-errors";
import { maskedSample, readImportFile, SAMPLE_ROWS } from "./import-file";
import { lockImportProposals } from "./import-lock";
import { ENDED_SESSION_DATA, RUNNING_IMPORT_STATUSES } from "./import-run";
import {
  contentDigestOf,
  pluginSourceKeyOf,
  savedMapping,
} from "./import-source";
import type { ImportSessionView } from "./import.service";

/**
 * Import proposals: member lists a plugin hands the core for the board to
 * review (ADR 0043).
 *
 * A proposal is an import session no person uploaded. The plugin hands over
 * the file and the core reads it as it reads an upload, holds its rows
 * encrypted, and puts it at the top of the import screen and in the board's
 * queue. From there it is an ordinary import: a board member opens it at the
 * mapping step, previews it, decides and applies it, with the same checks and
 * the same token tying the apply to the preview that was looked at. Nothing a
 * plugin can call applies one, and nothing it is told back is a read of the
 * register: the receipt, a refusal's reason, and where its own proposals stand.
 *
 * A plugin has at most one proposal waiting. The next one replaces it, and the
 * one replaced drops its rows, as one rejected, withdrawn or left to expire
 * does. What is left of a decided proposal - the plugin, the file name, the
 * sender, the digest, the row count and its dates - is the run history, kept
 * 90 days and then deleted with it.
 */

/** How long a proposal waits for the board: a week away, with room to spare. */
export const PROPOSAL_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a decided proposal's record is kept, without its rows. */
export const PROPOSAL_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The longest sender a plugin may report, as an email address may be. */
export const MAX_PROPOSAL_SENDER_LENGTH = 320;

/** The longest file name, as an upload's. */
const MAX_FILE_NAME_LENGTH = 255;

/**
 * How many decided proposals the import screen lists, newest first. Every
 * waiting one is listed: a plugin has at most one.
 */
const LISTED_DECIDED_PROPOSALS = 50;

/** Where a proposal stands, in the plugin contract's words. */
export type ImportProposalState =
  | "pending"
  | "applying"
  | "applied"
  | "failed"
  | "rejected"
  | "superseded"
  | "expired"
  | "withdrawn";

/** A proposal as the board sees it on the import screen. */
export interface ImportProposalView {
  proposalId: string;
  plugin: {
    id: string;
    /** The installed package's name, or null once it has been removed. */
    name: string | null;
  };
  fileName: string;
  /** As the plugin reported it, which is not a verified identity. */
  sender: string | null;
  rowCount: number;
  proposedAt: string;
  expiresAt: string;
  state: ImportProposalState;
  decidedAt: string | null;
}

/** A proposal opened at the mapping step. */
export interface ImportProposalSessionView extends ImportSessionView {
  proposal: ImportProposalView;
  /**
   * That the board saved a mapping for this plugin's files, and this file's
   * column titles are not the ones it was saved for. Nothing is guessed in
   * its place silently: the board maps the columns again.
   */
  columnsChanged: boolean;
}

/** What the plugin is told once its file is stored. */
export interface ImportProposalReceiptView {
  proposalId: string;
  rowCount: number;
  expiresAt: string;
}

const PROPOSAL_SELECT = {
  id: true,
  proposedByPluginId: true,
  fileName: true,
  senderCipher: true,
  rowCount: true,
  status: true,
  proposalOutcome: true,
  createdAt: true,
  expiresAt: true,
  decidedAt: true,
  finishedAt: true,
} as const;

type ProposalRow = Prisma.ImportSessionGetPayload<{
  select: typeof PROPOSAL_SELECT;
}>;

/**
 * What a proposal stops holding when it ends without being applied: its rows,
 * as any ended import does, and the preview a board member may have been
 * planning, whose job then finds nothing to plan.
 */
const ENDED_PROPOSAL_DATA = {
  ...ENDED_SESSION_DATA,
  previewId: null,
  previewStatus: null,
} as const satisfies Prisma.ImportSessionUpdateManyMutationInput;

/** A proposal still waiting for the board: its rows are the ones to drop. */
function waiting(now: Date): Prisma.ImportSessionWhereInput {
  return {
    proposedByPluginId: { not: null },
    status: "MAPPING",
    proposalOutcome: null,
    expiresAt: { gt: now },
  };
}

@Injectable()
export class ImportProposalService {
  private readonly logger = new Logger(ImportProposalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Reads a plugin's file and holds it as a proposal for the board.
   *
   * Refused, with nothing stored, for every reason an upload is, and for three
   * of its own: the rows are those of the last file from this plugin the board
   * applied or of the one still waiting (`file-unchanged`), the sender is too
   * long, or the file name is empty or too long.
   *
   * The proposal waiting before it, if there is one, is replaced in the same
   * transaction, under a lock per plugin, so two files from one plugin at once
   * leave one waiting and not two. The preview is not planned here: it is
   * planned against the register as it is when a board member opens it.
   */
  async propose(
    pluginId: string,
    file: { fileName: string; content: Buffer; sender: string | null },
  ): Promise<ImportProposalReceiptView> {
    const fileName = file.fileName.trim();
    if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
      throw new ImportError(
        "A proposal's file name is 1 to 255 characters.",
        "file-name-invalid",
      );
    }
    const sender = file.sender?.trim() ?? "";
    if (sender.length > MAX_PROPOSAL_SENDER_LENGTH) {
      throw new ImportError(
        "A proposal's sender is at most 320 characters.",
        "sender-too-long",
      );
    }

    const { format, rows, header, data, sourceRows } = await readImportFile(
      file.content,
      fileName,
    );
    const sourceKey = await pluginSourceKeyOf(
      this.encryption,
      pluginId,
      header,
    );
    const contentDigest = await contentDigestOf(this.encryption, rows);
    // Encrypted before the lock is taken: it is the slow part, and the lock
    // only has to cover what the other proposals of this plugin read.
    const rowsCipher = (
      await this.encryption.encrypt("importSession.rows", JSON.stringify(data))
    ).cipher;
    const senderCipher =
      sender === ""
        ? null
        : (await this.encryption.encrypt("importSession.sender", sender))
            .cipher;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PROPOSAL_LIFETIME_MS);
    const proposalId = await this.prisma.$transaction(async (tx) => {
      await lockImportProposals(tx, pluginId);

      const pending = await tx.importSession.findMany({
        where: {
          proposedByPluginId: pluginId,
          status: "MAPPING",
          proposalOutcome: null,
        },
        select: { id: true, contentDigest: true, expiresAt: true },
      });
      const source = await tx.importSource.findUnique({
        where: { key: sourceKey },
        select: { appliedDigest: true, appliedAt: true },
      });
      if (
        pending.some(
          (proposal) =>
            proposal.expiresAt > now &&
            proposal.contentDigest === contentDigest,
        ) ||
        (source !== null &&
          source.appliedAt !== null &&
          source.appliedDigest === contentDigest)
      ) {
        throw new ImportError(
          "The file holds the rows of the last one from this plugin.",
          "file-unchanged",
        );
      }

      // Conditional on still waiting: one a board member started meanwhile is
      // theirs, and goes on being applied.
      for (const [outcome, ids] of [
        [
          "SUPERSEDED",
          pending.filter((p) => p.expiresAt > now).map((p) => p.id),
        ],
        ["EXPIRED", pending.filter((p) => p.expiresAt <= now).map((p) => p.id)],
      ] as const) {
        if (ids.length > 0) {
          await tx.importSession.updateMany({
            where: {
              id: { in: ids },
              status: "MAPPING",
              proposalOutcome: null,
            },
            data: {
              proposalOutcome: outcome,
              decidedAt: now,
              ...ENDED_PROPOSAL_DATA,
            },
          });
        }
      }

      const created = await tx.importSession.create({
        data: {
          fileName,
          format,
          columns: header,
          rowsCipher,
          rowCount: data.length,
          sourceRows,
          sourceKey,
          contentDigest,
          proposedByPluginId: pluginId,
          senderCipher,
          expiresAt,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: "IMPORT_PROPOSED",
          channel: "PLUGIN",
          actorPersonId: null,
          targetKind: "importSession",
          targetId: created.id,
          // Never the file name or the sender: either can carry a person's
          // name, and this log is never purged.
          context: { pluginId, rowCount: data.length },
        },
        tx,
      );
      return created.id;
    });

    this.logger.log(
      `Import proposal ${proposalId} from plugin ${pluginId}: ${String(data.length)} rows from ${format}`,
    );
    return {
      proposalId,
      rowCount: data.length,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Where one of the plugin's own proposals stands. `unknown` for an id that
   * is not one of its proposals, whether or not it exists, and for one whose
   * record has been deleted.
   */
  async status(
    pluginId: string,
    proposalId: string,
    now: Date = new Date(),
  ): Promise<{
    state: ImportProposalState | "unknown";
    decidedAt: string | null;
  }> {
    const row = await this.prisma.importSession.findFirst({
      where: { id: proposalId, proposedByPluginId: pluginId },
      select: PROPOSAL_SELECT,
    });
    if (row === null) {
      return { state: "unknown", decidedAt: null };
    }
    const { state, decidedAt } = stateOf(row, now);
    return { state, decidedAt: decidedAt?.toISOString() ?? null };
  }

  /** Takes back the plugin's own pending proposal. True when there was one. */
  async withdraw(pluginId: string, proposalId: string): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.importSession.updateMany({
      where: { id: proposalId, ...waiting(now), proposedByPluginId: pluginId },
      data: {
        proposalOutcome: "WITHDRAWN",
        decidedAt: now,
        ...ENDED_PROPOSAL_DATA,
      },
    });
    if (count > 0) {
      this.logger.log(
        `Import proposal ${proposalId} withdrawn by plugin ${pluginId}`,
      );
    }
    return count > 0;
  }

  /**
   * The proposals the import screen lists: every one waiting, then the ones
   * decided, newest first, as long as their records are kept.
   *
   * Asked apart, so a plugin that proposes often fills the history and never
   * pushes another plugin's waiting proposal off the list.
   */
  async list(now: Date = new Date()): Promise<ImportProposalView[]> {
    const waitingRows = await this.prisma.importSession.findMany({
      where: { ...waiting(now) },
      orderBy: { createdAt: "desc" },
      select: PROPOSAL_SELECT,
    });
    const decidedRows = await this.prisma.importSession.findMany({
      where: {
        proposedByPluginId: { not: null },
        NOT: { id: { in: waitingRows.map((row) => row.id) } },
      },
      orderBy: { createdAt: "desc" },
      take: LISTED_DECIDED_PROPOSALS,
      select: PROPOSAL_SELECT,
    });
    const rows = [...waitingRows, ...decidedRows];
    const names = await this.pluginNames(rows);
    return Promise.all(rows.map((row) => this.view(row, names, now)));
  }

  /**
   * Opens a waiting proposal at the mapping step, as an upload is answered.
   *
   * The mapping saved for the plugin is offered when the file's column titles
   * are the ones it was saved for, title for title. When there is one for other
   * titles, the screen says the columns have changed.
   */
  async open(proposalId: string): Promise<ImportProposalSessionView> {
    const now = new Date();
    const session = await this.prisma.importSession.findFirst({
      where: { id: proposalId, proposedByPluginId: { not: null } },
      select: {
        ...PROPOSAL_SELECT,
        format: true,
        columns: true,
        rowsCipher: true,
        sourceKey: true,
      },
    });
    const pluginId = session?.proposedByPluginId ?? null;
    if (session === null || pluginId === null) {
      throw new ImportError("No such import.", "session-not-found");
    }
    refuseUnlessWaiting(session, now);
    if (session.rowsCipher === null) {
      // Ended between the read of its state and here, which the state read
      // with the rows would have said.
      throw new ImportError("No such import.", "session-not-found");
    }

    const data = JSON.parse(
      await this.encryption.decrypt("importSession.rows", session.rowsCipher),
    ) as string[][];
    const source =
      session.sourceKey === null
        ? null
        : await this.prisma.importSource.findUnique({
            where: { key: session.sourceKey },
            select: {
              mapping: true,
              defaultRole: true,
              defaultMovedInOn: true,
              mappingSavedAt: true,
            },
          });
    const saved = savedMapping(source, session.columns.length);
    const columnsChanged =
      saved === null &&
      (await this.prisma.importSource.count({ where: { pluginId } })) > 0;
    const suggestedMapping = suggestMapping(session.columns);
    const names = await this.pluginNames([session]);

    return {
      sessionId: session.id,
      fileName: session.fileName,
      format: session.format,
      columns: session.columns,
      rowCount: session.rowCount,
      sample: maskedSample(
        data.slice(0, SAMPLE_ROWS),
        suggestedMapping,
        saved?.mapping ?? [],
      ),
      suggestedMapping,
      savedMapping: saved,
      expiresAt: session.expiresAt.toISOString(),
      proposal: await this.view(session, names, now),
      columnsChanged,
    };
  }

  /**
   * Rejects a waiting proposal. Its rows are deleted, and the rejection is
   * recorded on the board member's channel in the same transaction.
   */
  async reject(proposalId: string, actor: ActorContext): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.importSession.findFirst({
        where: { id: proposalId, proposedByPluginId: { not: null } },
        select: PROPOSAL_SELECT,
      });
      if (session === null) {
        throw new ImportError("No such import.", "session-not-found");
      }
      const { count } = await tx.importSession.updateMany({
        where: { id: proposalId, ...waiting(now) },
        data: {
          proposalOutcome: "REJECTED",
          decidedAt: now,
          ...ENDED_PROPOSAL_DATA,
        },
      });
      if (count === 0) {
        // Ended or started since it was read: answered from where it is now.
        const current = await tx.importSession.findUnique({
          where: { id: proposalId },
          select: PROPOSAL_SELECT,
        });
        if (current === null) {
          throw new ImportError("No such import.", "session-not-found");
        }
        refuseUnlessWaiting(current, now);
        throw new ImportError(
          "That import has already been started.",
          "session-already-applied",
        );
      }
      await this.audit.record(
        {
          action: "IMPORT_PROPOSAL_REJECTED",
          ...auditActor(actor),
          targetKind: "importSession",
          targetId: proposalId,
          context: { pluginId: session.proposedByPluginId },
        },
        tx,
      );
    });
    this.logger.log(`Import proposal ${proposalId} rejected`);
  }

  /**
   * Ends the proposals nobody decided in time, and deletes the records of the
   * ones decided more than 90 days ago.
   *
   * Expiring drops the rows at once. A proposal a board member started is the
   * import's, and is left alone while it runs; once it has ended, it is kept
   * for 90 days after it finished.
   */
  async purge(now: Date = new Date()): Promise<{
    expired: number;
    deleted: number;
  }> {
    const expired = await this.prisma.importSession.updateMany({
      where: {
        proposedByPluginId: { not: null },
        status: "MAPPING",
        proposalOutcome: null,
        expiresAt: { lte: now },
      },
      data: {
        proposalOutcome: "EXPIRED",
        decidedAt: now,
        ...ENDED_PROPOSAL_DATA,
      },
    });
    const cutoff = new Date(now.getTime() - PROPOSAL_RECORD_RETENTION_MS);
    const deleted = await this.prisma.importSession.deleteMany({
      where: {
        proposedByPluginId: { not: null },
        status: { notIn: [...RUNNING_IMPORT_STATUSES] },
        NOT: { status: "MAPPING", proposalOutcome: null },
        OR: [
          { finishedAt: { lt: cutoff } },
          { finishedAt: null, decidedAt: { lt: cutoff } },
        ],
      },
    });
    if (expired.count > 0 || deleted.count > 0) {
      this.logger.log(
        `Import proposals: ${String(expired.count)} expired, ${String(deleted.count)} records deleted`,
      );
    }
    return { expired: expired.count, deleted: deleted.count };
  }

  /** The installed package's name for each plugin, while it is installed. */
  private async pluginNames(
    rows: readonly { proposedByPluginId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.flatMap((row) => row.proposedByPluginId ?? [])),
    ];
    if (ids.length === 0) {
      return new Map();
    }
    const plugins = await this.prisma.installedPlugin.findMany({
      where: { id: { in: ids } },
      select: { id: true, packageName: true },
    });
    return new Map(plugins.map((plugin) => [plugin.id, plugin.packageName]));
  }

  private async view(
    row: ProposalRow,
    names: ReadonlyMap<string, string>,
    now: Date,
  ): Promise<ImportProposalView> {
    const pluginId = row.proposedByPluginId ?? "";
    const { state, decidedAt } = stateOf(row, now);
    return {
      proposalId: row.id,
      plugin: { id: pluginId, name: names.get(pluginId) ?? null },
      fileName: row.fileName,
      sender:
        row.senderCipher === null
          ? null
          : await this.encryption.decrypt(
              "importSession.sender",
              row.senderCipher,
            ),
      rowCount: row.rowCount,
      proposedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      state,
      decidedAt: decidedAt?.toISOString() ?? null,
    };
  }
}

/** The refusal for an action on a proposal that has ended. */
export function proposalEnded(outcome: ImportProposalOutcome): ImportError {
  switch (outcome) {
    case "SUPERSEDED":
      return new ImportError(
        "The plugin has proposed a newer file since.",
        "proposal-superseded",
      );
    case "REJECTED":
      return new ImportError(
        "That proposal was rejected.",
        "proposal-rejected",
      );
    case "WITHDRAWN":
      return new ImportError(
        "The plugin has taken that proposal back.",
        "proposal-withdrawn",
      );
    case "EXPIRED":
      return new ImportError("That proposal has expired.", "proposal-expired");
  }
}

/**
 * Refuses unless the proposal is still waiting for the board, with the reason
 * it is not.
 */
function refuseUnlessWaiting(
  row: Pick<ProposalRow, "status" | "proposalOutcome" | "expiresAt">,
  now: Date,
): void {
  if (row.proposalOutcome !== null) {
    throw proposalEnded(row.proposalOutcome);
  }
  if (row.status !== "MAPPING") {
    throw new ImportError(
      "That import has already been started.",
      "session-already-applied",
    );
  }
  if (row.expiresAt <= now) {
    throw proposalEnded("EXPIRED");
  }
}

/**
 * Where a proposal stands, read from its session.
 *
 * One left to expire reads as expired from the moment it does, before the
 * nightly purge records it so. A proposal a board member started is the
 * import's from then on, and stands where the import does.
 */
export function stateOf(
  row: Pick<
    ProposalRow,
    "status" | "proposalOutcome" | "expiresAt" | "decidedAt" | "finishedAt"
  >,
  now: Date,
): { state: ImportProposalState; decidedAt: Date | null } {
  if (row.proposalOutcome !== null) {
    return {
      state: OUTCOME_STATE[row.proposalOutcome],
      decidedAt:
        row.proposalOutcome === "EXPIRED" ? row.expiresAt : row.decidedAt,
    };
  }
  const status: ImportSessionStatus = row.status;
  switch (status) {
    case "MAPPING":
      return row.expiresAt <= now
        ? { state: "expired", decidedAt: row.expiresAt }
        : { state: "pending", decidedAt: null };
    case "QUEUED":
    case "APPLYING":
      return { state: "applying", decidedAt: row.decidedAt };
    case "APPLIED":
      return { state: "applied", decidedAt: row.finishedAt ?? row.decidedAt };
    case "FAILED":
      return { state: "failed", decidedAt: row.finishedAt ?? row.decidedAt };
  }
}

const OUTCOME_STATE: Readonly<
  Record<ImportProposalOutcome, ImportProposalState>
> = {
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
};
