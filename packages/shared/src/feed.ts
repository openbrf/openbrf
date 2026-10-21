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

/**
 * Which kind of audience (målgrupp) something is for, which decides who reads it:
 * Alla, Styrelsen, a group, or Administratörer (the instance's administrators
 * and the board).
 */
export type AudienceKind = "ALL" | "BOARD" | "GROUP" | "ADMIN";

/**
 * The audiences a post written as Styrelsen may go to, and a comment written as
 * Styrelsen may answer in: every derived one. A group is not the board's to
 * speak in (ADR 0012).
 */
export const BOARD_POST_AUDIENCES: readonly AudienceKind[] = [
  "ALL",
  "BOARD",
  "ADMIN",
];

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
  /**
   * A group's name, or null for Alla, Styrelsen and Administratörer, whose
   * names are their kinds.
   */
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
  /**
   * ISO instant this person had read the audience up to, or null while they
   * have never opened it: their read marker, which is what "new since your last
   * visit" is measured from.
   */
  readAt: string | null;
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
  /**
   * Whether this person may write as Styrelsen: whether they hold a board seat
   * that has not ended, and publish on the association's behalf.
   *
   * Stated for the reason `mayCreateGroup` is. The administrator holds every
   * capability and no seat, and a resident holds neither, so a screen offers
   * the board's options only where the server will take them - and the server
   * asks the register again on every write, whatever a screen offered.
   */
  mayPostAsBoard: boolean;
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
  /**
   * What the item says, as plain text: its paragraphs and headings in order,
   * a blank line between each. The card shows the post's text from here,
   * because a board post's text is its news item's.
   */
  text: string;
}

/**
 * One image on a post, or one uploaded for a post not yet written.
 *
 * The file is served from this instance's own media route and from nowhere
 * else, and that route asks the feed, on every request, whether the reader may
 * read the post the image is on - so a group's image is refused by its address
 * exactly as a group's post is by its identifier. An image uploaded for a post
 * that was never written is on no post, and is served to nobody: the composer
 * shows its own copy, read out of the file the writer picked.
 */
export interface PostImageView {
  /** The stored file's identifier, which is what a post is written with. */
  id: string;
  /** Where the browser fetches it: a path on this instance's own origin. */
  url: string;
  /** Pixel dimensions read out of the image itself, so a card can hold its place. */
  width: number | null;
  height: number | null;
}

/** Where an issue report stands: the issue module's three states. */
export type PostIssueStatus = "NEW" | "IN_PROGRESS" | "DONE";

/**
 * The issue report (felanmälan) made from a post, as somebody who may read the
 * report is shown it: whoever made it, and whoever handles issues.
 */
export interface PostIssueView {
  id: string;
  status: PostIssueStatus;
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
  /**
   * The images on it, in the order they were attached.
   *
   * Empty wherever `body` is withheld, for the same reason: an image is part of
   * what was said, and a strike-through that left the pictures in front of the
   * group would have withheld only the caption. Empty on an erased post, whose
   * images went with its text.
   */
  images: PostImageView[];
  /** The news item a board post is, or null. */
  news: PostNewsView | null;
  important: boolean;
  /** Whether the board pinned it to the top of the feed. */
  pinned: boolean;
  commentsAllowed: boolean;
  /**
   * ISO instant the board asked a post to appear at, or null for one that
   * appeared when it was written. Only the board is ever shown a post whose
   * instant has not come.
   */
  scheduledAt: string | null;
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
  /**
   * The issue report made from it, or null: when none was made, and when this
   * reader may not read the report. The report is the reporter's and the issue
   * handlers', and a post does not widen that.
   */
  issue: PostIssueView | null;
  /**
   * Whether this reader may make an issue report from it ("Gör felanmälan"):
   * they wrote it or hold a board seat, they may report issues, and no report
   * has been made from it yet. Not on an erased post.
   */
  mayReportIssue: boolean;
  /**
   * Whether this reader may edit it: they wrote it as themselves, and it is
   * neither struck nor erased. A post written as Styrelsen is its news item,
   * edited as one.
   */
  mayEdit: boolean;
  /**
   * Whether this reader may read its earlier versions: it has been edited, and
   * they wrote it or are the board.
   */
  mayReadHistory: boolean;
  /**
   * Whether this reader may list who in its audience has not opened it yet: it
   * is important, and they are the board. Everybody else has the count.
   */
  mayListNotRead: boolean;
  /**
   * Whether this reader may report it to the board ("Anmäl till styrelsen"): it
   * is in Alla or a group, somebody other than the reader wrote it as
   * themselves, and it is neither struck nor erased. False for the board in
   * Alla, which strikes it rather than reporting it to itself.
   */
  mayReport: boolean;
  /**
   * Whether this reader may strike it through without a report: they are the
   * board, it is a resident's post in Alla, and it is neither struck nor
   * erased. Never in a group, which the board reaches only through a report
   * (ADR 0012), and never in Styrelsen or Administratörer, which have no
   * strike-through.
   */
  mayStrike: boolean;
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
  /**
   * The board's posts still waiting for their instant, soonest first, in the
   * audiences the read covers: on the first page of a read narrowed by nothing
   * but its audience, and only for somebody who may write as Styrelsen. Empty
   * for everybody else.
   *
   * Beside the feed rather than in it: a post's place in the feed is its
   * instant, and one placed in the future would put the poll's cursor there
   * and skip everything written before it.
   */
  scheduled: PostView[];
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
  /** Whether this reader may edit it: they wrote it, and it is not struck. */
  mayEdit: boolean;
  /**
   * Whether this reader may read its earlier versions: it has been edited, and
   * they wrote it or are the board.
   */
  mayReadHistory: boolean;
  /**
   * Whether this reader may report it to the board: it is under a post in Alla
   * or a group, somebody else wrote it, and it is not struck. False for the
   * board in Alla, which strikes it instead.
   */
  mayReport: boolean;
  /**
   * Whether this reader may strike it through without a report: they are the
   * board, it is under a post in Alla, and it is not struck.
   */
  mayStrike: boolean;
}

