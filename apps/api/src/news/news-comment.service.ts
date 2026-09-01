import { Injectable, Logger } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import {
  type PageContent,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import {
  NewsCommentError,
  type NewsCommentTextLocation,
} from "./news-comment.error";

/**
 * The longest comment this application stores.
 *
 * Bounded but generous, on the issue description's precedent: somebody
 * explaining why the bicycle room needs a second lock writes a paragraph or
 * two, and a cap short enough to truncate one would only push the rest into a
 * second comment. It exists so one write cannot put a megabyte of text in front
 * of every neighbour who opens the notice.
 *
 * Enforced by the controller's schema as the body arrives, and stated here so
 * the rule and the type that carries it are one decision.
 */
export const NEWS_COMMENT_MAX_LENGTH = 2000;

/**
 * How many comments one person may leave in {@link WRITE_WINDOW_MINUTES}.
 *
 * Deliberately not the address-keyed budget the public forms carry. That one
 * exists because a form on the street has nobody behind it, so the only thing
 * between the board's queue and a script is what a request costs; and it counts
 * requests, refused ones included, because on those endpoints guessing is the
 * attack. Neither holds here. Every caller is signed in, so the budget can
 * belong to the account rather than to a line an entire building shares, and
 * what has to be bounded is not guessing but how much text one person can put
 * under a notice everybody reads.
 *
 * So the count is of comments actually written, taken from the table, which also
 * means it survives a restart and is the same budget in every process - neither
 * of which is true of an in-memory bucket.
 *
 * Twenty in ten minutes is one every thirty seconds sustained, far above what
 * anybody typing writes and far below what a script would want. There is no
 * honeypot on this path: a decoy field protects a form anyone can reach, and
 * this endpoint cannot be reached without a session and a capability. There is
 * no CAPTCHA either, here or anywhere in this product.
 *
 * A throttle on sustained writing rather than a hard ceiling, which is worth
 * stating rather than leaving to be discovered. The count is one statement and
 * the insert another, so requests in flight together can each read the same
 * count and each write, and the window ends up over by however many were in
 * flight. Counting inside the insert's own transaction would not change that: at
 * READ COMMITTED each transaction counts the rows committed when its statement
 * began, so two would still read the same number. Closing it takes SERIALIZABLE
 * or a per-person lock taken on every comment written, to bound an overshoot of
 * a handful - and every caller here holds a session and a capability, so there
 * is no anonymous volume to defend against. What this budget has to stop is one
 * account writing all afternoon, and it does that whatever the concurrency.
 */
export const COMMENTS_PER_WRITE_WINDOW = 20;

/** The window {@link COMMENTS_PER_WRITE_WINDOW} is counted over. */
export const WRITE_WINDOW_MINUTES = 10;

/**
 * How many comments one read of a thread answers with.
 *
 * The read has to be bounded, because nothing else bounds it: a comment holds
 * up to {@link NEWS_COMMENT_MAX_LENGTH} characters and a thread has no cap on
 * how many it holds, so an unbounded read hands every reader of a busy notice
 * everything the house has written under it since the board published it.
 *
 * A bare cap would be worse than the unbounded read rather than a smaller
 * version of it. A thread that stopped at fifty with nothing to say so is a
 * thread with comments missing from it, and a comment missing from a discussion
 * reads as a moderation act - which is exactly what this module has spent its
 * design on making visible whenever it happens. So the cap comes with a cursor
 * and a control that asks for the page before this one, and the reader is told
 * where the page ends rather than left to assume there is nothing behind it.
 *
 * Fifty, which is more than a discussion under one notice reaches: the write
 * budget is twenty per person in ten minutes and a notice about the bicycle room
 * draws a handful of answers, so on almost every thread this number never shows.
 * Small enough that one payload stays small on the day a thread does run long.
 */
export const COMMENTS_PER_PAGE = 50;

/**
 * Where a page of a thread ends, as one value a reader hands back.
 *
 * Two halves, because the ordering a thread is read in takes two columns to be
 * total and a cursor on an ordering that is not total is a bug waiting for two
 * comments to share an instant. `createdAt` alone is not total: two rows written
 * in the same instant tie, and the page boundary then falls between them in
 * whichever order the database happened to answer, so the same tie either
 * repeats a comment on both pages or drops it from both. The tie is ordinary
 * rather than theoretical: the column keeps milliseconds and its default is the
 * transaction's own clock, so rows written by one transaction all carry the same
 * instant exactly.
 *
 * The identifier breaks it. It is not a time and says nothing about one - a cuid
 * is not ordered by when it was made - and it is not asked to be: all it has to
 * do is make exactly one row the boundary and answer the same way twice.
 *
 * Both halves are values the reader was just shown, so there is nothing in a
 * cursor to withhold and it travels legibly rather than encoded.
 */
export interface ThreadCursor {
  /** The instant of the comment the page ended at. */
  createdAt: Date;
  /** That comment's identifier, which breaks a tie on the instant. */
  id: string;
}

/**
 * Separates the two halves of a cursor.
 *
 * A character neither half can contain: an ISO instant is digits and punctuation
 * fixed by the format, and an identifier is a cuid.
 */
const CURSOR_SEPARATOR = "|";

/** The cursor for the page ending at this comment. */
export function threadCursor(row: { id: string; createdAt: Date }): string {
  return `${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`;
}

/**
 * The cursor a reader handed back, or null when it is not one.
 *
 * Null rather than a lenient reading, and the controller turns it into a
 * refusal. A cursor this service cannot make sense of names a page nobody can
 * name, and answering it with the newest page instead would answer a different
 * question: a reader pressing for the comments before the ones on their screen
 * would be handed the ones already there, and the thread would look like it had
 * nothing behind it.
 *
 * Exported so the round trip can be asserted directly rather than only through
 * a read.
 */
export function parseThreadCursor(value: string): ThreadCursor | null {
  const halves = value.split(CURSOR_SEPARATOR);
  if (halves.length !== 2) {
    /*
     * Exactly two halves, so a value carrying a second separator is refused
     * rather than read as an identifier containing one. Neither half of a cursor
     * this application issued can hold the separator at all, so a value that
     * does is not one of ours - and reading it leniently would let a caller
     * compose a page boundary from a comment that does not exist.
     */
    return null;
  }
  const [instant, id] = halves;
  /*
   * Neither half may be empty: a cursor names an instant and a comment, and a
   * value with one of them missing names neither. The undefined the compiler
   * allows for an index is unreachable past the length check above.
   */
  if (
    instant === undefined ||
    id === undefined ||
    instant === "" ||
    id === ""
  ) {
    return null;
  }

  const createdAt = new Date(instant);
  /*
   * Round-tripped rather than merely parsed. `new Date` accepts more than one
   * spelling of a moment and reads some strings that are not one at all, so an
   * instant that does not come back out exactly as it went in is refused - a
   * cursor is compared against a stored column and has to mean one moment.
   */
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    return null;
  }

  return { createdAt, id };
}

