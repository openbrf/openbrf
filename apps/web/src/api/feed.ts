import type {
  AudienceListView,
  CreatedGroupView,
  FeedFrom,
  FeedPage,
  FeedUpdate,
  GroupCandidateView,
  GroupMemberView,
  LikeView,
  NotReadView,
  PostCommentPage,
  PostCommentUpdate,
  PostCommentView,
  PostImageView,
  PostReadView,
  PostReportQueueView,
  PostReportView,
  PostView,
  RevisionListView,
} from "@openbrf/shared";

import { apiRequest, apiUpload, type ApiResult } from "./client";

/**
 * The feed (flödet), as the screen reads and writes it.
 *
 * The wire types are the API's own, imported from `@openbrf/shared` rather than
 * mirrored here: a hand-kept copy drifted the way copies do, and a declaration
 * both ends import cannot. Every answer is passed on in the API's own shape -
 * the feed is newest first on the wire and on the screen, so nothing here is
 * turned round or regrouped.
 *
 * Four properties of the contract are load-bearing and none of them is visible
 * in the types, so they are written down here.
 *
 * **Which audiences exist is the server's answer, and an empty list is an
 * answer.** The capability opens these endpoints; membership decides what is in
 * them, and the two are separate questions. The administrator holds every
 * capability, no board seat and no residency, so they reach every route here and
 * are answered with no audiences and no way to make a group. That is not a
 * failure and the screen must not render it as one.
 *
 * **A group is invisible from outside, and this client must not undo that.**
 * There is no call here that lists groups and none that reads one this account
 * is not in: an audience, a post or an image it may not read is refused exactly
 * as one that does not exist. The board reaches a group only through a post
 * somebody inside it reported, which is `fetchReports` and carries one post each
 * time - never the group.
 *
 * **Nothing is ever put on the feed by the browser.** A post reaches a screen
 * because a read brought it, which is what makes the poll the one delivery path
 * rather than a second opinion about one. The same holds for a comment: writing
 * one is followed by reading the thread.
 *
 * **A cursor goes back exactly as it arrived.** What one holds is the API's
 * business, and a value this client composed for itself is answered with a
 * refusal rather than a page.
 */

/**
 * What narrows a read of the feed. Each one only ever narrows, and none reaches
 * a post outside the reader's own audiences: the server applies them inside
 * those, so a filter here is a question rather than a way in.
 */
export interface FeedFilter {
  /** One audience, or null for every audience this account is in. */
  audienceId: string | null;
  /** Words a post has to contain, or the empty string for none. */
  search: string;
  /** Posts written as Styrelsen, or by neighbours as themselves, or null. */
  from: FeedFrom | null;
  /** Only posts the board marked important. */
  important: boolean;
}

/** The filter that narrows nothing: the whole feed, as somebody opens it. */
export const WHOLE_FEED: FeedFilter = {
  audienceId: null,
  search: "",
  from: null,
  important: false,
};

/** The query a filter is asked as, leaving out everything that narrows nothing. */
function filterQuery(filter: FeedFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.audienceId !== null) {
    query.set("audience", filter.audienceId);
  }
  const search = filter.search.trim();
  if (search !== "") {
    query.set("q", search);
  }
  if (filter.from !== null) {
    query.set("from", filter.from);
  }
  if (filter.important) {
    query.set("important", "true");
  }
  return query;
}

/**
 * The audiences this account is in, and whether it may make a group.
 *
 * An empty list is the answer for somebody holding the capability and no
 * audience, and the screen says so in words rather than rendering an empty feed.
 * The two empty cases are different sentences - somebody who lives here has a
 * form in front of them and the administrator has none - which is why the answer
 * carries the second half.
 */
export function fetchAudiences(): Promise<ApiResult<AudienceListView>> {
  return apiRequest("GET", "/api/feed/audiences");
}

/**
 * One page of the feed, newest first, with the pinned posts beside it on the
 * first page.
 *
 * `before` is a cursor this API handed out, or null for the newest page.
 * `earlier` is the whole of the answer to "is there more behind this", so a
 * screen never infers it from a page that came back full; `latest` is where the
 * poll starts, and null while nothing matches.
 */
export function readFeed(input: {
  filter: FeedFilter;
  before: string | null;
}): Promise<ApiResult<FeedPage>> {
  const query = filterQuery(input.filter);
  if (input.before !== null) {
    query.set("before", input.before);
  }
  const asked = query.toString();
  return apiRequest("GET", `/api/feed/posts${asked === "" ? "" : `?${asked}`}`);
}

