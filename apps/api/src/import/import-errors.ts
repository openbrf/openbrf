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
  // A file refused for its shape while it was read.
  | ImportShapeReason
  | "mapping-invalid"
  | "preview-required"
  /**
   * The preview no longer matches the register: another import finished
   * writing after it was taken, or a decision answers a row it did not ask
   * about. Answered with 400; the session stays in MAPPING and is previewed
   * again.
   */
  | "preview-outdated"
  /**
   * The board's decisions are not the ones the preview was planned with, so
   * what they write has not been shown. Answered with 400; the session stays in
   * MAPPING, and the screen previews it again with them.
   */
  | "decisions-not-previewed"
  /**
   * The preview this request holds is no longer the session's: somebody
   * previewed it again - another tab, another board member - perhaps with
   * other columns. Answered with 409, and the session stays in MAPPING.
   */
  | "preview-replaced"
  | "preview-interrupted"
  | "preview-cancelled"
  | "ambiguous-rows-undecided"
  | "decision-not-a-candidate"
  /**
   * A row the chunk was about to write to a new person now matches somebody in
   * the register the plan did not find: the person was added, moved in or given
   * the row's address after the chunk was planned. Or a row the board answered
   * now matches other persons than the preview showed for it: somebody joined
   * them, or one of them moved out or was erased. Recorded by the job, which
   * stops without writing the chunk rather than enter one human being twice or
   * carry out a choice made between other persons. The chunks before it are
   * written.
   */
  | "register-changed-during-apply"
  | "apply-interrupted"
  /**
   * Recorded on a session an administrator abandoned while it was queued or
   * applying. Never a request's answer.
   */
  | "apply-abandoned"
  /**
   * An import proposal that is no longer waiting for the board (ADR 0043):
   * the plugin sent a newer one, a board member rejected it, the plugin took
   * it back, or nobody decided it in time. Answered with 409 to a preview, an
   * apply or a rejection of it, and nothing is written.
   */
  | "proposal-superseded"
  | "proposal-rejected"
  | "proposal-withdrawn"
  | "proposal-expired"
  /**
   * Only `host.imports.propose` refuses with these three. The file holds the
   * rows of the last file from the plugin the board applied, or of the one
   * still waiting; the sender is longer than 320 characters; the file name is
   * empty or longer than 255.
   */
  | "file-unchanged"
  | "sender-too-long"
  | "file-name-invalid";

/** The reasons an import proposal that has ended refuses with. */
export const PROPOSAL_ENDED_REASONS = [
  "proposal-superseded",
  "proposal-rejected",
  "proposal-withdrawn",
  "proposal-expired",
] as const satisfies readonly ImportErrorReason[];

export class ImportError extends DomainError {
  override readonly status: number;
  override readonly reason: ImportErrorReason;

  /**
   * What is wrong with a mapping, as the codes `validateMapping` returns.
   *
   * Static codes, and a field name for a duplicate: nothing from the file. The
   * screen turns each into its own sentence, since "the mapping cannot be
   * applied" does not say which column to change.
   */
  readonly problems: readonly string[];

  constructor(
    message: string,
    reason: ImportErrorReason,
    problems: readonly string[] = [],
  ) {
    super(message);
    this.reason = reason;
    this.problems = problems;
    this.status =
      reason === "session-not-found"
        ? 404
        : reason === "session-expired" ||
            reason === "session-already-applied" ||
            reason === "another-import-running" ||
            reason === "session-not-running" ||
            reason === "preview-replaced" ||
            (PROPOSAL_ENDED_REASONS as readonly string[]).includes(reason)
          ? 409
          : 400;
  }

  override details(): Record<string, readonly unknown[]> {
    return { problems: this.problems };
  }
}
