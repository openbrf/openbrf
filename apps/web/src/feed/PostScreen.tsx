import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import { fetchPost } from "../api/feed";
import type { Viewer } from "../api/instance";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { feedReadFailureKey } from "./feed-failures";
import { PostCard } from "./PostCard";

export interface PostScreenProps {
  viewer: Viewer;
  postId: string;
}

/**
 * One post on a page of its own, at its own address.
 *
 * What a news mailing, a report or an issue report links to: the post, with its
 * comments open under it. The address names the post and nothing else, and the
 * server answers it on exactly the terms it answers the feed - so a link to a
 * group's post, pasted to somebody outside the group, opens the same refusal a
 * post that never existed does, and tells them nothing about the group.
 *
 * Read once, and again after a comment changes its count. The page is not
 * polled: it is one post, and what changes under it - the comments - is read by
 * the thread itself whenever the reader writes one.
 */
export function PostScreen({ viewer, postId }: PostScreenProps): ReactElement {
  const { t } = useTranslation();
  const [post, setPost] = useState<PostView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const read = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      const result = await fetchPost({ postId });
      if (!stillWanted()) {
        return;
      }
      if (result.ok) {
        setPost(result.value);
        setFailure(null);
      } else {
        setFailure(result.failure);
      }
    },
    [postId],
  );

  useEffect(() => {
    let wanted = true;
    // Inside an async call rather than as a bare one: nothing here reaches
    // state before the request comes back, and the shape says so.
    void (async () => {
      await read(() => wanted);
    })();
    return () => {
      wanted = false;
    };
  }, [read]);

  /*
   * The post on screen, and only while it is the one the address names: the
   * page is kept when the address changes to another post, and for that moment
   * the state still holds the last one.
   */
  const shown = post !== null && post.id === postId ? post : null;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <Link to="/feed" className={SECONDARY_BUTTON}>
          {t("feed.backToFeed")}
        </Link>
      </div>

      {failure !== null && shown === null ? (
        <Notice tone="danger" live>
          {t(feedReadFailureKey(failure))}
        </Notice>
      ) : shown === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("feed.reading")}
        </p>
      ) : (
        <PostCard
          post={shown}
          viewerPersonId={viewer.personId}
          standalone
          showAudience
          onChange={(patch) => {
            setPost((held) =>
              held === null || held.id !== postId
                ? held
                : { ...held, ...patch },
            );
          }}
          onRefresh={() => {
            void read(() => true);
          }}
        />
      )}
    </div>
  );
}