/**
 * What has been posted since a cursor, oldest first, under the same filter. The
 * one delivery path.
 */
export function postsSince(input: {
  filter: FeedFilter;
  after: string;
}): Promise<ApiResult<FeedUpdate>> {
  const query = filterQuery(input.filter);
  query.set("after", input.after);
  return apiRequest("GET", `/api/feed/posts/since?${query.toString()}`);
}

/**
 * One post, which is what a post's own address opens.
 *
 * Refused exactly as a post that does not exist when it is in an audience this
 * account is not in, so a link pasted to somebody outside a group says nothing
 * about the group to them.
 */
export function fetchPost(input: {
  postId: string;
}): Promise<ApiResult<PostView>> {
  return apiRequest(
    "GET",
    `/api/feed/posts/${encodeURIComponent(input.postId)}`,
  );
}

/**
 * Uploads one image for a post that is about to be written.
 *
 * The image is on no post until the post is written with its identifier, and
 * until then it is served to nobody: the composer shows the writer the file they
 * picked rather than this upload. One left behind by a composer that was closed
 * is swept by the server.
 */
export function uploadPostImage(input: {
  file: File;
}): Promise<ApiResult<PostImageView>> {
  return apiUpload("POST", "/api/feed/images", input.file);
}

/** Writes a post for one audience, with the images uploaded for it, and answers with it. */
export function writePost(input: {
  audienceId: string;
  body: string;
  imageIds: readonly string[];
}): Promise<ApiResult<PostView>> {
  return apiRequest("POST", "/api/feed/posts", {
    audienceId: input.audienceId,
    body: input.body,
    ...(input.imageIds.length === 0 ? {} : { imageIds: [...input.imageIds] }),
  });
}

/**
 * What the board writes as Styrelsen: a news item, published to the members -
 * or to the street, when `onWebsite` - at once or at `scheduledAt`.
 *
 * The server decides whether this account may, on every write, from the
 * register. A composer offers it where `mayPostAsBoard` said so; an account it
 * refuses is told `not-board` whatever the composer showed.
 */
export interface BoardPostDraft {
  /**
   * Alla, Styrelsen or Administratörer, never a group. To Alla it is the
   * house's news item; to the other two it is that audience's alone.
   */
  audienceId: string;
  title: string;
  body: string;
  imageIds: readonly string[];
  /** "Styrelsen via" the writer, or only "Styrelsen". */
  namesAuthor: boolean;
  /** Viktigt meddelande, which sends the news mailing. */
  important: boolean;
  pinned: boolean;
  commentsAllowed: boolean;
  /** An ISO instant ahead, or null to publish now. */
  scheduledAt: string | null;
  onWebsite: boolean;
}

/** Writes a post as Styrelsen, and answers with it as its writer is shown it. */
export function writeBoardPost(
  input: BoardPostDraft,
): Promise<ApiResult<PostView>> {
  return apiRequest("POST", "/api/feed/board-posts", {
    ...input,
    imageIds: [...input.imageIds],
  });
}

/**
 * Withdraws a post the board scheduled as Styrelsen, while it still waits: before
 * its instant, or after it when the job left it a draft because its writer no
 * longer speaks for the board.
 *
 * Its news item has never been published, so nobody but the board has seen it,
 * and it goes as if it had never been written. Once the job has published it -
 * or a board member has, on the news screen - it is refused with
 * `not-scheduled`: what the house has read is not taken back here.
 */
export function withdrawBoardPost(input: {
  postId: string;
}): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/feed/board-posts/${encodeURIComponent(input.postId)}`,
  );
}

/**
 * Edits the text of a post this account wrote as itself, and answers with the
 * post as it stands now.
 *
 * The text it replaces is kept as an earlier version, which its author and the
 * board can read; the house reads what stands, marked as edited. Refused with
 * `not-editable` for somebody else's post, a post written as Styrelsen, and one
 * the board struck through.
 */
export function editPost(input: {
  postId: string;
  body: string;
}): Promise<ApiResult<PostView>> {
  return apiRequest(
    "PATCH",
    `/api/feed/posts/${encodeURIComponent(input.postId)}`,
    { body: input.body },
  );
}

/**
 * A post's earlier versions, the most recently replaced first: for its author
 * and for the board, and refused with `history-withheld` for anybody else.
 */
export function fetchPostRevisions(input: {
  postId: string;
}): Promise<ApiResult<RevisionListView>> {
  return apiRequest(
    "GET",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/revisions`,
  );
}

