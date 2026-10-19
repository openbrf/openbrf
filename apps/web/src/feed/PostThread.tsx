import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { PostCommentView, PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import { likeComment, readComments, writeComment } from "../api/feed";
import { FIELD, HINT, PRIMARY_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { authorLabel, Avatar, Byline, writtenAt } from "./Author";
import { feedFailureKey, feedReadFailureKey } from "./feed-failures";
import { COMMENT_MAX_LENGTH } from "./feed-limits";
import { copyText, MoreMenu } from "./MoreMenu";
import { PostText } from "./PostText";

/** The thread as this client holds it. */
interface Thread {
  /** Every comment read so far, oldest first. */
  comments: readonly PostCommentView[];
  /** The cursor for the page before the oldest one here, or null at the first. */
  earlier: string | null;
}

export interface PostThreadProps {
  post: PostView;
  /**
   * Called once a comment has been written, so the post's own count can be
   * read again from the server rather than counted up here.
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
 * ## Nothing is optimistic
 *
 * A comment is not put on the thread by this screen: the write clears the field
 * and reads the thread again, and what the reader sees is what came back. The
 * post's count is read again too, through `onCommented`.
 *
 * ## No delete, and the strike is the board's
 *
 * There is no control that removes a comment, by its author or by anybody else.
 * A struck comment stays where it is with its author's name on it; what
 * changes is the text, which the server withholds from everybody but its author
 * and the board - and this thread renders what the server answered rather than
 * deciding it.
 */
export function PostThread({
  post,
  onCommented,
}: PostThreadProps): ReactElement {
  const { t } = useTranslation();
  const [thread, setThread] = useState<Thread | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  const postId = post.id;

  /**
   * Reads the newest page and puts it together with what is held.
   *
   * Merged by identifier rather than replaced: a reader who has pressed for the
   * comments before this page keeps them, and a comment already on screen is
   * taken in its newest state - its likes may have moved.
   */
  const readNewest = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      const result = await readComments({ postId, before: null });
      if (!stillWanted()) {
        return;
      }
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setFailure(null);
      setThread((held) => ({
        comments: merged(held?.comments ?? [], result.value.comments),
        // The held cursor wins once there is one: it points behind the oldest
        // comment on screen, which a newest page's cursor does not.
        earlier: held === null ? result.value.earlier : held.earlier,
      }));
    },
    [postId],
  );

  useEffect(() => {
    let wanted = true;
    // Inside an async call rather than as a bare one: nothing here reaches
    // state before the request comes back, and the shape says so.
    void (async () => {
      await readNewest(() => wanted);
    })();
    return () => {
      wanted = false;
    };
  }, [readNewest]);

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
    // A read rather than an append, and the post's count read again with it.
    void readNewest(() => true);
    onCommented();
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
          className="flex items-end gap-2"
          locked={sending}
          focusFallback={draftRef}
          onSend={() => {
            void send.submit({ postId, body: draft });
          }}
        >
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
            {t("feed.struckWithheld")}
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
