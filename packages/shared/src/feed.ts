/**
 * The feed's wire types: what the API answers with and what the browser reads.
 *
 * One declaration for both ends rather than a server type and a hand-kept copy
 * of it in the web client. The copy drifted the way copies do - a field the
 * server added was a field the screen never knew it had - and a type both sides
 * import cannot.
 *
 * Every instant is an ISO string, because that is what JSON carries. ADR 0026
 * records what the feed is; the API's `feed` module is where each rule lives.
 */

/** Which kind of audience (målgrupp) something is for, which decides who reads it. */
export type AudienceKind = "ALL" | "BOARD" | "GROUP";

/**
 * Who wrote something, as a reader may be told.
 *
 * Three cases, and the two that are not a plain name are the point of the type.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld from every reader, the board
 * included: `protectedData:reveal` is what lets somebody perform an act of
 * revealing and be recorded doing it, and a post read in a payload nothing
 * audits, on a screen left open, is not that act.
 *
 * `unknown` is a reference that no longer resolves to a person. A post is
 * service tier and a person can be purged out from under one, so a reader is
 * told "we no longer know" rather than shown an empty name.
 */
export type AuthorView =
  | { kind: "person"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** One audience this person is in, as the list of audiences says it. */
export interface AudienceView {
  id: string;
  kind: AudienceKind;
  /** A group's name, or null for Alla and Styrelsen, whose names are their kinds. */
  name: string | null;
  /**
   * How many posts this person has not seen since their last visit.
   *
   * Their own are never counted. Everything counts while there is no read
   * marker at all, which is what an audience somebody has never opened should
   * say.
   */
  unread: number;
  /** ISO instant of the newest post, or null while there is none. */
  lastPostAt: string | null;
}

/** The audiences this person is in, and whether they may make a group. */
export interface AudienceListView {
  audiences: AudienceView[];
  /**
   * Whether this person may create a group: whether they live here.
   *
   * Stated rather than implied, so a screen does not offer the administrator,
   * who lives nowhere, a group they cannot make.
   */
  mayCreateGroup: boolean;
}

/** The audience a post is for, as the post carries it. */
export interface PostAudienceView {
  id: string;
  kind: AudienceKind;
  name: string | null;
}

/** The news item a board post is. */
export interface PostNewsView {
  id: string;
  /** Its address under /nyheter. */
  slug: string;
  title: string;
}

/** One post, as a reader is shown it. */
export interface PostView {
  id: string;
  audience: PostAudienceView;
  /**
   * Who wrote it, or null for a post written as Styrelsen that does not name
   * its writer, and for an erased post.
   */
  author: AuthorView | null;
  /** Whether it was posted as Styrelsen. */
  byBoard: boolean;
  /**
   * What was written, or null.
   *
   * Null on a board post, whose text is its news item's, and on a post the board
   * struck through when this reader neither wrote it nor moderates. A struck
   * post is still in the feed: a strike is a strike-through and never a
   * disappearance, and the author stays named on it.
   */
  body: string | null;
  /** The news item a board post is, or null. */
  news: PostNewsView | null;
  important: boolean;
  /** Whether the board pinned it to the top of the feed. */
  pinned: boolean;
  commentsAllowed: boolean;
  /** ISO instant it was written, or for a scheduled post when it appeared. */
  createdAt: string;
  /** ISO instant its author last edited it, or null. */
  editedAt: string | null;
  /** ISO instant the board struck it through, or null while it stands. */
  struckAt: string | null;
  /**
   * ISO instant the purge erased it, or null while it stands.
   *
   * A resident's post whose year ran out while comments under it had not: the
   * text, the author and everything that went with them are gone, and the post
   * stays in its place for the comments, each of which goes on its own clock.
   * It takes no comment, like or report.
   */
  erasedAt: string | null;
  /** How many people like it. */
  likes: number;
  /** Whether this reader is one of them. */
  liked: boolean;
  /** How many comments it has. */
  comments: number;
  /** How many people have opened it ("Läst av N"). A count, never names. */
  readBy: number;
}

/**
 * Narrows a feed read. Each one only ever narrows: none reaches a post outside
 * the reader's own audiences.
 */
export type FeedFrom =
  /** Posts written as Styrelsen. */
  | "board"
  /** Posts written by the people who live here, as themselves. */
  | "neighbours";

/** One page of the feed, newest first, and where the page before it starts. */
export interface FeedPage {
  /**
   * The pinned posts, newest pin first, on the first page only.
   *
   * Empty on every page read from a cursor: a pinned post is on top of the feed
   * rather than at a place in it, so it is not on any page below.
   */
  pinned: PostView[];
  /** The posts on this page, newest first. Pinned posts are not among them. */
  posts: PostView[];
  /** The cursor for the page before this one, or null at the end of the feed. */
  earlier: string | null;
  /**
   * The cursor the poll continues from, or null while the feed is empty.
   *
   * The newest post on the first page, pinned or not, so a poll from it
   * delivers exactly what was written after the screen was drawn.
   */
  latest: string | null;
}

/** What has arrived since a cursor, oldest first. */
export interface FeedUpdate {
  posts: PostView[];
  /**
   * Where to ask from next time. The cursor handed in comes back when nothing
   * has arrived, so an idle screen keeps its place.
   */
  cursor: string;
  /** Whether more was waiting than one answer holds. Ask again at once. */
  more: boolean;
}

/** One comment, as a reader is shown it. */
export interface PostCommentView {
  id: string;
  postId: string;
  author: AuthorView;
  /** Whether a board seat holder wrote it as Styrelsen. */
  byBoard: boolean;
  /**
   * What was written, or null when the board struck it through and this reader
   * neither wrote it nor moderates.
   */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  struckAt: string | null;
  likes: number;
  liked: boolean;
}

/** One page of a post's comments, oldest first within the page. */
export interface PostCommentPage {
  comments: PostCommentView[];
  /** The cursor for the page before this one, or null at the first comment. */
  earlier: string | null;
}

/** Whether this reader likes something now, and how many do. */
export interface LikeView {
  liked: boolean;
  likes: number;
}

/** How many people have opened a post, once this reader has. */
export interface PostReadView {
  readBy: number;
}

/** One person in a group, as the group's own panel says it. */
export interface GroupMemberView {
  /** Who they are, on exactly the terms an author is. */
  person: AuthorView;
  /** ISO instant they were put into the group. */
  joinedAt: string;
  /** Whether they made the group. A fact about it, and not an office. */
  createdTheGroup: boolean;
}

/** Somebody who may be put into a group, as the picker offers them. */
export interface GroupCandidateView {
  personId: string;
  name: string;
  /** Their apartment, so two neighbours with one name can be told apart. */
  apartment: string | null;
}

/** A group, as the act that made it answers. */
export interface CreatedGroupView {
  audienceId: string;
  name: string;
}

/**
 * One report in the board's queue: the act, the post it carries and the group
 * it came out of - and nothing else about that group (ADR 0012).
 */
export interface PostReportView {
  reportId: string;
  reportedAt: string;
  reporter: AuthorView;
  note: string | null;
  groupName: string | null;
  groupCreatedBy: AuthorView;
  postId: string;
  author: AuthorView;
  /** The post's text in full: the board reads what it was asked to look at. */
  body: string;
  writtenAt: string;
  struckAt: string | null;
}

/** The board's queue, and whether this reader is the board. */
export interface PostReportQueueView {
  reports: PostReportView[];
  /**
   * Whether this reader may answer reports: whether they hold a board seat.
   *
   * False for the administrator, who holds the capability and no seat, so a
   * screen can say the queue is not theirs rather than that nothing is in it.
   */
  mayModerate: boolean;
}