/** One page of a thread, and where the page before it starts. */
export interface NewsCommentPage {
  /** The comments on this page, oldest first. */
  comments: NewsCommentView[];
  /**
   * The cursor for the page before this one, or null at the start of the thread.
   *
   * Handed straight back as `before` to read it. Null is the whole of the answer
   * to "is there more", so a reader is never left inferring it from a page that
   * came back short.
   */
  earlier: string | null;
}

/**
 * Who wrote a comment, as the thread may say.
 *
 * Three cases, and the two that are not a plain name are the point of the type,
 * exactly as for `IssueReporterView`.
 *
 * `protected` is a person with protected personal data (skyddade
 * personuppgifter). Their name is withheld here even though the board's own
 * address book prints it: that register has a statutory reason to, and a comment
 * thread every resident reads has none. Withheld from the board as well, because
 * the thread is one payload and a name that appeared for some readers would be a
 * name the person cannot rely on being withheld.
 *
 * `unknown` is an author reference that no longer resolves to a person. A
 * comment is service tier and a person can be purged out from under one, so the
 * thread has to be able to say "we no longer know" rather than break.
 */
export type NewsCommentAuthorView =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

/** One comment, as a reader is shown it. */
export interface NewsCommentView {
  id: string;
  author: NewsCommentAuthorView;
  /**
   * What was written, or null.
   *
   * Null means the comment is hidden and this reader is neither a moderator nor
   * its author. The comment itself is still in the list: a hide is a
   * strike-through and never a disappearance.
   */
  body: string | null;
  /** ISO instant it was hidden, or null while it stands. */
  hiddenAt: string | null;
  /** ISO instant it was written. */
  createdAt: string;
}

