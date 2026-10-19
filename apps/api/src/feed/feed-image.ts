import type { Principal } from "../authorization/capabilities";
import { type FeedDbClient, postFor } from "./feed-audience";
import { answersReports, isReportedToBoard } from "./post-report-access";

/**
 * Images on a post (bilder i ett inlägg), and the one question about them that
 * is asked outside the feed.
 *
 * An image is served by the media route, which knows nothing about audiences,
 * and a file held POST is decided there by asking this. It is a plain function
 * rather than a method on a service, so the media layer can ask it without the
 * feed's module and the media module importing each other: the feed uploads
 * through the media service, and the media service asks the feed this.
 */

/**
 * How many images one post may carry.
 *
 * A few photographs of what somebody is writing about - the broken lock, the
 * flooded bicycle room - and not an album. Bounded because each one is a file
 * in storage that the purge has to find again, and because a post of forty
 * pictures is a gallery the feed is not.
 */
export const MAX_IMAGES_PER_POST = 4;

/**
 * How long an upload may wait for the post it was made for.
 *
 * The composer uploads each picture as it is chosen and writes the post when
 * the writer presses the button, so an upload is on no post for as long as
 * somebody takes to finish typing - minutes, and a day at the very outside.
 * One older than this is refused rather than attached; see
 * {@link UNATTACHED_IMAGE_HOURS} for why that matters.
 */
export const ATTACHABLE_HOURS = 24;

/**
 * When an upload that never made it onto a post is removed.
 *
 * Twice {@link ATTACHABLE_HOURS}, and the gap is the point. The nightly purge
 * removes these files, and a write attaching one at the same moment would
 * otherwise race it: the purge's delete would cascade through a row the write
 * had just committed, and the post would lose its picture after its writer was
 * told it was stored. A file old enough to be swept is a day past the age at
 * which a write would take it, so the two never want the same file.
 */
export const UNATTACHED_IMAGE_HOURS = 48;

/**
 * How many images one person may upload in a day.
 *
 * Ten posts' worth of pictures. A bound on what one account can put in storage
 * rather than on how fast it writes - the post budget does that - and taken
 * from the rows before the upload rather than under a lock, because the bytes
 * are stored before a transaction could hold one. Requests sent together can
 * all pass the count, so it is a bound on disk within a request or two, not an
 * exact one; the files a burst left over are on no post and the sweep has them
 * two days later.
 */
export const UPLOADS_PER_DAY = 40;

/**
 * How a reader reaches a post's images: as somebody the post is in front of,
 * through a report the board is answering, or not at all.
 *
 * Two answers that serve the file rather than one, because the media route
 * records the second and not the first (`MediaService.open`).
 */
export type PostImageAccess = "audience" | "report" | null;

/**
 * Whether this person may be served an image on this post, and how.
 *
 * First exactly whether they may read the post (`postFor`): in its audience,
 * and the post in front of the house. Narrowed on two posts. An erased one has
 * no images left to show, and a struck one shows its images to whoever its
 * text is shown to: its author and the board. A strike-through that left the
 * pictures in front of the group would have withheld the caption and not what
 * was said.
 *
 * Then, for somebody outside the audience, the one other way in ADR 0026
 * leaves: a report. The board reaches a group's image exactly as it reaches
 * the group's post - somebody inside carried the post out, the report is open,
 * and this account answers reports (`post-report-access.ts`, the rule the
 * queue reads the post's text by). It opens that post's images and nothing
 * else: not the post before it, and not once the board has answered.
 *
 * Everybody else - an outsider, the administrator, the board outside a report
 * - is answered null, and the media route turns null into the same not-found
 * as a file that does not exist, so a group's image is refused by its address
 * as the group's post is by its identifier.
 */
export async function postImageAccess(
  db: FeedDbClient,
  postId: string,
  viewer: Principal,
  now: Date,
): Promise<PostImageAccess> {
  const post = await postFor(db, postId, viewer.personId, now);
  if (post === null) {
    return (await answersReports(db, viewer, now)) &&
      (await isReportedToBoard(db, postId))
      ? "report"
      : null;
  }
  if (post.erasedAt !== null) {
    return null;
  }
  if (post.struckAt === null || post.authorPersonId === viewer.personId) {
    return "audience";
  }
  return (await answersReports(db, viewer, now)) ? "audience" : null;
}