/**
 * Who in an important post's audience has not opened it yet: the board's
 * must-read list. Refused with `not-board` for anybody else, who sees the count,
 * and with `not-important` for a post the board did not mark important.
 */
export function fetchNotRead(input: {
  postId: string;
}): Promise<ApiResult<NotReadView>> {
  return apiRequest(
    "GET",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/not-read`,
  );
}

/** Pins a post written as Styrelsen on top of the feed, or takes the pin off. */
export function pinPost(input: {
  postId: string;
  pinned: boolean;
}): Promise<ApiResult<PostView>> {
  return apiRequest(
    input.pinned ? "PUT" : "DELETE",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/pin`,
  );
}

/**
 * Records that this account has seen a post, and answers how many have ("Läst
 * av N"). Written once on the server: seeing a post twice is having read it once.
 */
export function markPostRead(input: {
  postId: string;
}): Promise<ApiResult<PostReadView>> {
  return apiRequest(
    "POST",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/read`,
  );
}

/**
 * Records how far this person has read an audience.
 *
 * `readAt` is the instant of the newest post actually on screen rather than the
 * moment of the call: an audience marked read at "now" would mark a post read
 * that was written while the request was in flight and that nobody has seen.
 * The marker never moves backwards, so two tabs cannot un-read each other.
 */
export function markAudienceRead(input: {
  audienceId: string;
  readAt: string;
}): Promise<ApiResult<{ readAt: string }>> {
  return apiRequest(
    "POST",
    `/api/feed/audiences/${encodeURIComponent(input.audienceId)}/read`,
    { readAt: input.readAt },
  );
}

/** Likes a post, or takes the like back, and answers with the count as it stands. */
export function likePost(input: {
  postId: string;
  liked: boolean;
}): Promise<ApiResult<LikeView>> {
  return apiRequest(
    input.liked ? "PUT" : "DELETE",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/like`,
  );
}

/**
 * One page of a post's comments, oldest first within the page.
 *
 * `before` is a cursor this API handed out, or null for the newest page - so a
 * long thread opens where the conversation is, and the comments before that
 * page are a press away.
 */
export function readComments(input: {
  postId: string;
  before: string | null;
}): Promise<ApiResult<PostCommentPage>> {
  const suffix =
    input.before === null
      ? ""
      : `?${new URLSearchParams({ before: input.before }).toString()}`;
  return apiRequest(
    "GET",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/comments${suffix}`,
  );
}

/**
 * What has been written under a post since a cursor, oldest first: the poll of
 * an open thread, and the read after the reader writes one. `cursor` is where
 * to ask from next, and `more` says a page was not enough.
 */
export function commentsSince(input: {
  postId: string;
  after: string;
}): Promise<ApiResult<PostCommentUpdate>> {
  return apiRequest(
    "GET",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/comments/since?${new URLSearchParams({ after: input.after }).toString()}`,
  );
}

/**
 * Writes a comment under a post, and answers with it. `asBoard` answers as
 * Styrelsen, which the server allows a board seat holder under a post in Alla,
 * Styrelsen or Administratörer.
 */
export function writeComment(input: {
  postId: string;
  body: string;
  asBoard?: boolean;
}): Promise<ApiResult<PostCommentView>> {
  return apiRequest(
    "POST",
    `/api/feed/posts/${encodeURIComponent(input.postId)}/comments`,
    {
      body: input.body,
      ...(input.asBoard === true ? { asBoard: true } : {}),
    },
  );
}

/**
 * Edits the text of a comment this account wrote, and answers with the comment
 * as it stands now. The text it replaces is kept as an earlier version, as a
 * post's is.
 */
export function editComment(input: {
  commentId: string;
  body: string;
}): Promise<ApiResult<PostCommentView>> {
  return apiRequest(
    "PATCH",
    `/api/feed/comments/${encodeURIComponent(input.commentId)}`,
    { body: input.body },
  );
}

/** A comment's earlier versions, for its author and for the board. */
export function fetchCommentRevisions(input: {
  commentId: string;
}): Promise<ApiResult<RevisionListView>> {
  return apiRequest(
    "GET",
    `/api/feed/comments/${encodeURIComponent(input.commentId)}/revisions`,
  );
}