/**
 * One news item, as the application's own reader is shown it.
 *
 * The identifier is on it, which the website's own answer deliberately has not
 * got: a page under /nyheter is addressed by its slug and has nothing to do with
 * an identifier, while a thread is addressed by the item's id. So this is a
 * second shape rather than the website's with a field added, and the two stay
 * apart for the reason the two services do.
 *
 * The body travels with the item rather than being fetched per item. A reader
 * moving down the notices would otherwise pay a request for every one they open,
 * and the board's own list already answers with every item's body - what a
 * cooperative writes is bounded by how often a board writes to the house.
 */
export interface NewsArticleView {
  id: string;
  slug: string;
  title: string;
  /** The prose the board wrote, narrowed to what a renderer can vouch for. */
  content: PageContent;
  /** ISO instant it was published. */
  publishedAt: string;
}

export interface WriteNewsCommentInput {
  newsId: string;
  authorPersonId: string;
  body: string;
}

const COMMENT_COLUMNS = {
  id: true,
  newsId: true,
  authorPersonId: true,
  body: true,
  hiddenAt: true,
  createdAt: true,
} as const;

/**
 * Comments on the association's news (kommentarer), and the board's power over
 * them.
 *
 * Five rules live here and nowhere else.
 *
 * **Visibility is inherited, never independent.** A comment is exactly as
 * visible as the news item it sits on. There is no audience field on a comment
 * and there is not going to be one: a second answer to "who may read this"
 * would be a second place for the two to disagree, and the one that lost would
 * be the item's. In practice the inherited rule reduces to one condition, and
 * the reduction is worth stating rather than leaving to be rediscovered. The
 * website's rule is "public items for everyone, member-only items as well for
 * anyone signed in"; every caller who reaches this service has a session,
 * because the authorization guard rejects the ones who do not. So what is left
 * of the rule here is `published`, and a draft has no thread at all.
 *
 * That rule is about who may read a thread and who may write into one. It is not
 * about what the board may do to a comment that is already on one: see
 * {@link NewsCommentService.hide}, which is where publication stops being a
 * condition and why.
 *
 * **No comment is ever rendered on the public website.** A comment on a public
 * news item is still not public. The website takes no authenticated writes and
 * reads no session at all - that is what makes it a site with zero cookies and
 * zero JavaScript - so a thread there would be either anonymous or a login wall
 * on a page that promises neither. Reads and writes are `/app` JSON endpoints,
 * and `src/site` neither imports this service nor selects this table.
 *
 * **A personal identity number is refused.** Every comment is scanned on the
 * way in and a hit refuses the write, naming the offset and never the value.
 * This is the first place in this codebase where that guardrail protects a
 * member from themselves rather than the association from its board: the other
 * call sites are board-publish paths, where the person writing is the person
 * publishing. Here somebody pastes a neighbour's details into a reply about a
 * dispute, and the scan is what stops the whole house reading it.
 *
 * **Moderation hides and never deletes.** The board can strike a comment
 * through and cannot make it disappear: `hiddenAt` is written once and never
 * cleared, the comment stays in every read with its author still named, and only
 * its text is withheld. A board that could erase a comment silently would be
 * worse than one that can only strike it through, because nobody reading the
 * thread afterwards could tell which had happened. And it can do it for as long
 * as the comment is there, whether or not the notice above it is still
 * published - the one act the board has over a thread does not end when it takes
 * the thread down.
 *
 * **A thread is read a page at a time.** Every read of a thread answers with at
 * most {@link COMMENTS_PER_PAGE} comments and the cursor for the page before it,
 * because a thread has no natural end and an unbounded read of one is an
 * unbounded payload. It pages from the newest end, which is where a reader
 * arriving at a long thread wants to be and where their own comment lands the
 * moment they write one.
 *
 * The news items themselves are read here as well, which is worth an argument
 * rather than a filing note. They are read here because of the first rule: which
 * items a reader is offered and which threads open to them are the same question,
 * and answering it in two services would be two places for one rule to live and
 * one place for them to disagree. What the screen would then show is a notice it
 * cannot open a thread on, or a thread on a notice it did not list. So the list
 * is `commentableNews` rather than "the news", and the name is the argument.
 */
