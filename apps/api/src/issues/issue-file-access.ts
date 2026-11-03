import type { Principal } from "../authorization/capabilities";
import type { FeedDbClient } from "../feed/feed-audience";
import { issueReaderScope, scopeHandlesIssue } from "./issue-handlers";

/**
 * How a viewer reaches a file on an issue: as somebody who handles the issue,
 * as the person who reported it, or not at all.
 *
 * Two answers that serve the file rather than one, because the media route
 * records the first and not the second (`MediaService.open`).
 */
export type IssueFileAccess = "handler" | "reporter" | null;

/** The issue columns the rule reads. */
const ISSUE_ACCESS_SELECT = {
  reporterPersonId: true,
  boardOnly: true,
  type: { select: { handledBy: true } },
} as const;

/**
 * Whether this viewer may be served this file as a file on an issue, and how;
 * `undefined` when the file is on no issue, which leaves it to the file's own
 * capability.
 *
 * A file is on an issue in one of two ways, and they are read by different
 * people.
 *
 * - **A photograph** (`IssuePhoto`), which the reporter attached: read by
 *   whoever handles the issue, and by its reporter.
 * - **A handler's file** (`IssueAttachment`): read by whoever handles the
 *   issue and by nobody else. Its reporter is refused it as a stranger is,
 *   which is why it is a join of its own (decision 18).
 *
 * "Whoever handles the issue" is `issues:handle` narrowed by the board-only
 * rule (ADR 0054), asked on every request. The queue leaving a hidden issue's
 * files out is not what keeps them from a reader. An address read while the
 * issue was open to every handler stays in a browser's history, and the board
 * handing the type to itself, or keeping one issue to itself, has to close
 * that address as it closes the issue.
 *
 * A support session holds no `issues:handle` and reported nothing (ADR 0028),
 * so it is answered null.
 *
 * @param now Taken once by the caller, so one request cannot see two boards.
 */
export async function issueFileAccess(
  db: FeedDbClient,
  fileId: string,
  viewer: Principal,
  now: Date,
): Promise<IssueFileAccess | undefined> {
  const [photos, attachment] = await Promise.all([
    db.issuePhoto.findMany({
      where: { fileId },
      select: { issue: { select: ISSUE_ACCESS_SELECT } },
    }),
    db.issueAttachment.findUnique({
      where: { fileId },
      select: { issue: { select: ISSUE_ACCESS_SELECT } },
    }),
  ]);
  const issues = [...photos, ...(attachment === null ? [] : [attachment])].map(
    (row) => row.issue,
  );
  if (issues.length === 0) {
    return undefined;
  }
  if (viewer.supportSessionId !== undefined) {
    return null;
  }

  if (viewer.capabilities.has("issues:handle")) {
    const scope = await issueReaderScope(db, viewer.personId, now);
    if (issues.every((issue) => scopeHandlesIssue(scope, issue))) {
      return "handler";
    }
  }
  // A handler's file is never the reporter's to read, whoever reported.
  return attachment === null &&
    issues.every((issue) => issue.reporterPersonId === viewer.personId)
    ? "reporter"
    : null;
}
