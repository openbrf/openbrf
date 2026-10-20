import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  BOARD_POST_AUDIENCES,
  type PostCommentView,
  type PostView,
} from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  commentsSince,
  likeComment,
  readComments,
  writeComment,
} from "../api/feed";
import { BoardControls } from "../ui/BoardZone";
import { FIELD, HINT, PRIMARY_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { usePoll } from "../ui/use-poll";
import { authorLabel, Avatar, Byline, writtenAt } from "./Author";
import { feedFailureKey, feedReadFailureKey } from "./feed-failures";
import { COMMENT_MAX_LENGTH, POLL_INTERVAL_MS } from "./feed-limits";
import { copyText, MoreMenu } from "./MoreMenu";
import { PostText } from "./PostText";

/** The thread as this client holds it. */
interface Thread {
  /** Every comment read so far, oldest first. */
  comments: readonly PostCommentView[];
  /** The cursor for the page before the oldest one here, or null at the first. */
  earlier: string | null;
}

/**
 * The most pages one catch-up reads before it leaves the rest to the next
 * interval.
 *
 * A thread left open while a long conversation happened under it is caught up a
 * page at a time without waiting out an interval per page, as the feed's poll
 * is - but not without end: ten pages is five hundred comments, and whatever is
 * past them is read four seconds later from where this one stopped.
 */
const PAGES_PER_CATCH_UP = 10;

export interface PostThreadProps {
  post: PostView;
  /** The reader's own name, as the author picker offers it. */
  viewerName?: string;
  /**
   * Whether the reader may answer as Styrelsen. The picker is offered under a
   * post in Alla, Styrelsen or Administratörer, which is where the server
   * takes it.
   */
  mayPostAsBoard?: boolean;
  /**
   * Called once comments have arrived in the thread - the reader's own or a
   * neighbour's - so the post's own count can be read again from the server
   * rather than counted up here.
   */
  onCommented: () => void;
}

/**
 * A post's comments, opened under it.
 *
 * Flat and oldest first, which is how a conversation is read: there are no
 * replies to replies, because a thread that branches is one where the answer to
 * a question is three screens away from it. The newest page is read first, so a
 * long thread opens where the conversation is, and the comments before it are a
 * press away above.
 *
 * ## The thread arrives from both ends
 *
 * Backwards a page at a time, from the cursor before the oldest comment held,
 * when the reader presses for earlier comments. Forwards from the newest comment
 * held, which is how everything written after the thread was opened arrives:
 * by poll while it is open (ADR 0010, paused while the tab is hidden), and at
 * once after the reader writes. Forwards rather than the newest page again,
 * because fifty neighbours answering while the thread was open would otherwise
 * leave the first of their comments behind the newest fifty, between two pages
 * no cursor reaches.
 *
 * ## Nothing is optimistic
 *
 * A comment is not put on the thread by this screen: the write clears the field
 * and asks what has been written since, and what the reader sees is what came
 * back. The post's count is read again too, through `onCommented`.
 *
 * ## No delete, and the strike is the board's
 *
 * There is no control that removes a comment, by its author or by anybody else.
 * A struck comment stays where it is with its author's name on it; what
 * changes is the text, which the server withholds from everybody but its author
 * and the board - and this thread renders what the server answered rather than
 * deciding it.
 *
 * ## Answering as Styrelsen
 *
 * Under a post to Alla, Styrelsen or Administratörer - wherever the board may
 * write as Styrelsen, and never in a group - a board seat holder chooses who
 * the comment is from: themselves, or "Styrelsen via" themselves. A comment
 * always names its writer, because it is one person's words on that person's
 * clock; what the choice adds is that the writer answers for the board. The
 * choice carries the board's sign, because nobody else is offered it.
 */
export function PostThread({
  post,
  viewerName = "",
  mayPostAsBoard = false,
  onCommented,
}: PostThreadProps): ReactElement {
  const { t } = useTranslation();
  const offersBoard =
    mayPostAsBoard && BOARD_POST_AUDIENCES.includes(post.audience.kind);
  const [asBoard, setAsBoard] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  const postId = post.id;

  /*
   * Where the next catch-up asks from: the newest comment held, as the API
   * spelled its cursor, or null while the thread holds none. A ref rather than
   * state, because nothing on screen depends on it and the catch-up reads it
   * between requests, where a value out of a render's closure would be the one
   * the callback was built with.
   */
  const latest = useRef<string | null>(null);

  /*
   * A catch-up in flight, so two never ask from the same cursor at once, and
   * the one asked for meanwhile. A write landing while the poll is mid-read is
   * not dropped: it is run once the read in flight is done, from the cursor
   * that read left.
   */
  const catchingUp = useRef(false);
  const queued = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    let wanted = true;
    // Inside an async call rather than as a bare one: nothing here reaches
    // state before the request comes back, and the shape says so.
    void (async () => {
      const result = await readComments({ postId, before: null });
      if (!wanted) {
        return;
      }
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setFailure(null);
      // Unless a catch-up got there first, which left a cursor no older.
      latest.current ??= result.value.latest;
      setThread((held) => ({
        comments: merged(held?.comments ?? [], result.value.comments),
        earlier: held === null ? result.value.earlier : held.earlier,
      }));
    })();
    return () => {
      wanted = false;
    };
  }, [postId]);

  /**
   * Reads what has been written since the newest comment held, and puts it
   * under the thread.
   *
   * A failure is left silent, as the feed's poll leaves one: the thread on
   * screen is still what the server last said, and a notice appearing by
   * itself every four seconds on a flaky connection would be worse than the
   * wait for the next answer.
   */
  const catchUpOnce = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      let after = latest.current;
      let arrived = false;

      if (after === null) {
        /*
         * Nothing held to ask forwards from - a thread nobody had answered
         * when it was opened, or one whose first read did not answer - so the
         * newest page is read again instead.
         */
        const result = await readComments({ postId, before: null });
        if (!stillWanted() || !result.ok) {
          return;
        }
        latest.current ??= result.value.latest;
        arrived = result.value.comments.length > 0;
        setThread((held) =>
          held === null || held.comments.length === 0
            ? { comments: result.value.comments, earlier: result.value.earlier }
            : {
                comments: merged(held.comments, result.value.comments),
                earlier: held.earlier,
              },
        );
        // A read that answers clears the one that did not. Nothing held means
        // nothing to press for earlier, so the only failure held here is the
        // first read's, and it is no longer true.
        setFailure(null);
      } else {
        for (let page = 0; page < PAGES_PER_CATCH_UP; page += 1) {
          /*
           * The poll's timer stops when the tab is hidden, but a catch-up
           * already on its way is still wanted, so it would go on asking for
           * the pages that follow. It stops here instead: the cursor is held,
           * and the poll's attempt on the tab coming back goes on from it.
           */
          if (document.visibilityState !== "visible") {
            break;
          }
          const result = await commentsSince({ postId, after });
          if (!stillWanted() || !result.ok) {
            break;
          }
          const update = result.value;
          // Carried through the loop rather than re-read, and written through
          // so the next catch-up goes on from here.
          after = update.cursor;
          latest.current = after;
          if (update.comments.length > 0) {
            arrived = true;
            setThread((held) =>
              held === null
                ? held
                : { ...held, comments: merged(held.comments, update.comments) },
            );
          }
          if (!update.more) {
            break;
          }
        }
      }

      if (arrived && stillWanted()) {
        onCommented();
      }
    },
    [postId, onCommented],
  );

  const catchUp = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      if (catchingUp.current) {
        queued.current = stillWanted;
        return;
      }
      catchingUp.current = true;
      try {
        let next: (() => boolean) | null = stillWanted;
        while (next !== null) {
          queued.current = null;
          await catchUpOnce(next);
          next = queued.current;
        }
      } finally {
        catchingUp.current = false;
      }
    },
    [catchUpOnce],
  );

  /*
   * On once the first read has answered, either way: a thread whose first read
   * failed is caught up by the poll's own read of the newest page.
   */
  usePoll(catchUp, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: thread !== null || failure !== null,
  });

  const earlier = thread?.earlier ?? null;
  const showEarlier = useCallback(async (): Promise<void> => {
    if (earlier === null) {
      return;
    }
    setReadingEarlier(true);
    const result = await readComments({ postId, before: earlier });
    setReadingEarlier(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setFailure(null);
    setThread((held) =>
      held === null || held.earlier !== earlier
        ? // Applied already, or overtaken: applying it again would show its
          // comments twice.
          held
        : {
            comments: merged(held.comments, result.value.comments),
            earlier: result.value.earlier,
          },
    );
  }, [postId, earlier]);

  const send = useSaveAction(writeComment, () => {
    setDraft("");
    // A read rather than an append. The post's count is read again once the
    // comment has arrived, by `onCommented`.
    void catchUp(() => true);
  });
  const sending = send.state.kind === "saving";

  /**
   * A like is answered with the count as it stands, which is what is shown:
   * the server's number rather than one this screen added one to. One at a
   * time, so a second press cannot ask for the opposite of an answer it has
   * not seen.
   */
  const [liking, setLiking] = useState<string | null>(null);
  const [likeFailure, setLikeFailure] = useState<ApiFailure | null>(null);
  const toggleLike = async (comment: PostCommentView): Promise<void> => {
    setLiking(comment.id);
    const result = await likeComment({
      commentId: comment.id,
      liked: !comment.liked,
    });
    setLiking(null);
    if (!result.ok) {
      setLikeFailure(result.failure);
      return;
    }
    setLikeFailure(null);
    setThread((held) =>
      held === null
        ? held
        : {
            ...held,
            comments: held.comments.map((each) =>
              each.id === comment.id ? { ...each, ...result.value } : each,
            ),
          },
    );
  };

  const failureKey =
    send.state.kind === "failed"
      ? feedFailureKey(send.state.failure)
      : likeFailure !== null
        ? feedFailureKey(likeFailure)
        : failure === null
          ? null
          : feedReadFailureKey(failure);

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-3"
      aria-label={t("feed.thread.label")}
    >
      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}

      {thread === null ? (
        failure === null ? (
          <p role="status" className="text-small text-ink-muted">
            {t("feed.thread.reading")}
          </p>
        ) : null
      ) : (
        <>
          {thread.earlier === null ? null : (
            <div>
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={readingEarlier}
                onClick={() => {
                  void showEarlier();
                }}
              >
                {readingEarlier
                  ? t("feed.thread.earlierReading")
                  : t("feed.thread.earlier")}
              </button>
            </div>
          )}

          {thread.comments.length === 0 ? (
            <p className="text-small text-ink-muted">
              {t("feed.thread.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {thread.comments.map((comment) => (
                <Comment
                  key={comment.id}
                  comment={comment}
                  liking={liking !== null}
                  onLike={() => {
                    void toggleLike(comment);
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {post.commentsAllowed ? (
        <LockedForm
          className="flex flex-wrap items-end gap-2"
          locked={sending}
          focusFallback={draftRef}
          onSend={() => {
            void send.submit({
              postId,
              body: draft,
              ...(offersBoard && asBoard ? { asBoard: true } : {}),
            });
          }}
        >
          {offersBoard ? (
            <BoardControls>
              <label className="flex flex-col gap-1.5">
                <span className="text-label text-ink-muted uppercase">
                  {t("feed.thread.as")}
                </span>
                <select
                  className={FIELD}
                  value={asBoard ? "board" : "self"}
                  onChange={(event) => {
                    setAsBoard(event.target.value === "board");
                  }}
                >
                  <option value="self">{viewerName}</option>
                  <option value="board">
                    {t("feed.thread.asBoard", { name: viewerName })}
                  </option>
                </select>
              </label>
            </BoardControls>
          ) : null}
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="sr-only">{t("feed.thread.field")}</span>
            <input
              ref={draftRef}
              type="text"
              className={FIELD}
              value={draft}
              placeholder={t("feed.thread.placeholder")}
              maxLength={COMMENT_MAX_LENGTH}
              required
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            className={PRIMARY_BUTTON}
            disabled={sending || draft.trim() === ""}
          >
            {sending ? t("feed.thread.sending") : t("feed.thread.submit")}
          </button>
        </LockedForm>
      ) : (
        <p className={HINT}>{t("feed.thread.closed")}</p>
      )}
    </section>
  );
}

/**
 * One comment: who wrote it, when, what they wrote, its likes and its ⋯.
 *
 * The ⋯ offers copying the text and nothing else. There is no delete, and
 * reporting a comment to the board is not something the board can answer yet.
 */
function Comment({
  comment,
  liking,
  onLike,
}: {
  comment: PostCommentView;
  /** Whether a like in this thread is on its way. */
  liking: boolean;
  onLike: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState<boolean | null>(null);
  const body = comment.body;

  return (
    <li className="flex gap-3">
      <Avatar
        author={comment.author}
        byBoard={comment.byBoard}
        size="comment"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-small font-semibold">
            <Byline author={comment.author} byBoard={comment.byBoard} />
          </span>
          <time
            dateTime={comment.createdAt}
            className="font-data text-data text-ink-muted"
          >
            {writtenAt(comment.createdAt, i18n.language)}
          </time>
          {comment.editedAt === null ? null : (
            <span className="text-small text-ink-muted">
              {t("feed.edited")}
            </span>
          )}
          {comment.struckAt === null ? null : (
            <span className="inline-flex items-center rounded-control border-l-4 border-warn bg-warn-soft px-2 py-1 text-chip text-ink uppercase">
              {t("feed.struck")}
            </span>
          )}
          <span className="ml-auto">
            <MoreMenu
              label={t("feed.thread.more", {
                author: authorLabel(comment.author, t),
              })}
              actions={
                body === null
                  ? []
                  : [
                      {
                        label: t("feed.copyText"),
                        onSelect: () => {
                          void copyText(body).then(setCopied);
                        },
                      },
                    ]
              }
            />
          </span>
        </div>

        {body === null ? (
          <p className="text-small text-ink-muted">
            {t("feed.thread.struckWithheld")}
          </p>
        ) : (
          <PostText
            text={body}
            className={
              comment.struckAt === null
                ? ""
                : "line-through decoration-line-strong"
            }
          />
        )}

        {copied === null ? null : (
          <p role="status" className={HINT}>
            {copied ? t("feed.copied") : t("feed.copyFailed")}
          </p>
        )}

        <div>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1 text-small text-ink-muted hover:text-ink"
            aria-pressed={comment.liked}
            disabled={liking}
            onClick={onLike}
          >
            {comment.liked ? t("feed.liked") : t("feed.like")}
            <span className="font-data text-data">{comment.likes}</span>
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * The comments on screen with a page the server answered, oldest first.
 *
 * By identifier, the answer's copy winning, and in the order the API's cursor
 * walks: by when each was written, then by identifier for two written in the
 * same millisecond. The instants are compared as the ISO strings the API wrote
 * them in, which is comparing the instants, because every one is in the same
 * UTC form.
 */
function merged(
  held: readonly PostCommentView[],
  arriving: readonly PostCommentView[],
): readonly PostCommentView[] {
  const byId = new Map(held.map((comment) => [comment.id, comment]));
  for (const comment of arriving) {
    byId.set(comment.id, comment);
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt < b.createdAt
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
}
