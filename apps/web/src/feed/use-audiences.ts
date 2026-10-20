import { useEffect, useSyncExternalStore } from "react";
import type { AudienceListView } from "@openbrf/shared";

import {
  type AudienceListFailure,
  audienceSnapshot,
  markAudienceReadInStore,
  reloadAudiences,
  subscribeToAudiences,
} from "./audience-store";

export type { AudienceListFailure } from "./audience-store";

export interface Audiences {
  /** The audiences this account is in, or null until the first read answers. */
  list: AudienceListView | null;
  /**
   * The last read that did not answer. Before the first list it is the whole
   * screen; after it, a notice beside the list still on screen.
   */
  failure: AudienceListFailure | null;
  /**
   * Reads the list again, and answers whether it did.
   *
   * Called whenever the list itself changes - a group made, a group left -
   * because which audiences exist is the server's answer, and a list this
   * screen edited would be a list nothing on the server ever said. The feed
   * also calls it on its own poll, so every audience's count is current and not
   * only the one that is open.
   */
  reload: () => Promise<boolean>;
  /** Takes an audience's unread count down to none, once its marker has landed. */
  markedRead: (audienceId: string) => void;
}

/**
 * The audiences this account is in, as the server last said.
 *
 * Read from the one store the navigation's unread badge reads too
 * (`audience-store.ts`), so the two cannot disagree and a screen showing both
 * asks once. The first read is asked for when this mounts.
 *
 * ## Which audiences exist is the server's answer, and none is an answer
 *
 * The capability opens the endpoints and membership decides what is in them,
 * and the two are separate questions. The administrator holds every capability,
 * no board seat and no residency, so they reach the feed and are answered with
 * no audiences at all - which the screen says in words rather than rendering an
 * empty feed.
 *
 * ## An older read never overwrites a newer one
 *
 * The store runs one read at a time and runs one more when it was asked for
 * meanwhile, so a slow read from before a group was made cannot put back the
 * list without it, and a retry that fails cannot put a failure back over a
 * list a later read answered.
 */
export function useAudiences(): Audiences {
  const { list, failure } = useSyncExternalStore(
    subscribeToAudiences,
    audienceSnapshot,
  );

  useEffect(() => {
    void reloadAudiences();
  }, []);

  return {
    list,
    failure,
    reload: reloadAudiences,
    markedRead: markAudienceReadInStore,
  };
}
