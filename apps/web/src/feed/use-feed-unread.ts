import { useCallback, useEffect, useSyncExternalStore } from "react";

import { usePoll } from "../ui/use-poll";
import {
  audienceSnapshot,
  reloadAudiences,
  subscribeToAudiences,
  totalUnread,
} from "./audience-store";
import { UNREAD_POLL_INTERVAL_MS } from "./feed-limits";

/** A store nothing is read from, for an account the feed is not offered to. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

function nothing(): null {
  return null;
}

/**
 * How many posts are unread in the feed, across every audience, for the
 * navigation's badge - or undefined when there is nothing to show.
 *
 * Read from the store the feed's own list reads (`audience-store.ts`), so the
 * badge and the counts beside the feed are one answer. Polled every
 * {@link UNREAD_POLL_INTERVAL_MS} while the tab is looked at; on the feed the
 * screen's own poll moves the store sooner, and the badge with it.
 *
 * Undefined, rather than a zero plate, while nothing is unread, until the first
 * read answers and when the last one did not: a failed count is left silent, as
 * a failed poll is everywhere here, because a badge that announced an error on
 * every screen would be reporting something nobody asked about.
 *
 * @param offered Whether this account is offered the feed at all. An account
 *   that is not asks for nothing.
 */
export function useFeedUnread(offered: boolean): number | undefined {
  const total = useSyncExternalStore(
    offered ? subscribeToAudiences : subscribeToNothing,
    offered ? () => totalUnread(audienceSnapshot()) : nothing,
  );

  useEffect(() => {
    if (offered) {
      void reloadAudiences({ joinInFlight: true });
    }
  }, [offered]);

  const poll = useCallback(async (): Promise<void> => {
    await reloadAudiences({ joinInFlight: true });
  }, []);
  usePoll(poll, { intervalMs: UNREAD_POLL_INTERVAL_MS, enabled: offered });

  return total === null || total === 0 ? undefined : total;
}