/** Likes a comment, or takes the like back. */
export function likeComment(input: {
  commentId: string;
  liked: boolean;
}): Promise<ApiResult<LikeView>> {
  return apiRequest(
    input.liked ? "PUT" : "DELETE",
    `/api/feed/comments/${encodeURIComponent(input.commentId)}/like`,
  );
}

/**
 * Makes a group, with this account as its first member.
 *
 * A name and nothing else. Who is in it is a second act with a record of its
 * own, because putting somebody into a private group is the thing the audit log
 * here exists for.
 */
export function createGroup(input: {
  name: string;
}): Promise<ApiResult<CreatedGroupView>> {
  return apiRequest("POST", "/api/feed/groups", { name: input.name });
}

/**
 * Who is in a group, for somebody who is in it.
 *
 * A person with protected personal data is not named here either: the group is
 * not the act of revealing that `protectedData:reveal` exists for.
 */
export function fetchGroupMembers(input: {
  audienceId: string;
}): Promise<ApiResult<GroupMemberView[]>> {
  return apiRequest(
    "GET",
    `/api/feed/groups/${encodeURIComponent(input.audienceId)}/members`,
  );
}

/**
 * Who this group could still be offered.
 *
 * People who live here and are not in it, never somebody with protected
 * personal data, bounded and searched by name.
 */
export function fetchGroupCandidates(input: {
  audienceId: string;
  search: string;
}): Promise<ApiResult<GroupCandidateView[]>> {
  const search =
    input.search.trim() === ""
      ? ""
      : `?search=${encodeURIComponent(input.search.trim())}`;
  return apiRequest(
    "GET",
    `/api/feed/groups/${encodeURIComponent(input.audienceId)}/candidates${search}`,
  );
}

/**
 * Puts somebody into a group, and answers with who is in it afterwards.
 *
 * Anybody in the group may do it. There is no counterpart that takes somebody
 * else out: what ends a place in a group against somebody's will is moving out.
 */
export function addGroupMember(input: {
  audienceId: string;
  personId: string;
}): Promise<ApiResult<GroupMemberView[]>> {
  return apiRequest(
    "POST",
    `/api/feed/groups/${encodeURIComponent(input.audienceId)}/members`,
    { personId: input.personId },
  );
}

/**
 * Leaves a group.
 *
 * Only ever this account. What was written stays in the group, attributed
 * exactly as before and on the clock it was always on.
 */
export function leaveGroup(input: {
  audienceId: string;
}): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/feed/groups/${encodeURIComponent(input.audienceId)}/members/me`,
  );
}

/**
 * Reports one post in a group to the board.
 *
 * The only thing that carries anything out of a group. It hands the board this
 * post and nothing else - not the group, not its members, not what was said
 * before it.
 */
export function reportPost(input: {
  postId: string;
  note: string;
}): Promise<ApiResult<{ reportId: string }>> {
  return apiRequest("POST", "/api/feed/reports", {
    postId: input.postId,
    ...(input.note.trim() === "" ? {} : { note: input.note.trim() }),
  });
}

/**
 * The board's queue, and whether this account may answer it.
 *
 * Holding `chat:moderate` is not the whole of it: the administrator holds every
 * capability and no board seat, and a report carries a private group's post in
 * full. So the server answers `mayModerate` from the register, and a screen
 * shown `false` says that the queue is the board's rather than that nothing has
 * been reported - which would be a claim about groups this account may not be
 * told exist.
 */
export function fetchReports(): Promise<ApiResult<PostReportQueueView>> {
  return apiRequest("GET", "/api/feed/reports");
}

/**
 * Strikes the reported post through.
 *
 * Every open report about that post is closed with it, and so it is when one is
 * dismissed: the board decides about the post rather than about one person's
 * report of it.
 *
 * The text is withheld from the other people in the group and from nobody else:
 * the post stays where it is, attributed as before, its author still reads it,
 * and nothing about the retention clock changes. There is deliberately no
 * counterpart that clears it.
 */
export function strikeReport(input: {
  reportId: string;
}): Promise<ApiResult<PostReportView>> {
  return apiRequest(
    "POST",
    `/api/feed/reports/${encodeURIComponent(input.reportId)}/strike`,
  );
}

/** Closes a report without striking anything. */
export function dismissReport(input: {
  reportId: string;
}): Promise<ApiResult<PostReportView>> {
  return apiRequest(
    "POST",
    `/api/feed/reports/${encodeURIComponent(input.reportId)}/dismiss`,
  );
}
