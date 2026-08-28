import { DomainError } from "../http/domain-error";

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
  | "file-empty"
  | "file-too-large"
  | "file-unreadable"
  | "too-many-rows"
  | "mapping-invalid"
  | "preview-required"
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
        : reason === "session-expired" || reason === "session-already-applied"
          ? 409
          : 400;
  }
}
