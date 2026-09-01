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

/** Everything one read of a thread produces, applied to the panel in one step. */
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
  comments: readonly NewsComment[];
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
 * The reading effect therefore owns every read, and `refreshes` is how a save
 * asks for one without changing what is asked for. A save that read for itself
 * would land its answer whenever it landed, and after a race between a post and
 * a strike-through the last response to arrive would win rather than the last
 * act to be recorded.
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
   * Bumped to ask for the thread again without changing what is asked for.
   *
   * A posted or struck comment needs a fresh read of the same thread, which is a
   * request the reading effect cannot tell from the one it has already made. This
   * is how it is told, and it keeps that effect the only thing that reads.
   */
  const [refreshes, setRefreshes] = useState(0);
  /**
   * Which comment the strike-through in flight is for.
   *
   * One action serves every row, so without this each row reads the same save
   * state and one press puts "striking through" on the whole thread.
   */
  const [striking, setStriking] = useState<string | null>(null);

  const read = useCallback(async (): Promise<Thread> => {
    const result = await fetchNewsComments({ newsId });
    return result.ok
      ? { newsId, comments: result.value, failure: null }
      : { newsId, comments: [], failure: result.failure };
  }, [newsId]);

  useEffect(() => {
    /*
     * Every read this panel makes is this one, the ones a save asks for
     * included. The cleanup covers a late answer whatever asked for it: leaving
     * the notice and asking again are the same event as far as an answer already
     * in flight is concerned, and both mean it may no longer be applied.
     */
    let active = true;
    void read().then((next) => {
      if (active) {
        setAnswer(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read, refreshes]);

  const post = useSaveAction(writeNewsComment, () => {
    setDraft("");
    setRefreshes((count) => count + 1);
  });
  const strike = useSaveAction(hideNewsComment, () => {
    setRefreshes((count) => count + 1);
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
