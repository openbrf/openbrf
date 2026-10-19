import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedFrom, PostView } from "@openbrf/shared";

import type { ApiFailure } from "../api/client";
import { fetchPost, postsSince, readFeed, type FeedFilter } from "../api/feed";
import { usePoll } from "../ui/use-poll";
import { POLL_INTERVAL_MS } from "./feed-limits";

/** The feed on screen, as this client holds it, for one filter. */
export interface HeldFeed {
  /** Which filter this is the answer to: see {@link filterKey}. */
  key: string;
  /** The pinned posts, newest pin first, on top of the feed. */
  pinned: readonly PostView[];
  /**
   * The board's posts waiting for their instant, soonest first: empty for
   * everybody but the board. A post leaves it when a poll delivers it.
   */
  scheduled: readonly PostView[];
  /** Every other post read so far, newest first. */
  posts: readonly PostView[];
  /** The cursor for the page before the oldest one here, or null at the end. */
  earlier: string | null;
  /** Where the poll asks from, or null while nothing matches. */
  cursor: string | null;
  /** The last read that did not answer, or null. */
  failure: ApiFailure | null;
}

export interface Feed {
  /** The feed for the filter asked for, or null until its first read answers. */
  feed: HeldFeed | null;
  /** Whether the press for the posts before this page is on its way. */
  readingEarlier: boolean;
  /** Reads the page before the oldest one on screen and puts it below. */
  showEarlier: () => Promise<void>;
  /** Asks the poll for what has arrived now, rather than at the next interval. */
  readNew: () => void;
  /** Puts what the server answered an act on a post with onto the post held. */
  patchPost: (postId: string, patch: Partial<PostView>) => void;
  /** Reads one post again, and puts the answer in its place. */
  refreshPost: (postId: string) => Promise<void>;
  /**
   * Puts a post the board has just scheduled among the scheduled ones, as the
   * server answered the write with it. No poll would bring it: its instant has
   * not come.
   */
  putScheduled: (post: PostView) => void;
}

/**
 * The identity of a filter, as a string two renders can compare.
 *
 * Everything the server narrows by, and the search as it is sent - trimmed - so
 * a trailing space typed into the search box is not a new feed.
 */
export function filterKey(filter: FeedFilter): string {
  return JSON.stringify([
    filter.audienceId,
    filter.search.trim(),
    filter.from,
    filter.important,
  ]);
}

/**
 * The feed: one page at a time backwards, and what has arrived since forwards.
 *
 * ## The feed arrives from both ends
 *
 * The first read answers the newest page, the pinned posts and two cursors: one
 * for the page before it, which the reader asks for by pressing, and one for
 * the poll, which asks forwards. Pages are concatenated and never merged - each
 * is a window no other page overlaps - and the poll's answers are put on top by
 * identifier, so a post that arrives twice is shown once.
 *
 * A feed nothing matches has no forward cursor, because there is no post to
 * take one from. The poll reads the newest page again in that case rather than
 * standing still: a group nobody has written in yet is the one most likely to
 * be sitting open on somebody's screen (ADR 0010).
 *
 * ## One filter at a time, and nothing of the last one
 *
 * Choosing an audience, typing a search or ticking a filter changes the filter
 * at once and the read that answers it a moment later, so for that moment the
 * state still holds the last filter's feed. Everything is keyed on the filter:
 * the feed handed out is the current filter's or nothing, a poll in flight for
 * the last one cannot write its cursor into this one, and a press for an
 * earlier page cannot put one filter's posts under another's.
 *
 * ## Nothing is optimistic
 *
 * A post the reader wrote is not put on the feed here: `readNew` asks the poll,
 * and the post arrives because the server said it is there, the same way
 * everybody else's does. What an act on a post is answered with - a like, a
 * read, a comment's new count - is put onto that post, because it is the
 * server's own answer about it.
 */