@Injectable()
export class NewsCommentService {
  private readonly logger = new Logger(NewsCommentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Every news item this reader may open a thread on, newest first.
   *
   * Newest first because a reader arriving at the notices is looking for the
   * latest one, which is the same order the website's index uses and the
   * opposite of the order inside a thread.
   *
   * It takes no principal, and that absence is the visibility rule rather than an
   * oversight. A comment is exactly as visible as the item it sits on; inside the
   * application every caller has a session, because the guard rejects the ones
   * who do not; so what is left of the website's rule here is `published`, and
   * the answer is therefore the same for every reader who gets this far. A
   * parameter nothing reads would suggest there is a second case.
   *
   * Draft items are absent for that same reason and not as a courtesy: a draft
   * has no thread at all, and listing one would offer a reader a notice whose
   * thread is answered exactly as an item that was never written.
   */
  async commentableNews(): Promise<NewsArticleView[]> {
    const rows = await this.prisma.news.findMany({
      where: { published: true },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        slug: true,
        title: true,
        content: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      /*
       * Narrowed on the way out, exactly as the website narrows it. A body that
       * reached the column carrying a picture or a block that reads something
       * else out of the database - written by a newer editor, or by hand - shows
       * its text and nothing else, and a link whose scheme this platform does not
       * publish is dropped by the parser rather than by the browser.
       */
      content: textBlocksOnly(readPageContent(row.content)),
      /*
       * A published item always carries the date. The fallback keeps the type
       * honest rather than describing a state this query can return: the column
       * is nullable because an item that has never been published has no date,
       * and those are filtered out above.
       */
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    }));
  }

