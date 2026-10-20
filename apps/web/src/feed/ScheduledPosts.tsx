import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { Panel } from "../ui/Panel";
import { audienceName } from "./AudiencePanel";
import { Byline, writtenAt } from "./Author";

export interface ScheduledPostsProps {
  /** The board's posts waiting for their instant, soonest first. */
  posts: readonly PostView[];
  /**
   * Whether each says which audience it is for: on the whole feed, which holds
   * the scheduled posts of every audience, and not inside one.
   */
  showAudience: boolean;
}

/**
 * The board's posts that wait for their instant ("Schemalägg publicering").
 *
 * Beside the feed rather than in it, because a post's place in the feed is its
 * instant: one placed in the future would sit above everything written before
 * it arrives. Shown to the board alone - the server answers nobody else with
 * them - and each one says when it will appear, from whom, and what it will do
 * when it does. Changing or removing one to Alla is the news screen's, where
 * every draft for the house is; one to Styrelsen or Administratörer is that
 * audience's alone and on no news screen, so the link to that screen is shown
 * only while one of the posts here is to Alla. The instant it appears, it leaves
 * this list and arrives in the feed with the next poll.
 *
 * A panel with its own heading, because it stands in the board's zone beside
 * the report queue, and each of the board's panels there says what it is.
 */
export function ScheduledPosts({
  posts,
  showAudience,
}: ScheduledPostsProps): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <Panel
      title={t("feed.scheduled.title")}
      description={t("feed.scheduled.intro")}
    >
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
              {showAudience
                ? ` · ${t("feed.to", { audience: audienceName(post.audience, t) })}`
                : null}
            </p>
          </li>
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
