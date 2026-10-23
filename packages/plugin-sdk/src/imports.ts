/**
 * Handing a member list to the board (ADR 0043).
 *
 * A plugin that brings the association's member list in from elsewhere - a
 * file mailed to an address, an export fetched from the economic manager's
 * system - hands it to the core here, and the core holds it as an **import
 * proposal**: an import session on the core's own import screen, marked as
 * proposed by the plugin, which a board member previews, decides and applies,
 * or rejects. The plugin never applies anything, and it learns nothing about
 * what the file would do: each of those is a read of the register, and the
 * permission behind this, addressBook:proposeImport, grants none.
 */

/** The file a plugin hands over. */
export interface ImportProposalFile {
  /** Shown to the board beside the proposal. 1 to 255 characters. */
  fileName: string;
  /**
   * The file, CSV or XLSX, which the core parses exactly as it parses an
   * upload, with the same limits. A source that gives JSON is written out as
   * CSV first.
   */
  content: Uint8Array;
  /**
   * Who sent the file, as the source reports it: the address an email came
   * from. Absent for a source that has no sender, such as a fetch from a
   * manager's system. A claim, not a verified identity, and shown to the board
   * as one. At most 320 characters.
   */
  sender?: string;
}

export interface ImportProposalReceipt {
  proposalId: string;
  /** Data rows read from the file, below its column titles. */
  rowCount: number;
  /** ISO 8601. When the proposal expires if nobody decides it. */
  expiresAt: string;
}

/** Where one of the plugin's own proposals stands. */
export const IMPORT_PROPOSAL_STATES = [
  /** Waiting for the board. */
  "pending",
  /** A board member started the import, and it is being written. */
  "applying",
  "applied",
  /** The import a board member started stopped before the end. */
  "failed",
  "rejected",
  /** A newer proposal from the same plugin replaced it. */
  "superseded",
  /** Nobody decided it in time. */
  "expired",
  /** The plugin took it back. */
  "withdrawn",
  /** Not one of this plugin's proposals, or no longer kept. */
  "unknown",
] as const;

export type ImportProposalState = (typeof IMPORT_PROPOSAL_STATES)[number];

export interface ImportProposalStatus {
  state: ImportProposalState;
  /** ISO 8601. When it reached the state it is in. Null while pending or unknown. */
  decidedAt: string | null;
}

/**
 * Why a file was refused. Nothing was stored for it.
 *
 * The reasons an upload is refused for, and four of a proposal's own:
 * `file-unchanged` when the rows are those of the last file from this plugin
 * the board applied or of the one still pending, `sender-too-long`,
 * `sender-invalid` when the sender is neither text nor left out, and
 * `file-name-invalid`. Treat a reason you do not know as a refusal all the
 * same: a later core may add one.
 */
export const IMPORT_PROPOSAL_REFUSAL_REASONS = [
  "file-name-invalid",
  "file-empty",
  "header-row-missing",
  "file-too-large",
  "file-unreadable",
  "file-mixed-encoding",
  "too-many-rows",
  "too-many-columns",
  "cell-too-long",
  "unterminated-quote",
  "workbook-too-large",
  "file-unchanged",
  "sender-too-long",
  "sender-invalid",
] as const;

export type ImportProposalRefusalReason =
  (typeof IMPORT_PROPOSAL_REFUSAL_REASONS)[number];

/**
 * `host.imports.propose` refused the file. Carries the reason and nothing from
 * the file, so it can be logged as it is.
 */
export class ImportProposalRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`The core refused the import proposal: ${reason}.`);
    this.name = "ImportProposalRefusedError";
  }
}

/**
 * Proposing imports. Requires addressBook:proposeImport.
 *
 * A plugin has at most one pending proposal: a new one replaces the one
 * before, which becomes `superseded`. A proposal nobody decides expires after
 * 14 days, and a decided one stays answerable by `status` for 90 days.
 *
 * What the plugin must not keep, which the catalog review checks: the file,
 * or any part of it, is never passed to `host.jobs`, written to the log, the
 * settings, any store the host offers or an error the plugin throws, and the
 * plugin drops its copy once `propose` has answered. The sender likewise.
 */
export interface PluginImports {
  /**
   * Hands a member list to the core for the board to review. Resolves once the
   * core has parsed the file and stored the proposal, or rejects with
   * ImportProposalRefusedError and stores nothing.
   */
  propose(file: ImportProposalFile): Promise<ImportProposalReceipt>;

  /** Where one of this plugin's own proposals stands. */
  status(proposalId: string): Promise<ImportProposalStatus>;

  /** Withdraws this plugin's pending proposal. True when there was one. */
  withdraw(proposalId: string): Promise<boolean>;
}
