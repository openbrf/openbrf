import type { Principal } from "../authorization/capabilities";
import type { FeedDbClient } from "../feed/feed-audience";
import { issueReaderScope, scopeHandlesIssue } from "./issue-handlers";

/**
 * How a viewer reaches a photograph on an issue: as somebody who handles the
 * issue, as the person who reported it, or not at all.
 *
 * Two answers that serve the file rather than one, because the media route
 * records the first and not the second (`MediaService.open`).
 */
export type IssuePhotoAccess = "handler" | "reporter" | null;

/**
 * Whether this viewer may be served this file as a photograph on an issue, and
 * how; `undefined` when the file is on no issue, which leaves it to the file's
 * own capability.
 *
 * The photograph is read by the rule its issue is read by, asked on every
 * request: whoever holds `issues:handle` and handles the issue under the
 * board-only rule (ADR 0054), and its reporter. The queue leaving a hidden
 * issue's photographs out is not what keeps them from a reader. An address
 * read while the issue was open to every handler stays in a browser's history,
 * and the board handing the type to itself, or keeping one issue to itself,
 * has to close that address as it closes the issue.
 *
 * A support session holds no `issues:handle` and reported nothing (ADR 0028),
 * so it is answered null.
 *
 * @param now Taken once by the caller, so one request cannot see two boards.
 */
export async function issuePhotoAccess(
  db: FeedDbClient,
  fileId: string,
  viewer: Principal,
  now: Date,
): Promise<IssuePhotoAccess | undefined> {
  const photos = await db.issuePhoto.findMany({
    where: { fileId },
    select: {
      issue: {
        select: {
          reporterPersonId: true,
          boardOnly: true,
          type: { select: { handledBy: true } },
        },
      },
    },
  });
  if (photos.length === 0) {
    return undefined;
  }
  if (viewer.supportSessionId !== undefined) {
    return null;
  }

  if (viewer.capabilities.has("issues:handle")) {
    const scope = await issueReaderScope(db, viewer.personId, now);
    if (photos.every(({ issue }) => scopeHandlesIssue(scope, issue))) {
      return "handler";
    }
  }
  return photos.every(({ issue }) => issue.reporterPersonId === viewer.personId)
    ? "reporter"
    : null;
}
