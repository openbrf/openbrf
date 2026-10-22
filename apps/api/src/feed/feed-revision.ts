import type { RevisionView } from "@openbrf/shared";

import { FeedError } from "./feed.error";

/**
 * Edit with history (ADR 0026): what a post and a comment keep of what they
 * said before an edit, and on what terms.
 *
 * An edit never overwrites. The text that stood goes into the post's or the
 * comment's history (`PostRevision`, `PostCommentRevision`) with the instant it
 * was written and the instant it was replaced, and the history goes with its
 * post or comment - by cascade when the row is deleted, and by the purge when a
 * post is erased (`FeedPurgeService`). The rules for posts and comments are one
 * rule, so they live here rather than in each service.
 */

/**
 * How many earlier versions one post or one comment keeps.
 *
 * The history is a record of what was said, so nothing in it is ever dropped to
 * make room: an edit past this many is refused rather than one taken off the
 * end. Twenty is more than anybody correcting a typo or adding the time of the
 * meeting needs, and it bounds what one post can grow into - a post's text is
 * bounded, its writes are counted, and without this its edits would be
 * neither.
 */
export const MAX_REVISIONS = 20;

/** One earlier version, as the wire carries it. */
export function revisionView(revision: {
  body: string;
  writtenAt: Date;
  replacedAt: Date;
}): RevisionView {
  return {
    body: revision.body,
    writtenAt: revision.writtenAt.toISOString(),
    replacedAt: revision.replacedAt.toISOString(),
  };
}

/**
 * Refuses an edit of a post or a comment that already keeps
 * {@link MAX_REVISIONS} earlier versions.
 */
export function refuseFullHistory(kept: number): void {
  if (kept >= MAX_REVISIONS) {
    throw new FeedError(
      "This has been edited as many times as it may be.",
      "too-many-edits",
    );
  }
}
