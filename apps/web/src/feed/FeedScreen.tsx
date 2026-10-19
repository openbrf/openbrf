import { useEffect, useState, type ReactElement } from "react";
import type { AudienceView, PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { markAudienceRead } from "../api/feed";
import {
  FIELD,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { BoardZone } from "../ui/BoardZone";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { audienceName, AudiencePanel } from "./AudiencePanel";
import { feedReadFailureKey } from "./feed-failures";
import { SEARCH_DELAY_MS, SEARCH_MAX_LENGTH } from "./feed-limits";
import { FilterDialog, type PostFilter } from "./FilterDialog";
import { PostCard } from "./PostCard";
import { type ComposerAudience, PostComposer } from "./PostComposer";
import { ScheduledPosts } from "./ScheduledPosts";
import { ReportQueue } from "./ReportQueue";
import { useAudiences } from "./use-audiences";
import { useFeed } from "./use-feed";

export interface FeedScreenProps {
  viewer: Viewer;
}

/**
 * The feed (flödet): one stream of posts for the house, the board and each
 * group, newest first with the pinned ones on top (ADR 0026).
 *
 * Every post is for one audience, and a reader sees the posts of the audiences
 * they are in and nothing else. Which audiences those are is the server's
 * answer, and so is every post: the search, the filter and the audience chosen
 * on the side all narrow a read the server answers inside the reader's own
 * audiences, so nothing on this screen is a way to see more.
 *
 * The pieces are their own components, each with its own tests: the audience
 * panel (`AudiencePanel`, with a group's own `GroupPanel`), the card a post is
 * shown on (`PostCard`, with its thread in `PostThread`), the composer
 * (`PostComposer`), the filter (`FilterDialog`) and the board's queue of reports
 * (`ReportQueue`). What this screen holds is which audience and which filter are
 * chosen, and the two hooks that read: `useAudiences` and `useFeed`.
 *
 * ## The read marker is the screen's own act
 *
 * Each audience's marker is posted with the instant of the newest post of that
 * audience actually on screen, rather than with the moment of the call - an
 * audience marked read at "now" would mark a post read that was written while
 * the request was in flight. Only while the feed is not narrowed by a search or
 * a filter: a narrowed feed leaves out posts the reader has not seen, and its
 * newest is no measure of how far they have read.
 */
export function FeedScreen({ viewer }: FeedScreenProps): ReactElement {
  const { t } = useTranslation();
  const audiences = useAudiences();
  const viewerName = `${viewer.firstName} ${viewer.lastName}`.trim();

  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [postFilter, setPostFilter] = useState<PostFilter>({
    from: null,
    important: false,
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  /*
   * The search is asked once the reader stops typing, rather than once per
   * letter on the way to the word they meant.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);

  const list = audiences.list;
  /*
   * The audience that is open, and only while it is on the list. An audience
   * the reader has just left is gone from the list the choice was made against,
   * and the whole feed is what is left to show.
   */
  const open = list?.audiences.find((each) => each.id === selected) ?? null;
  const audienceId = open?.id ?? null;
  const all = list?.audiences.find((each) => each.kind === "ALL") ?? null;
  const writeTo = open ?? all;
  const mayPostAsBoard = list?.mayPostAsBoard ?? false;

  const feed = useFeed(
    audienceId,
    search,
    postFilter.from,
    postFilter.important,
    list !== null && list.audiences.length > 0,
  );
  const held = feed.feed;
  const narrowed =
    search.trim() !== "" || postFilter.from !== null || postFilter.important;

  /*
   * The newest post of each audience on screen, which is what its marker is
   * posted at. Named as a string, so the effect below runs when it moves and
   * not on every poll that brought nothing.
   */
  const newestByAudience =
    narrowed || held === null ? "" : newestPerAudience(held.posts);
  const { markedRead } = audiences;
  useEffect(() => {
    if (newestByAudience === "") {
      return;
    }
    let abandoned = false;
    const marks = JSON.parse(newestByAudience) as [string, string][];
    for (const [audience, readAt] of marks) {
      void markAudienceRead({ audienceId: audience, readAt }).then((result) => {
        // Nothing is said about a marker that did not land. It decides a count
        // on a screen and nothing about what anybody may read.
        if (!abandoned && result.ok) {
          markedRead(audience);
        }
        return result;
      });
    }
    return () => {
      abandoned = true;
    };
  }, [newestByAudience, markedRead]);

  if (list === null && audiences.failure === "failed") {
    return (
      <Notice tone="danger" live>
        {t("feed.loadFailed")}
      </Notice>
    );
  }

  if (list === null && audiences.failure === "notOffered") {
    return (
      <Panel title={t("feed.title")} description={t("feed.intro")}>
        <Notice tone="info">{t("feed.notOffered")}</Notice>
      </Panel>
    );
  }

  if (list === null) {
    return (
      <p role="status" className="text-body text-ink-muted">
        {t("feed.loading")}
      </p>
    );
  }

  /*
   * The administrator's answer, and it has to be a sentence rather than an
   * empty feed. They hold every capability, hold no seat and live nowhere, so
   * the navigation offers them this destination and the endpoints let them in -
   * and what they find is that the feed is for the people who live here and the
   * board, and that this account is neither.
   */
  const moderates = viewer.capabilities.includes("chat:moderate");
  const named = (audience: AudienceView): ComposerAudience => ({
    id: audience.id,
    kind: audience.kind,
    name: audienceName(audience, t),
  });
  /*
   * What "Till" offers the board: Alla and Styrelsen, and the group that is
   * open when a board member who lives here has one open. Nobody else chooses:
   * they write to the audience in front of them.
   */
  const choices = mayPostAsBoard
    ? list.audiences
        .filter(
          (each) =>
            each.kind === "ALL" ||
            each.kind === "BOARD" ||
            each.id === open?.id,
        )
        .map(named)
    : [];

  if (list.audiences.length === 0 && !list.mayCreateGroup) {
    /*
     * The report queue stays beside it for an account holding the capability
     * to answer reports, and says the queue is the board's: an account with
     * every capability and no seat is told that, rather than shown an empty
     * queue - which would be a claim about groups it may not be told exist.
     */
    return (
      <div className="flex flex-col gap-6">
        <Panel title={t("feed.title")} description={t("feed.intro")}>
          <Notice tone="info">{t("feed.noAudience")}</Notice>
        </Panel>
        {moderates ? (
          <BoardZone title={t("feed.boardZone")}>
            <ReportQueue />
          </BoardZone>
        ) : null}
      </div>
    );
  }

  const filtersOn =
    (postFilter.from === null ? 0 : 1) + (postFilter.important ? 1 : 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-headline">
            {open === null ? t("feed.title") : audienceName(open, t)}
          </h1>
          <p className="text-small text-ink-muted">
            {open === null
              ? t("feed.intro")
              : open.kind === "GROUP"
                ? t("feed.audience.groupIntro")
                : open.kind === "BOARD"
                  ? t("feed.audience.boardIntro")
                  : t("feed.audience.allIntro")}
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-3">
          <label className={`${LABEL} min-w-48 flex-1`}>
            {t("feed.search")}
            <input
              type="search"
              className={FIELD}
              value={typed}
              maxLength={SEARCH_MAX_LENGTH}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            aria-haspopup="dialog"
            onClick={() => {
              setFilterOpen(true);
            }}
          >
            {filtersOn === 0
              ? t("feed.filter.open")
              : t("feed.filter.openActive", { count: filtersOn })}
          </button>
        </div>

        {writeTo === null ? null : (
          <button
            type="button"
            className={`${PRIMARY_BUTTON} justify-start`}
            aria-haspopup="dialog"
            onClick={() => {
              setComposerOpen(true);
            }}
          >
            {t("feed.composer.open")}
          </button>
        )}

        {held?.failure ? (
          <Notice tone="danger" live>
            {t(feedReadFailureKey(held.failure))}
          </Notice>
        ) : null}

        {held === null ? (
          list.audiences.length === 0 ? null : (
            <p role="status" className="text-body text-ink-muted">
              {t("feed.reading")}
            </p>
          )
        ) : held.pinned.length === 0 && held.posts.length === 0 ? (
          held.failure === null ? (
            <p className="text-body text-ink-muted">
              {narrowed ? t("feed.noMatch") : t("feed.empty")}
            </p>
          ) : null
        ) : (
          <ol className="flex flex-col gap-4" aria-label={t("feed.posts")}>
            {[...held.pinned, ...held.posts].map((post) => (
              <li key={post.id}>
                <PostCard
                  post={post}
                  viewerPersonId={viewer.personId}
                  viewerName={viewerName}
                  mayPostAsBoard={mayPostAsBoard}
                  showAudience={open === null}
                  onChange={(patch) => {
                    feed.patchPost(post.id, patch);
                  }}
                  onRefresh={() => {
                    void feed.refreshPost(post.id);
                  }}
                />
              </li>
            ))}
          </ol>
        )}

        {held === null || held.earlier === null ? null : (
          /*
           * Below the posts, because that is where the ones it fetches go: the
           * feed reads newest first, and the reader reaches backwards from the
           * end they have scrolled to.
           */
          <div>
            <button
              type="button"
              className={QUIET_BUTTON}
              disabled={feed.readingEarlier}
              onClick={() => {
                void feed.showEarlier();
              }}
            >
              {feed.readingEarlier
                ? t("feed.earlierReading")
                : t("feed.earlier")}
            </button>
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-6">
        <AudiencePanel
          list={list}
          failure={audiences.failure}
          selected={audienceId}
          onSelect={setSelected}
          onReload={audiences.reload}
          onCreated={(made) => {
            /*
             * Opened as soon as it exists, because somebody who has just made a
             * group made it to write in it. Chosen before the list is read
             * again, so the group opens the moment the list carries it.
             */
            setSelected(made);
            void audiences.reload();
          }}
          onLeft={() => {
            setSelected(null);
            void audiences.reload();
          }}
        />
        {held === null || held.scheduled.length === 0 ? null : (
          <BoardZone title={t("feed.scheduled.title")}>
            <ScheduledPosts posts={held.scheduled} />
          </BoardZone>
        )}
        {moderates ? (
          <BoardZone title={t("feed.boardZone")}>
            <ReportQueue />
          </BoardZone>
        ) : null}
      </aside>

      {filterOpen ? (
        <FilterDialog
          value={postFilter}
          onApply={(chosen) => {
            setPostFilter(chosen);
            setFilterOpen(false);
          }}
          onClose={() => {
            setFilterOpen(false);
          }}
        />
      ) : null}

      {composerOpen && writeTo !== null ? (
        <PostComposer
          audience={named(writeTo)}
          choices={choices}
          authorName={viewerName}
          mayPostAsBoard={mayPostAsBoard}
          onClose={() => {
            setComposerOpen(false);
          }}
          onWritten={(written) => {
            setComposerOpen(false);
            if (written.scheduledAt !== null) {
              // Waiting for its instant, which no read of the feed reaches
              // yet: the write's own answer is what puts it on the board's list.
              feed.putScheduled(written);
              return;
            }
            // A read rather than an append. The post arrives because the server
            // said it is there, which is the same way everybody else's does.
            feed.readNew();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The newest instant of each audience among the posts on screen, as a string
 * an effect can depend on: `[[audienceId, createdAt], ...]` in a fixed order.
 *
 * The posts are newest first, so the first one seen of each audience is its
 * newest. An erased post is passed over, as the server does when it counts what
 * is unread: there is nothing left on it to have read.
 */
function newestPerAudience(posts: readonly PostView[]): string {
  const newest = new Map<string, string>();
  for (const post of posts) {
    if (post.erasedAt === null && !newest.has(post.audience.id)) {
      newest.set(post.audience.id, post.createdAt);
    }
  }
  return newest.size === 0
    ? ""
    : JSON.stringify(
        [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
}
