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
 * Four rules live here and nowhere else.
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
 * thread afterwards could tell which had happened.
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
   * The thread on one news item, oldest first.
   *
   * Oldest first because a thread is read in the order it was written, unlike
   * the board's own list of items, which is newest first because that is the
   * one somebody is looking for.
   *
   * Hidden comments are in the list. Their text is withheld unless the reader
   * moderates the website or wrote the comment themselves - see the class
   * comment for why the strike-through is visible to everybody.
   */
  async list(newsId: string, reader: Principal): Promise<NewsCommentView[]> {
    await this.requireCommentableNews(newsId);

    const rows = await this.prisma.newsComment.findMany({
      where: { newsId },
      orderBy: [{ createdAt: "asc" }],
      select: COMMENT_COLUMNS,
    });

    return this.toViews(rows, reader);
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
   * Hiding one that is already hidden changes nothing and writes nothing, on the
   * precedent the publish path sets: a second press is not a second event and
   * does not belong in the audit log.
   */
  async hide(
    commentId: string,
    actorPersonId: string,
  ): Promise<NewsCommentView> {
    const comment = await this.prisma.newsComment.findUnique({
      where: { id: commentId },
      select: { ...COMMENT_COLUMNS, news: { select: { published: true } } },
    });
    if (comment === null || !comment.news.published) {
      // The same answer for a comment that does not exist and one on an item
      // with no thread, so neither can be used to find out about the other.
      throw new NewsCommentError(
        "There is no such comment.",
        "comment-not-found",
      );
    }

    if (comment.hiddenAt !== null) {
      return toView(comment, {
        author: await this.authorOf(comment.authorPersonId),
        canReadHiddenBody: true,
      });
    }

    const hidden = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.newsComment.update({
        where: { id: commentId },
        data: { hiddenAt: new Date(), hiddenByPersonId: actorPersonId },
        select: COMMENT_COLUMNS,
      });

      await this.audit.record(
        {
          action: "NEWS_COMMENT_HIDDEN",
          actorPersonId,
          // The subject is whoever wrote it: this is something done to them, and
          // their access report has to show a moderation somebody else decided
          // on.
          targetPersonId: updated.authorPersonId,
          targetKind: "newsComment",
          targetId: updated.id,
          context: { newsId: updated.newsId },
        },
        tx,
      );

      return updated;
    });

    this.logger.log(`A comment on news ${hidden.newsId} was hidden`);

    return toView(hidden, {
      author: await this.authorOf(hidden.authorPersonId),
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