/**
 * One earlier version of a post or a comment, kept when its author edited it.
 *
 * Read by the author and the board, and by nobody else (ADR 0026): the house
 * reads what stands, and that it was edited.
 */
export interface RevisionView {
  /** The text as it stood. */
  body: string;
  /** ISO instant this version was written. */
  writtenAt: string;
  /** ISO instant an edit replaced it. */
  replacedAt: string;
}

/** A post's or a comment's earlier versions, the most recently replaced first. */
export interface RevisionListView {
  revisions: RevisionView[];
}

/**
 * Who in an important post's audience has not opened it yet: the board's
 * must-read list (ADR 0026). Shown to the board and to nobody else.
 */
export interface NotReadView {
  /**
   * Each of them, on exactly the terms an author is: a person with protected
   * personal data is listed without their name.
   */
  people: AuthorView[];
}

/** One page of a post's comments, oldest first within the page. */
export interface PostCommentPage {
  comments: PostCommentView[];
  /** The cursor for the page before this one, or null at the first comment. */
  earlier: string | null;
  /**
   * The cursor the poll continues from: the newest comment on this page, or
   * null when the page holds none.
   *
   * Taken from the newest page, so a poll from it delivers exactly what was
   * written after the thread was opened.
   */
  latest: string | null;
}

/** The comments written under a post since a cursor, oldest first. */
export interface PostCommentUpdate {
  comments: PostCommentView[];
  /**
   * Where to ask from next time. The cursor handed in comes back when nothing
   * has arrived, so an idle thread keeps its place.
   */
  cursor: string;
  /** Whether more was waiting than one answer holds. Ask again at once. */
  more: boolean;
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
 * One report in the board's queue: the act, the one post or comment it carries,
 * and where that was said - and, from a group, nothing else about the group
 * (ADR 0012).
 */
export interface PostReportView {
  reportId: string;
  reportedAt: string;
  reporter: AuthorView;
  note: string | null;
  /** Where it was said: Alla or a group. Nothing else can be reported. */
  audienceKind: AudienceKind;
  /** The group's name, or null in Alla. */
  groupName: string | null;
  /** Who made the group, or null in Alla, which nobody made. */
  groupCreatedBy: AuthorView | null;
  /**
   * The post reported, or for a comment in Alla the post it is under, which
   * the board reads there anyway. Null on a comment in a group: the report
   * carries that comment and nothing else, not even the post it answered.
   */
  postId: string | null;
  /** The comment reported, or null on a report of a post. */
  commentId: string | null;
  author: AuthorView;
  /**
   * The post's or the comment's text in full: the board reads what it was
   * asked to look at.
   */
  body: string;
  /**
   * A reported post's images, in the order they were attached, while the
   * report is open: a picture is part of what the board was asked to look at,
   * and the report is what opens it to a board that is not in the group. Empty
   * on a report already answered, which no longer opens anything, and on a
   * comment, which carries none.
   */
  images: PostImageView[];
  writtenAt: string;
  struckAt: string | null;
}

/** The board's queue, and whether this reader is the board. */
export interface PostReportQueueView {
  /** One page of the open reports, oldest first. */
  reports: PostReportView[];
  /**
   * The cursor for the page after this one, or null when this page holds the
   * last open report. Handed back as it arrived.
   */
  next: string | null;
  /**
   * Whether this reader may answer reports: whether they hold a board seat.
   *
   * False for the administrator, who holds the capability and no seat, so a
   * screen can say the queue is not theirs rather than that nothing is in it.
   */
  mayModerate: boolean;
}
