import { DomainError } from "../http/domain-error";
import type { ImportShapeReason } from "./import-limits";

/**
 * What can go wrong with an import, as a code rather than as a sentence.
 *
 * The same vocabulary is used twice: a request answers with one of these, and a
 * job that stops early records one on the session it was applying. The screen
 * therefore translates a failure the same way whether it came back from the
 * button that was pressed or from a worker that ran minutes later.
 */
export type ImportErrorReason =
  | "session-not-found"
  | "session-expired"
  | "session-already-applied"
  | "another-import-running"
  | "file-empty"
  | "file-too-large"
  | "file-unreadable"
  // A file refused for its shape while it was read.
  | ImportShapeReason
  | "mapping-invalid"
  | "preview-required"
  | "preview-changed"
  | "preview-interrupted"
  | "ambiguous-rows-undecided"
  | "decision-not-a-candidate"
  | "apply-interrupted";

export class ImportError extends DomainError {
  override readonly status: number;
  override readonly reason: ImportErrorReason;

  constructor(message: string, reason: ImportErrorReason) {
    super(message);
    this.reason = reason;
    this.status =
      reason === "session-not-found"
        ? 404
        : reason === "session-expired" ||
            reason === "session-already-applied" ||
            reason === "another-import-running" ||
            reason === "preview-changed"
          ? 409
          : 400;
  }
}