export function useFeed(
  audienceId: string | null,
  search: string,
  from: FeedFrom | null,
  important: boolean,
  enabled: boolean,
): Feed {
  const filter = useMemo<FeedFilter>(
    () => ({ audienceId, search, from, important }),
    [audienceId, search, from, important],
  );
  const key = filterKey(filter);

  const [held, setHeld] = useState<HeldFeed | null>(null);
  /**
   * The press for an earlier page in flight, and the filter it was pressed
   * under. Compared by identity when it settles, so a read left behind under
   * one filter cannot end a newer one, and by key, so it does not hold the
   * button down under a filter chosen meanwhile.
   */
  const [earlierRead, setEarlierRead] = useState<{ key: string } | null>(null);

  const feed = held !== null && held.key === key ? held : null;

  /** A poll already in flight, so two do not ask from the same cursor at once. */
  const polling = useRef(false);
  /**
   * The latest ask made while one was in flight. The answer in flight may come
   * from before a write that landed meanwhile, so the ask is run once more from
   * the cursor that poll left, rather than dropped.
   *
   * The whole ask is held, not only its `stillWanted`: the filter may have
   * changed while the poll in flight was waiting, and an ask made under the new
   * filter has to be run with it, not with the one the loop started under.
   */
  const queued = useRef<(() => Promise<void>) | null>(null);

  /**
   * The filter on screen, or null once the screen has gone. A poll asked under
   * one filter stops when another is chosen: its answer could not be applied,
   * and the cursor it would write is a position in a feed nobody is reading.
   */
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    shownKey.current = key;
    return () => {
      shownKey.current = null;
    };
  }, [key]);

  /*
   * The cursor the poll asks from, held in a ref as well as in state. The loop
   * below reads it between requests, and reading it out of the closure would ask
   * every page from the cursor the callback was built with. It carries the filter
   * it belongs to, because a cursor is a position in one feed: asked of another,
   * it names a point that feed never had.
   *
   * Written after the render rather than during it: a ref assigned while
   * rendering is a side effect in a function React is allowed to call twice.
   */
  const cursorRef = useRef<{ key: string; cursor: string | null } | null>(null);
  const heldKey = feed?.key ?? null;
  const heldCursor = feed?.cursor ?? null;
  useEffect(() => {
    cursorRef.current =
      heldKey === null ? null : { key: heldKey, cursor: heldCursor };
  }, [heldKey, heldCursor]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let abandoned = false;

    void (async () => {
      const result = await readFeed({ filter, before: null });
      if (abandoned) {
        return;
      }
      setHeld(
        result.ok
          ? {
              key,
              pinned: result.value.pinned,
              scheduled: result.value.scheduled,
              posts: result.value.posts,
              earlier: result.value.earlier,
              cursor: result.value.latest,
              failure: null,
            }
          : {
              key,
              pinned: [],
              scheduled: [],
              posts: [],
              earlier: null,
              cursor: null,
              failure: result.failure,
            },
      );
    })();

    return () => {
      abandoned = true;
    };
  }, [filter, key, enabled]);

  /**
   * Asks what has arrived, and applies it if anybody still wants it.
   *
   * It carries on at once while the server says more is waiting, so a screen
   * that was closed for a week catches up a page at a time rather than waiting
   * out an interval per page - and never asks for a week of posts in one
   * response, which is what the server's own bound is for.
   */
  const pollOnce = useCallback(
    async (asked: () => boolean): Promise<void> => {
      const stillWanted = (): boolean => asked() && shownKey.current === key;
      /*
       * The cursor is carried through the loop rather than re-read from the
       * ref each time round. The ref is written by an effect, which runs after
       * React commits, and nothing commits while this loop is awaiting - so a
       * second turn reading the ref would read the position the first started
       * from, ask for the same page again, be told again that more is waiting,
       * and never end. Each answer's cursor is written through to the ref as
       * well, so the next interval continues from where this one stopped.
       */
      let after =
        cursorRef.current?.key === key ? cursorRef.current.cursor : null;
      for (;;) {
        if (!stillWanted()) {
          return;
        }

        if (after === null) {
          /*
           * Nothing matched when the screen was drawn, so there is no cursor
           * to ask from: the newest page is read again instead of asking what
           * is newer than nothing. The same read answers a cursor that belongs
           * to another filter, which is what the ref holds for a moment after
           * one is chosen.
           */
          const first = await readFeed({ filter, before: null });
          if (!stillWanted() || !first.ok) {
            return;
          }
          cursorRef.current = { key, cursor: first.value.latest };
          setHeld((was) =>
            was === null || was.key !== key
              ? was
              : {
                  ...was,
                  pinned: putOnTop(was.pinned, first.value.pinned),
                  scheduled: first.value.scheduled,
                  posts: putOnTop(was.posts, first.value.posts),
                  earlier: first.value.earlier,
                  cursor: first.value.latest,
                  /*
                   * A read that answers clears the one that did not. This
                   * branch runs only while there is no cursor, and a refused
                   * press for an earlier page needs a page with one - so the
                   * only failure that can be held here is the first read's,
                   * and it is no longer true.
                   */
                  failure: null,
                },
          );
          return;
        }

        const result = await postsSince({ filter, after });
        if (!stillWanted()) {
          return;
        }
        if (!result.ok) {
          /*
           * A failed poll is left silent, unlike a failed read. The feed on
           * screen is still what the server last said, nothing the reader did
           * has failed, and a notice appearing by itself every four seconds on
           * a flaky connection would be worse than the gap it reports.
           */
          return;
        }

        const update = result.value;
        after = update.cursor;
        cursorRef.current = { key, cursor: update.cursor };
        // Oldest first on the wire, newest first on screen.
        const arriving = [...update.posts].reverse();
        setHeld((was) =>
          was === null || was.key !== key
            ? was
            : {
                ...was,
                pinned: putOnTop(
                  was.pinned,
                  arriving.filter((post) => post.pinned),
                ),
                // A scheduled post whose instant came is in the feed now.
                scheduled: without(was.scheduled, arriving),
                posts: putOnTop(
                  was.posts,
                  arriving.filter((post) => !post.pinned),
                ),
                cursor: update.cursor,
              },
        );
        if (!update.more) {
          return;
        }
      }
    },
    [filter, key],
  );

  const poll = useCallback(
    async (stillWanted: () => boolean): Promise<void> => {
      const ask = (): Promise<void> => pollOnce(stillWanted);
      if (polling.current) {
        queued.current = ask;
        return;
      }
      polling.current = true;
      try {
        let next: (() => Promise<void>) | null = ask;
        while (next !== null) {
          queued.current = null;
          await next();
          next = queued.current;
        }
      } finally {
        polling.current = false;
        // An ask left behind by a poll that threw is not run by the next one.
        queued.current = null;
      }
    },
    [pollOnce],
  );

  /*
   * On as soon as the feed is on screen, cursor or no cursor: a feed nothing has
   * matched yet is the one a reader is most likely to be watching.
   */
  usePoll(poll, { intervalMs: POLL_INTERVAL_MS, enabled: feed !== null });

  const readNew = useCallback(() => {
    void poll(() => true);
  }, [poll]);

  const earlierCursor = feed?.earlier ?? null;
  const showEarlier = useCallback(async (): Promise<void> => {
    if (earlierCursor === null) {
      return;
    }
    const read = { key };
    setEarlierRead(read);
    const before = earlierCursor;
    const result = await readFeed({ filter, before });
    setEarlierRead((was) => (was === read ? null : was));
    setHeld((was) => {
      if (was === null || was.key !== key || was.earlier !== before) {
        // A page already applied, or a filter that changed under it: applying
        // this one again would show every post on it twice, and the refusal is
        // the press's, under the filter it was pressed under.
        return was;
      }
      return result.ok
        ? {
            ...was,
            // Below, because older posts were written first and the feed reads
            // newest first. Pages never overlap, so this is concatenation.
            posts: [...was.posts, ...result.value.posts],
            earlier: result.value.earlier,
            failure: null,
          }
        : { ...was, failure: result.failure };
    });
  }, [filter, key, earlierCursor]);

  const patchPost = useCallback(
    (postId: string, patch: Partial<PostView>): void => {
      setHeld((was) => (was === null ? was : repinned(was, postId, patch)));
    },
    [],
  );

  const refreshPost = useCallback(
    async (postId: string): Promise<void> => {
      const result = await fetchPost({ postId });
      if (result.ok) {
        patchPost(postId, result.value);
      }
    },
    [patchPost],
  );

  const putScheduled = useCallback((post: PostView): void => {
    setHeld((was) =>
      was === null || was.scheduled.some((each) => each.id === post.id)
        ? was
        : {
            ...was,
            scheduled: [...was.scheduled, post].sort((a, b) =>
              a.createdAt < b.createdAt
                ? -1
                : a.createdAt > b.createdAt
                  ? 1
                  : 0,
            ),
          },
    );
  }, []);

  return {
    feed,
    putScheduled,
    readingEarlier: earlierRead !== null && earlierRead.key === key,
    showEarlier,
    readNew,
    patchPost,
    refreshPost,
  };
}

