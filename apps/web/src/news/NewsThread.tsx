import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  fetchNewsComments,
  hideNewsComment,
  type NewsComment,
  type NewsCommentAuthor,
  writeNewsComment,
} from "../api/news-reader";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { newsCommentFailureKey } from "./news-comment-failures";

/**
 * The longest comment the API stores.
 *
 * Mirrored rather than imported, like every other part of the contract in this
 * client. It is on the field so a reader is stopped by the box rather than by a
 * refusal after they have written the paragraph; the API enforces it either way,
 * and this number being wrong would cost a reader a refusal and nothing more.
 */
const COMMENT_MAX_LENGTH = 2000;

/** What the panel is asking the thread for. */
interface Request {
  /**
   * Which notice this asks about.
   *
   * Carried for the reason {@link Thread.newsId} is carried: the panel does not
   * rely on being given a new one when the notice changes. A cursor names a
   * place in one thread, and one held across a change of notice would ask for a
   * page of the new thread from a point in the old one.
   */
  newsId: string;
  /** The cursor to read back from, or null for the newest page. */
  before: string | null;
  /**
   * Bumped by every press.
   *
   * So asking twice for the same page is two reads: a page whose read failed is
   * asked for again with the cursor unchanged, and without this the panel would
   * be setting state to what it already holds and nothing would happen.
   */
  nonce: number;
}

/** The thread as the panel holds it, one or more pages deep. */
interface Thread {
  /**
   * Which news item this answer belongs to.
   *
   * Carried so the panel can tell an answer about the notice on screen from one
   * about the notice that was on screen a moment ago, and read during the render
   * rather than cleared by a second state write. The booking calendar keys its
   * answer on the resource and the week for the same reason.
   */
  newsId: string;
  /**
   * The cursor of the oldest page on it, or null when only the newest page is.
   *
   * What the panel has already put on the thread, so a page applied twice is a
   * page applied once. The thread is assembled inside a state updater and an
   * updater is run more than once by design, so what to do with an arriving page
   * is decided from what the thread already reaches rather than from having been
   * asked exactly once.
   */
  reaches: string | null;
  comments: readonly NewsComment[];
  /** The cursor for the page before the oldest one here, or null at the start. */
  earlier: string | null;
  failure: ApiFailure | null;
}

export interface NewsThreadProps {
  newsId: string;
  /**
   * Whether this account may strike a comment through.
   *
   * `site:manage`, which is what the board already holds for publishing in the
   * cooperative's name. Courtesy only - the API refuses the call whatever the
   * screen renders - but a control that could only ever fail teaches a resident
   * that part of the product is broken for them rather than not theirs.
   */
  canModerate: boolean;
}

/**
 * The comments under one news item, and the two things that can be done to them.
 *
 * ## The thread is the server's answer, never this panel's arithmetic
 *
 * Nothing here is optimistic. A posted comment is not appended to the list and a
 * struck one is not marked struck in place: both acts ask the reading effect for
 * a fresh thread, and what the reader sees is what came back. Two of this
 * module's rules are the reason, and neither can be applied in a browser.
 *
 * A comment's text is withheld or shown by the server, per reader: a struck
 * comment arrives with `body: null` for a neighbour and with its text for the
 * board and for whoever wrote it. A panel that struck a comment through locally
 * would have to decide that for itself, and the reader would then be looking at
 * a second answer - the one that is not enforced. Appending a posted comment has
 * the same shape of problem: the answer to a write is one comment and the thread
 * is the whole of it, so a list assembled from both is a list nothing on the
 * server ever said.
 *
 * The reading effect therefore owns every read, and the request's nonce is how a
 * save asks for one without changing what is asked for. A save that read for
 * itself would land its answer whenever it landed, and after a race between a
 * post and a strike-through the last response to arrive would win rather than
 * the last act to be recorded.
 *
 * ## The thread arrives a page at a time
 *
 * The API answers a bounded page from the newest end of a thread and the cursor
 * for the page before it, so a long thread reaches this panel in pieces and the
 * control that asks for the next piece is the reader's own. Pages are
 * concatenated and never merged: each one is a window on the thread that no other
 * page overlaps, which is what makes putting two of them end to end something
 * other than arithmetic about a comment.
 *
 * A save reads the newest page and drops the earlier ones, and that is a decision
 * rather than an oversight. The alternative is re-reading each page the reader
 * has open, and comments written in between would fall into the gap that opens
 * between two pages read at two moments - a comment silently missing from a
 * thread, which is the whole failure paging is here to remove. So the panel
 * carries one honest read at a time, and after a save the control that says there
 * are earlier comments is back on screen rather than a thread quietly missing
 * some.
 *
 * ## What it says about a struck comment
 *
 * Three renderings, and the two that are not a plain comment are the point. A
 * struck comment whose text is withheld says so where the text was, with its
 * author still named and its date still on it: a hide is a strike-through and
 * never a disappearance, and a thread that simply lost a row would leave nobody
 * able to tell whether anything had been said. A struck comment this reader may
 * still read carries the text with the strike-through drawn through it and the
 * sentence that says who else can read it - the board, and whoever wrote it -
 * which is the server's rule said once rather than guessed at per reader.
 */
