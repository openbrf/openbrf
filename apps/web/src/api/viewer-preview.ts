import type {
  AudienceKind,
  AudienceListView,
  AuthorView,
  FeedPage,
  FeedUpdate,
  PostCommentView,
  PostView,
} from "@openbrf/shared";

import type { ApiResult } from "./client";
import type { Viewer } from "./instance";
import type { ReportableIssueType } from "./issues";
import type { NewsComment, NewsCommentAuthor } from "./news-reader";

/**
 * The resident preview (ADR 0049): the application as a resident sees it, for
 * somebody who sees more.
 *
 * A board member reads the house's pages the way everybody who lives here does
 * only by asking somebody else what they see, so the client can narrow what it
 * offers to a resident's and a member's grants instead. Presentation only: the
 * server answers every request on the account's own capabilities, the preview
 * is never sent to it, and nothing here may be read as a grant or a denial.
 *
 * The state lives in this module rather than in a component, because the place
 * it bites is {@link fetchViewer}, which every screen calls for itself: each of
 * them then reads the narrowed list without knowing a preview exists. The tab's
 * session storage keeps it across a reload of the page and forgets it with the
 * tab; the server and the device's other storage never see it.
 */

/**
 * What a resident and a member are granted: the client's copy of the server's
 * `RESIDENT_CAPABILITIES` and `MEMBER_CAPABILITIES`
 * (`apps/api/src/authorization/capabilities.ts`).
 *
 * A copy, like every capability string a screen asks about, because the web
 * application reaches the API over HTTP only. `capabilities.spec.ts` in the API
 * reads this list from its source and compares it with what `capabilitiesFor`
 * grants a resident who is a member, so a grant added on one side and not the
 * other fails there; spec 49 compares what the preview offers with what a
 * member is offered.
 */
export const RESIDENT_PREVIEW_CAPABILITIES: readonly string[] = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
  "motions:submit",
  "sublets:apply",
];

/** Held by every account, so it says nothing about living here. */
const OWN_ACCOUNT = "self:manage";

/**
 * Whether an account with these capabilities is offered the preview.
 *
 * It sees more than a resident, and it holds something a resident holds beyond
 * its own account, so the preview has a resident's application to show. The
 * external property manager holds the issue queue and their own account and
 * nothing a resident does, and is never offered it; a resident has nothing
 * more to take away.
 *
 * The capabilities say nothing about where somebody lives, so this is not
 * "lives here": a board member without a home here is offered it as well, and
 * the administrator, whose grant holds every grantable capability. What either
 * of them sees is still exactly a resident's offer.
 */
export function offersResidentPreview(
  capabilities: readonly string[],
): boolean {
  return (
    capabilities.some(
      (capability) => !RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    ) &&
    capabilities.some(
      (capability) =>
        capability !== OWN_ACCOUNT &&
        RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    )
  );
}

/** The viewer with only the capabilities a resident and a member are granted. */
export function previewed(viewer: Viewer): Viewer {
  return {
    ...viewer,
    capabilities: viewer.capabilities.filter((capability) =>
      RESIDENT_PREVIEW_CAPABILITIES.includes(capability),
    ),
  };
}

/** Where the preview stands. A new object on every change, never mutated. */
export interface ResidentPreview {
  /** Whether the application is shown as a resident sees it. */
  on: boolean;
  /**
   * Whether the signed-in account is offered the preview, once its viewer has
   * been read; false until then.
   */
  offered: boolean;
  /**
   * The page that ended the preview by being one of the board's, while the
   * reader is still on it; null otherwise.
   */
  endedOn: string | null;
  /**
   * Counts the times the preview was switched from the band. The screens read
   * the viewer once, when they mount, so the frame mounts them again under a
   * new count and they read it as the preview now has it.
   */
  generation: number;
}

/** The tab's session storage key, and the one value it is ever set to. */
const STORAGE_KEY = "openbrf.preview";
const RESIDENT = "resident";

/**
 * Storage may be refused - a browser in a private mode, a sandboxed frame - and
 * the preview then lasts until the page is reloaded rather than failing.
 */
function stored(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) === RESIDENT;
  } catch {
    return false;
  }
}

function store(on: boolean): void {
  try {
    if (on) {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, RESIDENT);
    } else {
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    }
  } catch {
    // As above: the state in memory is still right for this page.
  }
}

let state: ResidentPreview = {
  on: stored(),
  offered: false,
  endedOn: null,
  generation: 0,
};
const listeners = new Set<() => void>();

