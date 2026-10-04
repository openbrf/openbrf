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
  /**
   * Another session is queued or applying. Answered with 409 and the session
   * asked about is left in MAPPING, so it can be applied once the other has
   * finished.
   */
  | "another-import-running"
  /**
   * An administrator asked to abandon a session that is not queued or
   * applying: it has not been started, or it has already ended.
   */
  | "session-not-running"
  | "file-empty"
  | "file-too-large"
  | "file-unreadable"
  /**
   * A CSV without a byte order mark that is UTF-8 and another encoding at once.
   * Its own code, because the board can fix it by saving the file again, and
   * the generic "unreadable" message does not say how.
   */
  | "file-mixed-encoding"
  | "too-many-rows"
  | "mapping-invalid"
  | "preview-required"
  | "preview-outdated"
  /**
   * Somebody previewed the session again while this apply was starting, so
   * the preview it was checked against is no longer the one recorded. Answered
   * with 409, and the session stays in MAPPING.
   */
  | "preview-replaced"
  | "ambiguous-rows-undecided"
  | "decision-not-a-candidate"
  /**
   * A row the chunk was about to enter as a new person now matches somebody in
   * the register: the person was added, or given the row's address, after the
   * chunk was planned. Recorded by the job, which stops without writing the
   * chunk rather than enter one human being twice.
   */
  | "register-changed-during-apply"
  | "apply-interrupted"
  /**
   * Recorded on a session an administrator abandoned while it was queued or
   * applying. Never a request's answer.
   */
  | "apply-abandoned";

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
            reason === "session-not-running" ||
            reason === "preview-replaced"
          ? 409
          : 400;
  }
}