export function NewsThread({
  newsId,
  canModerate,
}: NewsThreadProps): ReactElement {
  const { t } = useTranslation();

  const [answer, setAnswer] = useState<Thread | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * Which page the reading effect is to fetch, and the press that asked for it.
   *
   * A posted or struck comment needs a fresh read of the newest page, which is a
   * request the reading effect cannot tell from the one it has already made; a
   * press for the earlier comments needs the same read with a cursor. Both are
   * this one piece of state, and it keeps that effect the only thing that reads.
   */
  const [request, setRequest] = useState<Request>({
    newsId,
    before: null,
    nonce: 0,
  });
  /**
   * Whether a press for the earlier comments is still in flight.
   *
   * Set by the press rather than by the reading effect, because it is a fact
   * about the press: the effect also reads on arriving at a notice and after a
   * save, and neither of those is the control below saying what it is doing.
   */
  const [reading, setReading] = useState(false);
  /**
   * Which comment the strike-through in flight is for.
   *
   * One action serves every row, so without this each row reads the same save
   * state and one press puts "striking through" on the whole thread.
   */
  const [striking, setStriking] = useState<string | null>(null);

  /*
   * A cursor from another notice's thread is no cursor at all, so opening a
   * notice starts at its newest page whatever the panel was last asked for. The
   * request is read this way rather than reset by a second effect, on the
   * argument the answer above is read this way: a value derived during the render
   * cannot be one render out of date.
   */
  const before = request.newsId === newsId ? request.before : null;

  const read = useCallback(
    async (cursor: string | null): Promise<Thread> => {
      const result = await fetchNewsComments({ newsId, before: cursor });
      return result.ok
        ? {
            newsId,
            reaches: cursor,
            comments: result.value.comments,
            earlier: result.value.earlier,
            failure: null,
          }
        : {
            newsId,
            reaches: null,
            comments: [],
            earlier: null,
            failure: result.failure,
          };
    },
    [newsId],
  );

  useEffect(() => {
    /*
     * Every read this panel makes is this one, the ones a save asks for
     * included. The cleanup covers a late answer whatever asked for it: leaving
     * the notice and asking again are the same event as far as an answer already
     * in flight is concerned, and both mean it may no longer be applied.
     */
    let active = true;
    void read(before).then((next) => {
      if (active) {
        setReading(false);
        setAnswer((held) => applyPage(held, next, before));
      }
    });
    return () => {
      active = false;
    };
  }, [read, before, request.nonce]);

  /** Asks the reading effect for a page, and for this notice. */
  const ask = useCallback(
    (cursor: string | null) => {
      setReading(cursor !== null);
      setRequest((asked) => ({
        newsId,
        before: cursor,
        nonce: asked.nonce + 1,
      }));
    },
    [newsId],
  );

  const post = useSaveAction(writeNewsComment, () => {
    setDraft("");
    // The newest page, because that is where a comment somebody just wrote is.
    ask(null);
  });
  const strike = useSaveAction(hideNewsComment, () => {
    ask(null);
  });

  const posting = post.state.kind === "saving";
  const strikingOne = strike.state.kind === "saving";

  // The answer to the thread on screen, or nothing while it is in flight.
  const thread = answer?.newsId === newsId ? answer : null;

  const failure =
    post.state.kind === "failed"
      ? post.state.failure
      : strike.state.kind === "failed"
        ? strike.state.failure
        : (thread?.failure ?? null);

  /*
   * Where the page before this one starts, or nothing when the thread starts
   * here. Read into a constant so the control below can close over the cursor
   * itself: the answer is the only thing that knows there are earlier comments,
   * and the panel is not entitled to guess from a full page.
   */
  const earlier = thread?.earlier ?? null;

  return (
    <Panel
      title={t("newsReader.thread.title")}
      description={t("newsReader.thread.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(newsCommentFailureKey(failure))}
          </Notice>
        ) : post.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("newsReader.thread.sent")}
          </Notice>
        ) : null
      }
      actions={
        <button
          type="submit"
          form="write-news-comment"
          className={PRIMARY_BUTTON}
          disabled={posting || draft.trim() === ""}
        >
          {posting
            ? t("newsReader.thread.sending")
            : t("newsReader.thread.submit")}
        </button>
      }
    >
      {thread === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("newsReader.thread.loading")}
        </p>
      ) : thread.comments.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("newsReader.thread.empty")}
        </p>
      ) : (
        <>
          {earlier === null ? null : (
            /*
             * Above the thread, because that is where the comments it fetches
             * go. The reader is looking at the newest page and reaching
             * backwards, so the control belongs at the end they are reaching
             * from.
             */
            <div>
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={reading}
                onClick={() => {
                  ask(earlier);
                }}
              >
                {reading
                  ? t("newsReader.thread.earlierReading")
                  : t("newsReader.thread.earlier")}
              </button>
            </div>
          )}

          <ul className="flex flex-col gap-3">
            {thread.comments.map((comment) => (
              <li
                key={comment.id}
                className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-body font-semibold">
                    <Author of={comment.author} />
                  </span>
                  {comment.hiddenAt === null ? null : (
                    // The word as well as the tone: a reader who cannot tell the
                    // tones apart still reads that this comment was struck
                    // through.
                    <span className="inline-flex items-center rounded-control border-l-4 border-warn bg-warn-soft px-2 py-1 text-chip text-ink uppercase">
                      {t("newsReader.thread.struck")}
                    </span>
                  )}
                  <span className="ml-auto font-data text-data text-ink-muted">
                    <time dateTime={comment.createdAt}>
                      {comment.createdAt.slice(0, 10)}
                    </time>
                  </span>
                </div>

                <CommentText comment={comment} />

                {canModerate && comment.hiddenAt === null ? (
                  <div>
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      aria-label={t("newsReader.thread.hideNamed", {
                        author: authorLabel(comment.author, t),
                      })}
                      // Every row while any strike-through is in flight: one
                      // action serves them all, and a second press before the
                      // first has settled would be a second act on a thread the
                      // panel has not read back yet.
                      disabled={strikingOne}
                      onClick={() => {
                        setStriking(comment.id);
                        /*
                         * Cleared when the act settles, either way. Left standing,
                         * the row it names goes on reading "striking through" over
                         * a comment that has already been struck - or over one
                         * that was refused, which is worse: the sentence would say
                         * something is happening while the notice says it did not.
                         */
                        void strike
                          .submit({ commentId: comment.id })
                          .finally(() => setStriking(null));
                      }}
                    >
                      {strikingOne && striking === comment.id
                        ? t("newsReader.thread.hiding")
                        : t("newsReader.thread.hide")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {canModerate ? (
        <p className={HINT}>{t("newsReader.thread.hideHint")}</p>
      ) : null}

      <form
        id="write-news-comment"
        className="flex flex-col gap-2 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void post.submit({ newsId, body: draft });
        }}
      >
        <label className={LABEL}>
          {t("newsReader.thread.field")}
          <textarea
            className={`${FIELD} min-h-24 py-2`}
            value={draft}
            maxLength={COMMENT_MAX_LENGTH}
            required
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <p className={HINT}>{t("newsReader.thread.hint")}</p>
      </form>
    </Panel>
  );
}

/**
 * The thread after one page has arrived.
 *
 * Four cases, and a free function because each of them is a decision worth being
 * able to assert on its own rather than through a rendered panel.
 *
 * A read that failed leaves the thread where it was and says what happened. A
 * reader who pressed for the earlier comments and was refused has lost nothing
 * they were reading, and the notice above the thread is where the refusal
 * belongs; a panel that emptied the thread would answer a failed request by
 * removing comments nobody moderated.
 *
 * The newest page replaces the thread whole. It is the answer to "what is on this
 * thread now", and it is what a save asks for - see the panel's own comment for
 * why the earlier pages are not re-read to go with it.
 *
 * A page already on the thread is applied again as itself, because prepending it
 * a second time would show every one of its comments twice. See
 * {@link Thread.reaches} for why that is decided rather than assumed.
 *
 * Anything else is an earlier page, and it goes in front of what is already
 * there. Older comments were written first, so they read first.
 */
function applyPage(
  held: Thread | null,
  next: Thread,
  before: string | null,
): Thread {
  const standing = held !== null && held.newsId === next.newsId ? held : null;

  if (next.failure !== null) {
    return standing === null ? next : { ...standing, failure: next.failure };
  }
  if (before === null || standing === null) {
    return next;
  }
  if (standing.reaches === before) {
    return standing;
  }
  return {
    ...standing,
    reaches: before,
    comments: [...next.comments, ...standing.comments],
    earlier: next.earlier,
    failure: null,
  };
}

/**
 * What a comment says, or what happened to it.
 *
 * The three cases are written out rather than collapsed, because the middle one
 * is the whole of what moderation does here and the panel must not be able to
 * fall into it by accident: a body that is absent for any reason other than a
 * strike-through would read as the board having taken text off the thread.
 */
function CommentText({ comment }: { comment: NewsComment }): ReactElement {
  const { t } = useTranslation();

  if (comment.hiddenAt === null) {
    return <p className="text-body whitespace-pre-line">{comment.body}</p>;
  }
  if (comment.body === null) {
    return (
      <p className="text-body text-ink-muted">
        {t("newsReader.thread.struckWithheld")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-body whitespace-pre-line line-through decoration-line-strong">
        {comment.body}
      </p>
      <p className={HINT}>{t("newsReader.thread.struckReadable")}</p>
    </div>
  );
}

/**
 * Who wrote a comment, as the thread may say.
 *
 * A person with protected personal data is named to nobody here, the board
 * included: the board's own address book prints them because a register has a
 * statutory reason to, and a thread every resident reads has none. A reference
 * that no longer resolves says so rather than showing an empty name - a comment
 * is erased on its own clock and a person can be purged out from under one.
 */
function Author({ of }: { of: NewsCommentAuthor }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "resident") {
    return <span>{of.name}</span>;
  }
  if (of.kind === "protected") {
    return <NotRecorded meaning={t("newsReader.thread.authorProtected")} />;
  }
  return <NotRecorded meaning={t("newsReader.thread.authorUnknown")} />;
}

/**
 * The same attribution as one string, for the name a screen reader announces on
 * the strike-through control.
 *
 * A dash is what a sighted reader sees for an author who cannot be named, and a
 * control announced as "strike the comment from - through" would be announcing
 * punctuation. So the sentence the dash stands for is used instead, which is what
 * assistive technology is given in the row itself.
 */
function authorLabel(
  of: NewsCommentAuthor,
  t: (key: TranslationKey) => string,
): string {
  if (of.kind === "resident") {
    return of.name;
  }
  return of.kind === "protected"
    ? t("newsReader.thread.authorProtected")
    : t("newsReader.thread.authorUnknown");
}
