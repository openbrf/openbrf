import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { HINT } from "../ui/controls";
import { Byline, writtenAt } from "./Author";

export interface ScheduledPostsProps {
  /** The board's posts waiting for their instant, soonest first. */
  posts: readonly PostView[];
}

/**
 * The board's posts that wait for their instant ("Schemalägg publicering").
 *
 * Beside the feed rather than in it, because a post's place in the feed is its
 * instant: one placed in the future would sit above everything written before
 * it arrives. Shown to the board alone - the server answers nobody else with
 * them - and each one says when it will appear, from whom, and what it will do
 * when it does. Changing or removing one is the news screen's, where every
 * draft is; the instant it appears, it leaves this list and arrives in the
 * feed with the next poll.
 */
export function ScheduledPosts({ posts }: ScheduledPostsProps): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>{t("feed.scheduled.intro")}</p>
      <ol className="flex flex-col gap-3">
        {posts.map((post) => (
          <li
            key={post.id}
            className="flex flex-col gap-1 rounded-control border border-line p-3"
          >
            <p className="text-small text-ink-muted">
              {post.scheduledAt === null
                ? null
                : t("feed.scheduled.at", {
                    when: writtenAt(post.scheduledAt, i18n.language),
                  })}
            </p>
            <p className="text-body font-semibold">
              {post.news?.title ?? null}
            </p>
            <p className="text-small text-ink-muted">
              <Byline author={post.author} byBoard={post.byBoard} />
              {post.important ? ` · ${t("feed.important")}` : null}
              {post.pinned ? ` · ${t("feed.pinned")}` : null}
            </p>
          </li>
        ))}
      </ol>
      <p>
        <Link to="/admin/site/news" className="text-small text-trust underline">
          {t("feed.scheduled.manage")}
        </Link>
      </p>
    </div>
  );
}