function update(next: Partial<ResidentPreview>): void {
  const changed = (Object.keys(next) as (keyof ResidentPreview)[]).some(
    (key) => next[key] !== state[key],
  );
  if (!changed) {
    return;
  }
  if (next.on !== undefined && next.on !== state.on) {
    store(next.on);
  }
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
}

/** The preview as it stands, for `useSyncExternalStore`. */
export function residentPreview(): ResidentPreview {
  return state;
}

/** Calls the listener on every change; returns how to stop. */
export function subscribeToResidentPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Switches the preview on or off from the band or the sheet.
 *
 * `remount` false leaves the page as it is, for a switch that navigates
 * anyway: the next page mounts and reads the viewer for itself.
 */
export function setResidentPreview(
  on: boolean,
  { remount = true }: { remount?: boolean } = {},
): void {
  if (on === state.on) {
    return;
  }
  update({
    on,
    endedOn: null,
    generation: remount ? state.generation + 1 : state.generation,
  });
}

/**
 * Ends the preview because the page at this path is one of the board's, and
 * remembers the page so it can say why.
 *
 * Nothing is mounted again: the board's page is mounting anyway, and reads the
 * viewer after this.
 */
export function endResidentPreviewOn(pathname: string): void {
  if (state.on) {
    update({ on: false, endedOn: pathname });
  }
}

/** Forgets why the preview ended, once the reader has left that page. */
export function leftPageAfterResidentPreview(pathname: string): void {
  if (state.endedOn !== null && state.endedOn !== pathname) {
    update({ endedOn: null });
  }
}

/**
 * The person the preview is shown to, recorded when the viewer is read: a
 * resident's answer about a post or a comment turns on whether they wrote it.
 * Null until then, and nothing counts as theirs while it is, so a read before
 * it withholds more rather than less. Not part of {@link ResidentPreview}: it
 * changes nothing a screen shows of the preview itself.
 */
let reader: string | null = null;

/** Ends the preview and forgets the account it was offered to, for a sign-in. */
export function forgetResidentPreview(): void {
  reader = null;
  update({ on: false, offered: false, endedOn: null });
}

/**
 * The viewer as the screens are to see it.
 *
 * Records whether this account is offered the preview, and narrows the viewer
 * while the preview is on for an account that is. A preview left on in the tab
 * by an account that is no longer the one signed in, and that this one is not
 * offered, is switched off rather than applied: nobody could see that it was on,
 * and nothing would say why the page had less on it.
 */
export function asPreviewed(viewer: Viewer): Viewer {
  const offered = offersResidentPreview(viewer.capabilities);
  reader = viewer.personId;
  update(offered ? { offered } : { offered, on: false });
  return state.on ? previewed(viewer) : viewer;
}

/**
 * The audiences a resident is in: Alla and the groups they are written into.
 * Styrelsen and Administratörer are the board's, so a preview leaves them out.
 */
const RESIDENT_AUDIENCES: readonly AudienceKind[] = ["ALL", "GROUP"];

/**
 * The audiences a resident reads, and no board identity to write in: the list
 * as the screens are to see it while the preview is on.
 *
 * Presentation only, like the viewer's capabilities: the server still answers
 * for every audience the account is in, and the preview never reaches it.
 */
export function previewedAudienceList(
  list: AudienceListView,
): AudienceListView {
  return {
    ...list,
    audiences: list.audiences.filter((audience) =>
      RESIDENT_AUDIENCES.includes(audience.kind),
    ),
    mayPostAsBoard: false,
  };
}

/** Whether a post is in an audience a resident is in. */
export function inResidentAudience(post: PostView): boolean {
  return RESIDENT_AUDIENCES.includes(post.audience.kind);
}

/**
 * The answer as a screen is to see it: narrowed to a resident's while the
 * resident preview is on, and the server's own otherwise. A refusal passes on
 * as it came.
 *
 * Every read and every write whose answer the server shapes for the board's
 * seat goes through here - in the feed, under the news and in the issue report
 * form - so what only the board is shown stays out of the preview wherever the
 * screen got it from.
 */
export async function previewing<T>(
  answer: Promise<ApiResult<T>>,
  narrow: (value: T) => T,
): Promise<ApiResult<T>> {
  const result = await answer;
  return result.ok && state.on
    ? { ...result, value: narrow(result.value) }
    : result;
}

