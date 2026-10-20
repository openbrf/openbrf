import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { cancelBoardPost } from "../api/feed";
import { CAUTION_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
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
  /** Called with a post the server has cancelled, to take it off the list. */
  onCancelled: (postId: string) => void;
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
 * ## Cancelling one
 *
 * Each can be cancelled here, while it waits: nobody but the board has seen it,
 * so it goes as if it had never been written. This is the only place one to
 * Styrelsen or Administratörer can be cancelled at all, because such a post is
 * that audience's alone and on no news screen. Changing one to Alla is still
 * the news screen's, where every draft for the house is, so the link to that
 * screen is shown while one of the posts here is to Alla. Cancelling asks
 * twice, because it cannot be undone.
 *
 * A panel with its own heading, because it stands in the board's zone beside
 * the report queue, and each of the board's panels there says what it is.
 */
export function ScheduledPosts({
  posts,
  showAudience,
  onCancelled,
}: ScheduledPostsProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Panel
      title={t("feed.scheduled.title")}
      description={t("feed.scheduled.intro")}
    >
      <ol className="flex flex-col gap-3">
        {posts.map((post) => (
          <ScheduledPost
            key={post.id}
            post={post}
            showAudience={showAudience}
            onCancelled={onCancelled}
          />
        ))}
      </ol>
      {posts.some((post) => post.audience.kind === "ALL") ? (
        <p>
          <Link
            to="/admin/site/news"
            className="text-small text-trust underline"
          >
            {t("feed.scheduled.manage")}
          </Link>
        </p>
      ) : null}
    </Panel>
  );
}

/** One scheduled post, and the two presses that cancel it. */
function ScheduledPost({
  post,
  showAudience,
  onCancelled,
}: {
  post: PostView;
  showAudience: boolean;
  onCancelled: (postId: string) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const cancel = useSaveAction(cancelBoardPost, () => {
    onCancelled(post.id);
  });
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
      {cancel.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(feedFailureKey(cancel.state.failure))}
        </Notice>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-small">{t("feed.scheduled.cancelConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={CAUTION_BUTTON}
              disabled={cancel.state.kind === "saving"}
              onClick={() => {
                void cancel.submit({ postId: post.id });
              }}
            >
              {cancel.state.kind === "saving"
                ? t("feed.scheduled.cancelling")
                : t("feed.scheduled.cancelSubmit", { title })}
            </button>
            <button
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                cancel.reset();
                setConfirming(false);
              }}
            >
              {t("feed.scheduled.cancelKeep")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={QUIET_BUTTON}
            aria-label={t("feed.scheduled.cancelFor", { title })}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t("feed.scheduled.cancel")}
          </button>
        </div>
      )}
    </li>
  );
}
