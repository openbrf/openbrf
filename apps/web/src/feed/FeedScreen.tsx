import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  BOARD_POST_AUDIENCES,
  type AudienceView,
  type PostView,
} from "@openbrf/shared";
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
import { usePoll } from "../ui/use-poll";
import { audienceName, AudiencePanel } from "./AudiencePanel";
import { feedReadFailureKey } from "./feed-failures";
import {
  POLL_INTERVAL_MS,
  SEARCH_DELAY_MS,
  SEARCH_MAX_LENGTH,
} from "./feed-limits";
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
 *
 * ## Every audience's count moves on the poll
 *
 * The list of audiences is read again on the feed's own poll, not only when it
 * is opened or changed, so the count beside an audience nobody has open moves
 * while somebody reads another - and the navigation's badge, which reads the
 * same list, moves with it.
 *
 * ## New since the last visit
 *
 * Each audience's marker is taken as it stood when the feed for a filter was
 * first drawn, because the screen moves it forward a moment later and the live
 * value would make everything read at once. A post is new when somebody else
 * wrote it after that marker, and one line goes below the oldest such post on
 * screen, so everything above it is what arrived since the reader last looked -
 * including what the poll brings while they read. An audience somebody has
 * never opened has no last visit, so nothing in it is drawn as new; and a
 * search or a filter shows no line, because it leaves out posts the reader has
 * not seen.
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
   * Every audience's count, on the feed's own interval and paused while the tab
   * is hidden: what was written in an audience nobody has open is counted
   * there, and on the badge, within one poll.
   */
  const { reload: reloadAudiences } = audiences;
  const pollAudiences = useCallback(async (): Promise<void> => {
    await reloadAudiences();
  }, [reloadAudiences]);
  usePoll(pollAudiences, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: list !== null,
  });

  /*
   * Each audience's marker as it stood when the feed for this filter was first
   * drawn. Taken during the render that first shows it - the screen's marker
   * effect sends the new markers right after - and kept for as long as the
   * filter stays, so the line stays where the reader's last visit ended.
   */
  const [lastVisit, setLastVisit] = useState<LastVisit | null>(null);
  const drawnKey = held?.key ?? null;
  if (drawnKey !== null && list !== null && lastVisit?.key !== drawnKey) {
    setLastVisit({ key: drawnKey, markers: markersOf(list.audiences) });
  }

  /*
   * The newest post of each audience on screen, which is what its marker is
   * posted at. Named as a string, so the effect below runs when it moves and
   * not on every poll that brought nothing.
   */
  const newestByAudience =
    narrowed || held === null
      ? ""
      : newestPerAudience([...held.pinned, ...held.posts]);
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
          markedRead(audience, result.value.readAt);
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

  const moderates = viewer.capabilities.includes("chat:moderate");
  const named = (audience: AudienceView): ComposerAudience => ({
    id: audience.id,
    kind: audience.kind,
    name: audienceName(audience, t),
  });
  /*
   * What "Till" offers the board: Alla, Styrelsen and Administratörer, and the
   * group that is open when a board member who lives here has one open. Nobody
   * else chooses: they write to the audience in front of them.
   */
  const choices = mayPostAsBoard
    ? list.audiences
        .filter(
          (each) =>
            BOARD_POST_AUDIENCES.includes(each.kind) || each.id === open?.id,
        )
        .map(named)
    : [];

  if (list.audiences.length === 0 && !list.mayCreateGroup) {
    /*
     * An account in no audience, and it has to be told so in a sentence rather
     * than shown an empty feed: the navigation offers it this destination and
     * the endpoints let it in. Everybody the server lets in is in one today -
     * the administrator in Administratörer - so this is the answer for an
     * account whose residency, seat or grant has just ended.
     *
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

  const waiting = held?.scheduled ?? [];
  const dividerAfter =
    held === null || narrowed || lastVisit?.key !== held.key
      ? null
      : oldestNewPost(
          [...held.pinned, ...held.posts],
          lastVisit.markers,
          viewer.personId,
        );
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
                  : open.kind === "ADMIN"
                    ? t("feed.audience.adminIntro")
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
              <li key={post.id} className="flex flex-col gap-4">
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
                {post.id === dividerAfter ? (
                  <div
                    role="separator"
                    aria-label={t("feed.newSinceLastVisit")}
                    className="flex items-center gap-3"
                  >
                    <span aria-hidden="true" className="h-0.5 flex-1 bg-info" />
                    <span
                      aria-hidden="true"
                      className="text-label text-info uppercase"
                    >
                      {t("feed.newSinceLastVisit")}
                    </span>
                    <span aria-hidden="true" className="h-0.5 flex-1 bg-info" />
                  </div>
                ) : null}
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
        {/*
         * One board zone for everything the board does here (DESIGN.md, Board
         * zones), each panel behind what offers it: the scheduled posts behind
         * the server's answer, which carries them only for somebody who may
         * write as Styrelsen, and the report queue behind the capability that
         * answers reports. Neither, and there is no zone at all.
         */}
        {waiting.length > 0 || moderates ? (
          <BoardZone title={t("feed.boardZone")}>
            {waiting.length > 0 ? (
              <ScheduledPosts
                posts={waiting}
                showAudience={open === null}
                onCancelled={feed.dropScheduled}
              />
            ) : null}
            {moderates ? <ReportQueue /> : null}
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
              // yet: the write's own answer is what puts it on the board's list,
              // when the feed on screen is one it belongs on.
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

/** Each audience's read marker as it stood when a filter's feed was first drawn. */
interface LastVisit {
  /** The filter it was taken for: see `filterKey`. */
  key: string;
  /** The marker of each audience, or null for one never opened. */
  markers: ReadonlyMap<string, string | null>;
}

/** The read marker of each audience, as the list says it now. */
function markersOf(
  audiences: readonly AudienceView[],
): ReadonlyMap<string, string | null> {
  return new Map(audiences.map((each) => [each.id, each.readAt]));
}

/**
 * The post the "new since your last visit" line goes below, or null for none.
 *
 * The oldest post on screen that is new - somebody else's, not erased, and
 * written after its audience's marker as it stood - and only when a post
 * follows it: a line under the last post on screen would divide nothing from
 * nothing. The posts are in the order they are shown - the pinned ones on top,
 * then the rest newest first - so the line goes below the last new one, and a
 * pinned post read before never has it below it.
 *
 * The instants are compared as the ISO strings the API wrote them in, which is
 * comparing the instants, because every one is in the same UTC form.
 */
export function oldestNewPost(
  posts: readonly PostView[],
  markers: ReadonlyMap<string, string | null>,
  viewerPersonId: string,
): string | null {
  let oldest = -1;
  posts.forEach((post, index) => {
    const marker = markers.get(post.audience.id) ?? null;
    const own =
      post.author !== null &&
      post.author.kind !== "unknown" &&
      post.author.personId === viewerPersonId;
    if (
      marker !== null &&
      !own &&
      post.erasedAt === null &&
      post.createdAt > marker
    ) {
      oldest = index;
    }
  });
  return oldest === -1 || oldest === posts.length - 1
    ? null
    : (posts[oldest]?.id ?? null);
}

/**
 * The newest instant of each audience among the posts on screen, pinned ones
 * included, as a string an effect can depend on:
 * `[[audienceId, createdAt], ...]` in a fixed order.
 *
 * The pinned posts sit on top whatever their age, so the newest is found by
 * comparing rather than by position. An erased post is passed over, as the
 * server does when it counts what is unread: there is nothing left on it to
 * have read.
 */
function newestPerAudience(posts: readonly PostView[]): string {
  const newest = new Map<string, string>();
  for (const post of posts) {
    const was = newest.get(post.audience.id);
    if (post.erasedAt === null && (was === undefined || post.createdAt > was)) {
      newest.set(post.audience.id, post.createdAt);
    }
  }
  return newest.size === 0
    ? ""
    : JSON.stringify(
        [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
}