/** Whether the person the preview is shown to wrote what this author wrote. */
function writtenByReader(
  author: AuthorView | NewsCommentAuthor | null,
): boolean {
  return (
    reader !== null &&
    author !== null &&
    author.kind !== "unknown" &&
    author.personId === reader
  );
}

/**
 * A post as a resident who is this person is shown it.
 *
 * The server answers the board's seat: it opens a struck post's text and
 * images, an edited post's earlier versions and an important post's must-read
 * list to the board, lets it strike a resident's post in Alla through and make
 * an issue report from anybody's post, and shows an issue report's status to
 * whoever handles issues. A resident has each of these only for what they wrote
 * or reported themselves (`feed.service.ts`), so the preview takes the rest
 * back. It only ever narrows: what the server answered false stays false, and
 * the report to the board, which the server refuses the board in Alla, is not
 * offered where the strike was.
 */
export function previewedPost(post: PostView): PostView {
  const own = writtenByReader(post.author);
  const withheld = post.struckAt !== null && !own;
  return {
    ...post,
    body: withheld ? null : post.body,
    images: withheld ? [] : post.images,
    issue: post.issue?.reportedByReader === true ? post.issue : null,
    mayReportIssue: post.mayReportIssue && own,
    mayReadHistory: post.mayReadHistory && own,
    mayListNotRead: false,
    mayStrike: false,
  };
}

/**
 * A comment as a resident who is this person is shown it: a struck comment's
 * text and an edited one's earlier versions only when they wrote it, and no
 * strike-through (`post-comment.service.ts`). As with a post, the report to the
 * board stays as the server answered it.
 */
export function previewedComment(comment: PostCommentView): PostCommentView {
  const own = writtenByReader(comment.author);
  return {
    ...comment,
    body: comment.struckAt !== null && !own ? null : comment.body,
    mayReadHistory: comment.mayReadHistory && own,
    mayStrike: false,
  };
}

/**
 * A page of the feed as a resident reads it: without the posts of Styrelsen
 * and Administratörer, and without the board's posts that wait for their
 * instant, which are written for somebody who may write as Styrelsen; each
 * post that stays, the board's published news in Alla among them, as
 * {@link previewedPost} shows it.
 *
 * The cursors are the server's and stay as they came: a page with fewer posts
 * than it was asked for still says where the next one starts.
 */
export function previewedPage(page: FeedPage): FeedPage {
  return {
    ...page,
    pinned: page.pinned.filter(inResidentAudience).map(previewedPost),
    scheduled: [],
    posts: page.posts.filter(inResidentAudience).map(previewedPost),
  };
}

/**
 * What the poll brought, as a resident reads it: without the posts of
 * Styrelsen and Administratörer, and each that stays as {@link previewedPost}
 * shows it.
 */
export function previewedUpdate(update: FeedUpdate): FeedUpdate {
  return {
    ...update,
    posts: update.posts.filter(inResidentAudience).map(previewedPost),
  };
}

/**
 * A page of comments, or what a thread's poll brought, with each comment as
 * {@link previewedComment} shows it. The cursors stay the server's.
 */
export function previewedComments<
  T extends { comments: readonly PostCommentView[] },
>(page: T): T {
  return { ...page, comments: page.comments.map(previewedComment) };
}

/**
 * A comment under the news as a resident who is this person is shown it: a
 * struck comment's text only when they wrote it. The server opens it to the
 * board's `site:manage` as well (`news-comment.service.ts`); the strike-through
 * itself is offered on that capability, which the previewed viewer no longer
 * holds.
 */
export function previewedNewsComment(comment: NewsComment): NewsComment {
  return comment.hiddenAt !== null && !writtenByReader(comment.author)
    ? { ...comment, body: null }
    : comment;
}

/**
 * A page of the thread under a news item, with each comment as
 * {@link previewedNewsComment} shows it. The cursor stays the server's.
 */
export function previewedNewsComments<
  T extends { comments: readonly NewsComment[] },
>(page: T): T {
  return { ...page, comments: page.comments.map(previewedNewsComment) };
}

/**
 * The issue types a resident is offered: without the board's internal ones,
 * which the server offers whoever handles issues (`issue-audience.ts`). What
 * stays is what the account's residency gives it, a member's types for somebody
 * who lives here and a non-member's otherwise, as the server answered it.
 */
export function previewedIssueTypes(
  types: readonly ReportableIssueType[],
): ReportableIssueType[] {
  return types.filter((type) => type.audience !== "BOARD");
}