/**
 * The posts on screen with the ones that arrived on top, minus any already
 * there.
 *
 * The cursor should make a repeat impossible; a read after a write and an
 * interval that fired at the same moment can still ask from the same place, and
 * a post shown twice is a defect nobody can clear.
 */
function putOnTop(
  held: readonly PostView[],
  arriving: readonly PostView[],
): readonly PostView[] {
  if (arriving.length === 0) {
    return held;
  }
  const known = new Set(held.map((post) => post.id));
  const fresh = arriving.filter((post) => !known.has(post.id));
  return fresh.length === 0 ? held : [...fresh, ...held];
}

/** The posts held, less any that arrived. */
function without(
  held: readonly PostView[],
  arriving: readonly PostView[],
): readonly PostView[] {
  const arrived = new Set(arriving.map((post) => post.id));
  return held.some((post) => arrived.has(post.id))
    ? held.filter((post) => !arrived.has(post.id))
    : held;
}

/**
 * The feed with one post changed - and, when the change is its pin, moved to
 * where a pinned or an unpinned post goes.
 *
 * A post pinned goes on top of the pinned ones, which are newest pin first. A
 * post unpinned goes back to its place among the others by its instant - or,
 * when that place is further back than the pages read so far, nowhere yet: the
 * page that holds it puts it there, and putting it here as well would show it
 * twice once that page arrives.
 */