  /**
   * One page of the thread on a news item, oldest first within the page.
   *
   * Oldest first because a thread is read in the order it was written, unlike
   * the board's own list of items, which is newest first because that is the
   * one somebody is looking for.
   *
   * Hidden comments are in the list. Their text is withheld unless the reader
   * moderates the website or wrote the comment themselves - see the class
   * comment for why the strike-through is visible to everybody.
   *
   * ## Which page, when nobody asks for one
   *
   * The newest, and then backwards. A page is cut from the end the thread has
   * reached and turned round inside itself, so the order a comment is read in
   * never changes while the reader still lands where the conversation is. Cutting
   * from the other end would hand somebody opening a long thread the comments
   * written when the notice went up and put the answer they came for behind
   * however many presses the thread is long - and, worse, it would hide a
   * reader's own comment the moment they wrote one, because a comment is written
   * at the newest end and the newest end would be the page nobody had opened
   * yet. It is the argument `commentableNews` makes for newest first, applied
   * inside one notice.
   *
   * ## Why a cursor and not the address book's page numbers
   *
   * That register is paged by offset because it is a register: the rows are
   * there before the reader arrives and the same query answers the same page
   * twice. A thread is written into while it is being read, and an offset from
   * the end shifts by one for every comment somebody adds - so page two by
   * offset would repeat what page one had shown, or step over it, entirely
   * depending on how busy the notice was. A cursor names a place in the thread
   * rather than a distance from its end, so the page before this one is the same
   * page however much has been written since.
   */
  async list(
    newsId: string,
    reader: Principal,
    before: ThreadCursor | null = null,
  ): Promise<NewsCommentPage> {
    await this.requireCommentableNews(newsId);

    /*
     * One more row than the page holds, which is how "there is a page before
     * this one" is answered. A separate count would be a second statement about
     * a second moment, and could say there was more when the extra comment had
     * been purged between the two - a page offered and then answered empty.
     */
    const rows = await this.prisma.newsComment.findMany({
      where: { newsId, ...(before === null ? {} : olderThan(before)) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENTS_PER_PAGE + 1,
      select: COMMENT_COLUMNS,
    });

    const page = rows.slice(0, COMMENTS_PER_PAGE);
    const oldest = page.at(-1);
    /*
     * The cursor is the oldest comment kept rather than the extra row read, so
     * the next page starts exactly where this one stopped. `oldest` is only
     * undefined on an empty page, which cannot also have read a row past it.
     */
    const earlier =
      oldest !== undefined && rows.length > page.length
        ? threadCursor(oldest)
        : null;

    return { comments: await this.toViews(page.reverse(), reader), earlier };
  }

  /**
   * Writes a comment, and records that it was written.
   *
   * The three refusals in order: an item with no thread, a person who has
   * written too many, and text carrying a personal identity number. The first is
   * first because it is the cheapest and the least revealing - a caller learns
   * only what they would learn by asking to read the thread.
   */
  async write(input: WriteNewsCommentInput): Promise<NewsCommentView> {
    const news = await this.requireCommentableNews(input.newsId);
    await this.refuseTooManyComments(input.authorPersonId);
    refusePersonalIdentityNumbers(input.body);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.newsComment.create({
        data: {
          newsId: input.newsId,
          authorPersonId: input.authorPersonId,
          body: input.body,
        },
        select: COMMENT_COLUMNS,
      });

      await this.audit.record(
        {
          action: "NEWS_COMMENT_POSTED",
          // Both, because this is the author's own act and their own data. Their
          // access report has to be able to say when they wrote what, and it
          // reads the actor column for what a person did and the subject column
          // for what was done to them.
          actorPersonId: input.authorPersonId,
          targetPersonId: input.authorPersonId,
          targetKind: "newsComment",
          targetId: created.id,
          // Which notice, and how much was written. Never the text: the log is
          // append-only and exempt from every purge, so a body copied in here
          // would outlive the comment the purge erased.
          context: {
            newsId: input.newsId,
            slug: news.slug,
            bodyLength: input.body.length,
          },
        },
        tx,
      );

      return created;
    });

    this.logger.log(`A comment was written on the news item ${news.slug}`);

