import type {
  AudienceListView,
  CreatedGroupView,
  FeedPage,
  FeedUpdate,
  GroupCandidateView,
  GroupMemberView,
  PostReportQueueView,
  PostReportView,
  PostView,
} from "@openbrf/shared";

import { apiRequest, type ApiResult } from "./client";

/**
 * The feed, as the chat screen reads and writes it.
 *
 * The wire types are the API's own, imported from `@openbrf/shared` rather than
 * mirrored here: a hand-kept copy drifted the way copies do, and a declaration
 * both ends import cannot.
 *
 * The screen these functions serve still thinks in rooms - one audience at a
 * time, oldest post first - and is rewritten around the feed itself later. Until
 * then this file is where the feed is turned into rooms, so the screen changes
 * as little as possible: Alla is left out of the list, and a page is turned to
 * read oldest first. Nothing else is adapted; every other answer is the API's
 * own shape.
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
 * is not in: an audience it is not in is refused exactly as an audience that
 * does not exist. The board reaches a group only through a post somebody inside
 * it reported, which is `fetchChatReports` and carries one post each time -
 * never the group.
 *
 * **Nothing is ever appended by the browser.** A post reaches a screen because
 * a read brought it, which is what makes the poll the one delivery path rather
 * than a second opinion about one. The answer to a write is one post and the
 * audience is the whole of it, so a list assembled from both is a list nothing
 * on the server ever said.
 *
 * **A cursor goes back exactly as it arrived.** What one holds is the API's
 * business, and a value this client composed for itself is answered with a
 * refusal rather than a page.
 *
 * **Nothing here is ever published.** The association's website reads no session
 * at all, so there is no public reader for the feed; there is no route that
 * renders one publicly and there is not going to be one.
 */

/**
 * One page of one audience, oldest first inside the page.
 *
 * The API answers a page newest first, because that is how the feed reads. The
 * room screen reads a conversation downwards, so `readChat` turns the page
 * round, and this is the shape it hands over.
 *
 * `earlier` is the whole of the answer to "is there more behind this": the
 * cursor to hand back for the page before this one, or null at the start of the
 * audience. So a screen never infers it from a page that came back full.
 *
 * `latest` is where the poll starts. Null while the audience is empty.
 */
export interface AudiencePage {
  /** The posts on this page, oldest first. */
  posts: PostView[];
  earlier: string | null;
  latest: string | null;
}

/**
 * The audiences this account is in, and whether it may make a group.
 *
 * Alla is left out. It has no place on the room screen, which is a list of
 * closed rooms with a write box under each, and it arrives with the screen that
 * reads the feed as a feed.
 *
 * An empty list is the answer for somebody holding the capability and no
 * audience, and the screen says so in words rather than rendering an empty room.
 * The two empty cases are different sentences - somebody who lives here has a
 * form in front of them and the administrator has none - which is why the answer
 * carries the second half.
 */
export async function fetchChats(): Promise<ApiResult<AudienceListView>> {
  const result = await apiRequest<AudienceListView>(
    "GET",
    "/api/feed/audiences",
  );
  return result.ok
    ? {
        ok: true,
        value: {
          ...result.value,
          audiences: result.value.audiences.filter(
            (audience) => audience.kind !== "ALL",
          ),
        },
      }
    : result;
}

/**
 * One page of an audience, oldest first inside the page.
 *
 * `before` is a cursor this API handed out, or null for the newest page.
 *
 * Pinned posts come back beside the page rather than in it, and on the first
 * page only. Nothing pins a post in a group or in Styrelsen yet; should one be,
 * it is put among the page's posts by when it was written rather than dropped,
 * so the room screen never loses a post the API sent it.
 */
export async function readChat(input: {
  audienceId: string;
  before: string | null;
}): Promise<ApiResult<AudiencePage>> {
  const query = new URLSearchParams({ audience: input.audienceId });
  if (input.before !== null) {
    query.set("before", input.before);
  }
  const result = await apiRequest<FeedPage>(
    "GET",
    `/api/feed/posts?${query.toString()}`,
  );
  if (!result.ok) {
    return result;
  }
  const page = result.value;
  return {
    ok: true,
    value: {
      // Reversed rather than sorted while nothing is pinned, so the order is
      // exactly the one the API's cursor walks and no second opinion about it.
      posts:
        page.pinned.length === 0
          ? [...page.posts].reverse()
          : [...page.pinned, ...page.posts].sort(byWritingOrder),
      earlier: page.earlier,
      latest: page.latest,
    },
  };
}

/**
 * What has been written in an audience since a cursor, oldest first. The one
 * delivery path.
 */
export function messagesSince(input: {
  audienceId: string;
  after: string;
}): Promise<ApiResult<FeedUpdate>> {
  const query = new URLSearchParams({
    audience: input.audienceId,
    after: input.after,
  });
  return apiRequest("GET", `/api/feed/posts/since?${query.toString()}`);
}

/** Writes a post for one audience, and answers with it. */
export function writeMessage(input: {
  audienceId: string;
  body: string;
}): Promise<ApiResult<PostView>> {
  return apiRequest("POST", "/api/feed/posts", {
    audienceId: input.audienceId,
    body: input.body,
  });
}

/**
 * Records how far this person has read an audience.
 *
 * `readAt` is the instant of the newest post actually on screen rather than the
 * moment of the call: an audience marked read at "now" would mark a post read
 * that was written while the request was in flight and that nobody has seen.
 * The marker never moves backwards, so two tabs cannot un-read each other.
 */
export function markChatRead(input: {
  audienceId: string;
  readAt: string;
}): Promise<ApiResult<{ readAt: string }>> {
  return apiRequest(
    "POST",
    `/api/feed/audiences/${encodeURIComponent(input.audienceId)}/read`,
    { readAt: input.readAt },
  );
}

/**
 * Makes a group, with this account as its first member.
 *
 * A name and nothing else. Who is in it is a second act with a record of its
 * own, because putting somebody into a private group is the thing the audit log
 * here exists for.
 */
export function createChatGroup(input: {
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
export function reportChatMessage(input: {
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
export function fetchChatReports(): Promise<ApiResult<PostReportQueueView>> {
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
export function strikeChatReport(input: {
  reportId: string;
}): Promise<ApiResult<PostReportView>> {
  return apiRequest(
    "POST",
    `/api/feed/reports/${encodeURIComponent(input.reportId)}/strike`,
  );
}

/** Closes a report without striking anything. */
export function dismissChatReport(input: {
  reportId: string;
}): Promise<ApiResult<PostReportView>> {
  return apiRequest(
    "POST",
    `/api/feed/reports/${encodeURIComponent(input.reportId)}/dismiss`,
  );
}

/**
 * Oldest first: by when a post was written, then by identifier for two written
 * in the same millisecond, which is the order the API's own cursor walks.
 *
 * Comparing the ISO strings is comparing the instants, because the API writes
 * every one of them in the same UTC form. Only used to put a pinned post among
 * a page; a page on its own is reversed instead.
 */
function byWritingOrder(a: PostView, b: PostView): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