function repinned(
  was: HeldFeed,
  postId: string,
  patch: Partial<PostView>,
): HeldFeed {
  const current = [...was.pinned, ...was.posts].find(
    (post) => post.id === postId,
  );
  if (
    current === undefined ||
    patch.pinned === undefined ||
    patch.pinned === current.pinned
  ) {
    return {
      ...was,
      pinned: patched(was.pinned, postId, patch),
      posts: patched(was.posts, postId, patch),
    };
  }
  const moved = { ...current, ...patch };
  if (moved.pinned) {
    return {
      ...was,
      pinned: [moved, ...was.pinned],
      posts: was.posts.filter((post) => post.id !== postId),
    };
  }
  const pinned = was.pinned.filter((post) => post.id !== postId);
  const oldest = was.posts.at(-1);
  if (
    was.earlier !== null &&
    oldest !== undefined &&
    moved.createdAt < oldest.createdAt
  ) {
    return { ...was, pinned };
  }
  const at = was.posts.findIndex((post) => post.createdAt < moved.createdAt);
  return {
    ...was,
    pinned,
    posts:
      at === -1
        ? [...was.posts, moved]
        : [...was.posts.slice(0, at), moved, ...was.posts.slice(at)],
  };
}

/** The posts with one of them changed, and the list itself untouched otherwise. */
function patched(
  posts: readonly PostView[],
  postId: string,
  patch: Partial<PostView>,
): readonly PostView[] {
  return posts.some((post) => post.id === postId)
    ? posts.map((post) => (post.id === postId ? { ...post, ...patch } : post))
    : posts;
}
