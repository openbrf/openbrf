import type { ApiResult } from "../api/client";
import type { BoardAudience } from "../ui/BoardZone";
import { QUEUE_COUNTS, type QueueCount } from "./queue-counts";

/** The queues the board's front page lists, in the order it lists them. */
export type QueueId =
  | "issues"
  | "boardMailbox"
  | "motions"
  | "sublets"
  | "keyOrders"
  | "brokerUpdateRequests"
  | "accountRequests"
  | "chatReports"
  | "importProposals";

/**
 * Each queue, the capability its endpoint requires, and the page it is worked
 * on.
 *
 * Read from the viewer's capabilities, and whether it is a support session, so
 * no row calls an endpoint that would refuse this viewer. The account requests
 * are decided on the settings screen, which is where the switch that opens the
 * form is as well. Brokers' update requests are listed there beside them, and
 * answered by confirming the facts on the website's screen.
 *
 * `closedToSupport` marks a queue whose endpoint refuses a support session
 * although the session holds its capability (ADR 0028): brokers' requests are
 * correspondence, read under site:manage.
 */
export const QUEUES: readonly {
  id: QueueId;
  capability: string;
  to: string;
  closedToSupport?: true;
}[] = [
  { id: "issues", capability: "issues:handle", to: "/board/issues" },
  {
    id: "boardMailbox",
    capability: "boardMailbox:handle",
    to: "/board-mailbox",
  },
  { id: "motions", capability: "motions:handle", to: "/motions" },
  { id: "sublets", capability: "sublets:handle", to: "/sublets" },
  { id: "keyOrders", capability: "keyOrders:handle", to: "/key-orders" },
  {
    id: "brokerUpdateRequests",
    capability: "site:manage",
    to: "/settings/account-requests",
    closedToSupport: true,
  },
  {
    id: "accountRequests",
    capability: "signupRequest:decide",
    to: "/settings/account-requests",
  },
  { id: "chatReports", capability: "chat:moderate", to: "/feed" },
  /*
   * Member lists a plugin proposed for import (ADR 0043). The import screen
   * needs addressBook:read beside this; whoever may write the address book
   * may read it.
   */
  {
    id: "importProposals",
    capability: "addressBook:write",
    to: "/board/import",
  },
];

/**
 * The queues an account with these capabilities works, in order; in a support
 * session, without the ones closed to it.
 */
export function queuesFor(
  capabilities: readonly string[],
  isSupportSession = false,
): QueueId[] {
  return QUEUES.filter(
    (queue) =>
      capabilities.includes(queue.capability) &&
      !(isSupportSession && queue.closedToSupport === true),
  ).map((queue) => queue.id);
}

/**
 * Whose work the queues are. The issue queue is the one the board shares with
 * the property manager, so a viewer who holds nothing else is signed for both;
 * every other queue is the board's, and the sign follows the widest function
 * on the list rather than a role.
 */
export function audienceOf(queues: readonly QueueId[]): BoardAudience {
  return queues.length > 0 && queues.every((id) => id === "issues")
    ? "issueHandling"
    : "board";
}

/**
 * How much is waiting across these queues, read the way the front page reads
 * each of them.
 *
 * A floor when any one count is, so the sum says "at least" rather than a
 * number that is not the total. A queue that answers it is not this account's
 * adds nothing. One failed read fails the sum: a total that left a queue out
 * would be a smaller number than the true one, said as if it were the true one.
 */
export async function waitingIn(
  queues: readonly QueueId[],
): Promise<ApiResult<QueueCount>> {
  const results = await Promise.all(queues.map((id) => QUEUE_COUNTS[id]()));
  let count = 0;
  let more = false;
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    count += result.value?.count ?? 0;
    more = more || (result.value?.more ?? false);
  }
  return { ok: true, value: { count, more } };
}
