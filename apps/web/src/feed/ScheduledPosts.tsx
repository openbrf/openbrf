import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { withdrawBoardPost } from "../api/feed";
import { BoardMark } from "../ui/BoardMark";
import { CAUTION_BUTTON, PANEL, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { audienceName } from "./AudiencePanel";
import { Byline, writtenAt } from "./Author";
import { feedFailureKey } from "./feed-failures";

export interface ScheduledPostsProps {
  /** The board's posts waiting for their instant, soonest first. */
  posts: readonly PostView[];
  /**
   * Whether each says which audience it is for: on the whole feed, which holds
   * the scheduled posts of every audience, and not inside one.
   */
  showAudience: boolean;
  /** Called with a post the server has withdrawn, to take it off the list. */
  onWithdrawn: (postId: string) => void;
}

/**
 * The board's posts that wait for their instant ("Schemalägg publicering").
 *
 * Beside the feed rather than in it, because a post's place in the feed is its
 * instant: one placed in the future would sit above everything written before
 * it arrives. Shown to the board alone - the server answers nobody else with
 * them - and each one says when it will appear, from whom, and what it will do
 * when it does. The instant it appears, it leaves this list and arrives in the
 * feed with the next poll.
 *
 * ## Withdrawing one
 *
 * Each can be withdrawn here, while it waits: nobody but the board has seen it,
 * so it goes as if it had never been written. This is the only place one to
 * Styrelsen or Administratörer can be withdrawn at all, because such a post is
 * that audience's alone and on no news screen. Changing one to Alla is still
 * the news screen's, where every draft for the house is, so the link to that
 * screen is shown while one of the posts here is to Alla. Withdrawing asks
 * twice, because it cannot be undone.
 *
 * ## The board's, inside a house page
 *
 * The one thing of the board's the feed keeps. These are the board's own posts,
 * written in this feed's composer and arriving in it, so withdrawing one is an
 * act done in place rather than a page under /board (ADR 0049, decision 2), and
 * the panel is led by the board's sign as an edit control on the archive's
 * shelf is. A region named by the sign and the heading together, so a screen
 * reader announces whose the list is before what it is.
 */
export function ScheduledPosts({
  posts,
  showAudience,
  onWithdrawn,
}: ScheduledPostsProps): ReactElement {
  const { t } = useTranslation();
  const signId = useId();
  const titleId = useId();

  return (
    <section
      aria-labelledby={`${signId} ${titleId}`}
      className={`flex flex-col gap-4 ${PANEL}`}
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <BoardMark id={signId} />
          <h2 id={titleId} className="text-title">
            {t("feed.scheduled.title")}
          </h2>
        </div>
        <p className="text-small text-ink-muted">{t("feed.scheduled.intro")}</p>
      </header>
      <ol className="flex flex-col gap-3">
        {posts.map((post) => (
          <ScheduledPost
            key={post.id}
            post={post}
            showAudience={showAudience}
            onWithdrawn={onWithdrawn}
          />
        ))}
      </ol>
      {posts.some((post) => post.audience.kind === "ALL") ? (
        <p>
          <Link to="/board/news" className="text-small text-trust underline">
            {t("feed.scheduled.manage")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/** One scheduled post, and the two presses that withdraw it. */
function ScheduledPost({
  post,
  showAudience,
  onWithdrawn,
}: {
  post: PostView;
  showAudience: boolean;
  onWithdrawn: (postId: string) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const withdraw = useSaveAction(
    withdrawBoardPost,
    () => {
      onWithdrawn(post.id);
    },
    (failure) => {
      // Withdrawn already, by another board member: it is gone either way.
      if (failure.reason === "post-not-found") {
        onWithdrawn(post.id);
      }
    },
  );
  const title = post.news?.title ?? "";

  return (
    <li className="flex flex-col gap-1 rounded-control border border-line p-3">
      <p className="text-small text-ink-muted">
        {post.scheduledAt === null
          ? null
          : t("feed.scheduled.at", {
              when: writtenAt(post.scheduledAt, i18n.language),
            })}
      </p>
      <p className="text-body font-semibold">{title}</p>
      <p className="text-small text-ink-muted">
        <Byline author={post.author} byBoard={post.byBoard} />
        {post.important ? ` · ${t("feed.important")}` : null}
        {post.pinned ? ` · ${t("feed.pinned")}` : null}
        {showAudience
          ? ` · ${t("feed.to", { audience: audienceName(post.audience, t) })}`
          : null}
      </p>
      {withdraw.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(feedFailureKey(withdraw.state.failure))}
        </Notice>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-small">{t("feed.scheduled.withdrawConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={CAUTION_BUTTON}
              disabled={withdraw.state.kind === "saving"}
              onClick={() => {
                void withdraw.submit({ postId: post.id });
              }}
            >
              {withdraw.state.kind === "saving"
                ? t("feed.scheduled.withdrawing")
                : t("feed.scheduled.withdrawSubmit", { title })}
            </button>
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                withdraw.reset();
                setConfirming(false);
              }}
            >
              {t("feed.scheduled.withdrawKeep")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={QUIET_BUTTON}
            aria-label={t("feed.scheduled.withdrawFor", { title })}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t("feed.scheduled.withdraw")}
          </button>
        </div>
      )}
    </li>
  );
}
