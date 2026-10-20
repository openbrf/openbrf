import type { AudienceListView } from "@openbrf/shared";

import { fetchAudiences } from "../api/feed";

/** Why the list of audiences is not on screen, when it is not. */
export type AudienceListFailure = "failed" | "notOffered";

/** What the store holds: the list as the server last said, and the last read's failure. */
export interface AudienceSnapshot {
  /** The audiences this account is in, or null until the first read answers. */
  list: AudienceListView | null;
  /** The last read that did not answer, or null. */
  failure: AudienceListFailure | null;
}

/**
 * The audiences this account is in, held once for the whole client.
 *
 * Two places show what is unread: the feed, beside each audience, and the
 * navigation, as one number on the feed's entry. They are one answer, read by
 * one request at a time, so the badge and the list beside the feed cannot say
 * two different things about the same moment - and a screen showing both does
 * not ask the server twice for it.
 *
 * ## One read at a time, and one more if asked meanwhile
 *
 * A read asked for while one is on its way is not sent beside it: it is run
 * once more when that one answers, from scratch. The answer in flight may come
 * from before a group was made or left, and a reload asked for after the act
 * has to be answered by a read made after it - so the ask is kept rather than
 * dropped, and two asks meanwhile are still one more read.
 *
 * ## Nothing is kept for nobody
 *
 * The list is let go once nothing on screen reads it, and a read still on its
 * way then is not applied. The next screen to read it asks afresh rather than
 * being shown a count from whenever the last one was open, and an account that
 * signs out does not leave its audiences behind for the next.
 */
let snapshot: AudienceSnapshot = { list: null, failure: null };
const listeners = new Set<() => void>();

/**
 * Bumped when the list is let go, so an answer to a read made before that is
 * not applied to a store nobody reads any more.
 */
let generation = 0;
/** The read on its way, or null. */
let running: Promise<boolean> | null = null;
/** Whether another read was asked for while one was on its way. */
let again = false;

function publish(next: AudienceSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Reads the list once, and applies the answer if it is still wanted. */
async function readOnce(): Promise<boolean> {
  const asked = generation;
  const result = await fetchAudiences();
  if (asked !== generation) {
    return false;
  }
  if (!result.ok) {
    /*
     * A refusal by the guard is not a failure to answer, and saying "try
     * again" to somebody who holds no capability would be telling them a part
     * of the product is broken rather than not theirs.
     */
    publish({
      list: snapshot.list,
      failure: result.failure.status === 403 ? "notOffered" : "failed",
    });
    return false;
  }
  publish({ list: result.value, failure: null });
  return true;
}

/**
 * Reads the list again, and answers whether the last read did.
 *
 * Called on a poll, and whenever the list itself changes - a group made, a
 * group left - because which audiences exist is the server's answer, and a
 * list this client edited would be a list nothing on the server ever said.
 */
export function reloadAudiences(): Promise<boolean> {
  if (running !== null) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let answered: boolean;
      do {
        again = false;
        answered = await readOnce();
      } while (again);
      return answered;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Takes an audience's unread count down to none, once its marker has landed.
 *
 * The server's own answer about the marker, put onto the list held, so the
 * count beside the audience and the badge in the navigation drop together
 * rather than at the next read.
 */
export function markAudienceReadInStore(audienceId: string): void {
  const list = snapshot.list;
  if (list === null) {
    return;
  }
  publish({
    ...snapshot,
    list: {
      ...list,
      audiences: list.audiences.map((each) =>
        each.id === audienceId ? { ...each, unread: 0 } : each,
      ),
    },
  });
}

/**
 * Starts reading the store. Let go of with what this returns; once the last
 * reader has let go, the list is let go with it.
 */
export function subscribeToAudiences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      generation += 1;
      again = false;
      snapshot = { list: null, failure: null };
    }
  };
}

/** The store as it stands, for `useSyncExternalStore`. */
export function audienceSnapshot(): AudienceSnapshot {
  return snapshot;
}

/**
 * How many posts are unread across every audience, or null when the store
 * holds no list, or its last read did not answer.
 */
export function totalUnread(of: AudienceSnapshot): number | null {
  if (of.list === null || of.failure !== null) {
    return null;
  }
  return of.list.audiences.reduce((sum, each) => sum + each.unread, 0);
}