    // Answered to its own author, so a comment written by somebody with
    // protected personal data comes back attributed exactly as the thread will
    // attribute it: this payload and the thread's are one shape, and an author
    // resolved differently on the way out would be a second answer.
    return toView(row, {
      author: await this.authorOf(row.authorPersonId),
      canReadHiddenBody: true,
    });
  }

  /**
   * Strikes a comment through.
   *
   * ## Publication decides who may read a thread, never who may act on one
   *
   * A notice the board has taken down keeps the thread it had while it was up,
   * and the board can still strike a comment through on it. The reading of
   * "unpublished" that would refuse here treats an unpublished thing as an
   * absent thing, and that reading is right in exactly one place: deciding
   * whether somebody new may read something or take part in it. It is wrong for
   * an act whose authority comes from somewhere else, and wrong in the direction
   * that costs the most - it leaves the board unable to act on the text it has
   * most reason to act on, in the state it reaches by trying to limit the damage.
   *
   * `EventSignupService.withdrawOwn` is the same decision seen from the other
   * side: a date whose series the board has taken down is answered as absent to
   * somebody claiming a place and not to somebody giving one back, because the
   * alternative held residents to a date they could neither see nor leave. So the
   * rule is one rule and this is its general form. Publication governs the paths
   * that read and the paths that let somebody new take part. It governs no act
   * whose authority is the caller's own - the board's `site:manage` over what the
   * association publishes, or a person's own row - and a module reaching for the
   * question a third time should take this answer rather than write a third one.
   *
   * ## What the not-found answer still protects
   *
   * That nobody learns from this route whether a comment exists. The answer for a
   * comment that is not there is unchanged and stays exactly as uninformative.
   *
   * What has gone from the test is publication, not the guard. Publication
   * narrows nothing for the caller of this route: hiding is `site:manage`, which
   * is the capability that decides what is published in the first place, and the
   * board's own list of items answers every item it holds, drafts included. A
   * publication test here therefore withheld an item from the one caller entitled
   * to see it. Where the caller holds `news:comment` instead - reading a thread,
   * writing into one - the whole rule stands, because there a draft has to stay
   * invisible: see {@link NewsCommentService.requireCommentableNews}.
   *
   * ## The act first, and the reads after it
   *
   * The conditional update is the whole of the decision, so two presses in the
   * same instant cannot both be a first press. A read taken first is the stale
   * thing: both would find nothing hidden, both would write the date, and the
   * audit log would carry two entries for one act. This way one press matches the
   * row and the other matches nothing, and the read that follows is asked about a
   * fact that has settled.
   *
   * Hiding one that is already hidden changes nothing and writes nothing, on the
   * precedent the publish path sets: a second press is not a second event and
   * does not belong in the audit log.
   */
  async hide(
    commentId: string,
    actorPersonId: string,
  ): Promise<NewsCommentView> {
    const { comment, struck } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.newsComment.updateMany({
        where: { id: commentId, hiddenAt: null },
        data: { hiddenAt: new Date(), hiddenByPersonId: actorPersonId },
      });

      const comment = await tx.newsComment.findUnique({
        where: { id: commentId },
        select: COMMENT_COLUMNS,
      });
      if (comment === null) {
        // Nothing matched and there is no row, which is the genuinely absent
        // case and the only one this answer covers.
        throw new NewsCommentError(
          "There is no such comment.",
          "comment-not-found",
        );
      }

      if (count === 0) {
        // The row is there and was already struck through, so this press is not
        // an event. Nothing written, nothing recorded, and the comment answered
        // exactly as the press that struck it answered.
        return { comment, struck: false };
      }

      await this.audit.record(
        {
          action: "NEWS_COMMENT_HIDDEN",
          actorPersonId,
          // The subject is whoever wrote it: this is something done to them, and
          // their access report has to show a moderation somebody else decided
          // on.
          targetPersonId: comment.authorPersonId,
          targetKind: "newsComment",
          targetId: comment.id,
          context: { newsId: comment.newsId },
        },
        tx,
      );

      return { comment, struck: true };
    });

    if (struck) {
      this.logger.log(`A comment on news ${comment.newsId} was hidden`);
    }

    return toView(comment, {
      author: await this.authorOf(comment.authorPersonId),
      canReadHiddenBody: true,
    });
  }

  /**
   * The news item a comment may be read on or written to, or a refusal.
   *
   * The whole visibility rule, in one place, used by every path. See the class
   * comment for why "published" is all that is left of it inside the
   * application.
   */
  private async requireCommentableNews(
    newsId: string,
  ): Promise<{ id: string; slug: string }> {
    const news = await this.prisma.news.findUnique({
      where: { id: newsId },
      select: { id: true, slug: true, published: true },
    });
    if (news === null || !news.published) {
      /*
       * One answer for both, on the precedent SiteNewsService.bySlug sets. A
       * refusal that distinguished them would let anybody holding
       * `news:comment` walk the identifier space and learn which drafts the
       * board is working on.
       */
      throw new NewsCommentError(
        "There is no such news item.",
        "news-not-found",
      );
    }
    return { id: news.id, slug: news.slug };
  }

  /** Refuses a person who has written their allowance for the window. */
  private async refuseTooManyComments(authorPersonId: string): Promise<void> {
    const since = new Date(Date.now() - WRITE_WINDOW_MINUTES * 60 * 1000);
    const written = await this.prisma.newsComment.count({
      where: { authorPersonId, createdAt: { gte: since } },
    });
    if (written >= COMMENTS_PER_WRITE_WINDOW) {
      throw new NewsCommentError(
        "Too many comments in too short a time. Try again shortly.",
        "too-many-comments",
      );
    }
  }

  /** Every view in a thread, with the authors resolved in one read. */
  private async toViews(
    rows: readonly CommentRow[],
    reader: Principal,
  ): Promise<NewsCommentView[]> {
    const authorIds = [...new Set(rows.map((row) => row.authorPersonId))];
    const persons =
      authorIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: authorIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });
    const byId = new Map(persons.map((person) => [person.id, person]));

    // The board's own capability for publishing in the cooperative's name is
    // what opens a struck-through comment's text, and so is having written it.
    const moderates = reader.capabilities.has("site:manage");

    return rows.map((row) =>
      toView(row, {
        author: authorViewOf(row.authorPersonId, byId.get(row.authorPersonId)),
        canReadHiddenBody: moderates || row.authorPersonId === reader.personId,
      }),
    );
  }

  /** One author, read on its own, for the single-comment paths. */
  private async authorOf(personId: string): Promise<NewsCommentAuthorView> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    return authorViewOf(personId, person ?? undefined);
  }
}

interface CommentRow {
  id: string;
  newsId: string;
  authorPersonId: string;
  body: string;
  hiddenAt: Date | null;
  createdAt: Date;
}

/**
 * Everything in a thread strictly before one point in it.
 *
 * The comparison the ordering implies, written out rather than handed to the
 * query builder's own cursor option. That one names a row: it reads the boundary
 * values back out of the comment the cursor points at, and a comment can be
 * purged out from under a reader between one page and the next, because a thread
 * is erased on its own clock a year at a time. A cursor whose row has gone
 * matches nothing at all - a page silently empty, which is the failure paging
 * this thread exists to remove rather than to introduce somewhere new. These
 * comparisons are against the two values the reader was handed, so the row they
 * were read from no longer has to be there.
 *
 * The index on `(newsId, createdAt)` answers the first branch. The second only
 * ever sorts rows sharing one instant, which is a handful at most.
 */
function olderThan(cursor: ThreadCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * One comment as a reader is shown it.
 *
 * A free function rather than a method, because it holds no state and because
 * what it decides - whether this reader sees a struck-through comment's text -
 * is one rule worth being able to assert on its own.
 */
function toView(
  row: CommentRow,
  reader: {
    author: NewsCommentAuthorView;
    /** Whether a hidden comment's text is withheld from this reader. */
    canReadHiddenBody: boolean;
  },
): NewsCommentView {
  return {
    id: row.id,
    author: reader.author,
    body: row.hiddenAt !== null && !reader.canReadHiddenBody ? null : row.body,
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Who a comment is attributed to, from the person the register still holds.
 *
 * A person with protected personal data is named to nobody, and a reference
 * that no longer resolves is reported as unknown rather than as an empty name.
 */
function authorViewOf(
  personId: string,
  person:
    | {
        id: string;
        firstName: string;
        lastName: string;
        protectedPersonalData: boolean;
      }
    | undefined,
): NewsCommentAuthorView {
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "resident",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}

/**
 * Refuses a comment carrying a Swedish personal identity number.
 *
 * The same rule a page and a news item live under, applied for the first time to
 * a member's own writing rather than the board's. A number pasted into a comment
 * is a disclosure to every resident who opens the notice and one the association
 * cannot take back, and it arrives along with the text around it rather than
 * because anybody decided to publish it.
 *
 * Exported so the rule can be asserted directly rather than only through a
 * write.
 */
export function refusePersonalIdentityNumbers(body: string): void {
  const locations = scanForPersonalIdentityNumbers(body).map(
    (hit): NewsCommentTextLocation => ({ part: "body", offset: hit.index }),
  );

  if (locations.length > 0) {
    throw new NewsCommentError(
      "The comment carries a personal identity number and cannot be written.",
      "personal-identity-number",
      locations,
    );
  }
}
