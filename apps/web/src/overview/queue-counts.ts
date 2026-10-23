import { fetchBoardMailboxThreads } from "../api/board-mailbox";
import { fetchBrokerUpdateRequests } from "../api/broker-update-requests";
import { fetchReports } from "../api/feed";
import type { ApiResult } from "../api/client";
import { fetchIssueQueue } from "../api/issues";
import { fetchKeyOrderQueue } from "../api/key-orders";
import { fetchMotionQueue } from "../api/motions";
import { fetchSignupRequests } from "../api/signup";
import { fetchSubletQueue } from "../api/sublets";
import { fetchImportProposals } from "../import/import-api";
import type { QueueId } from "./overview-panels";

/**
 * How much is waiting in one queue.
 *
 * `more` is true when the answer was one page of a longer queue, so the count
 * is a floor rather than the total. The page then says "at least", which is
 * true, rather than a number that is not.
 */
export interface QueueCount {
  count: number;
  more: boolean;
}

/** The mailbox states that still owe the writer an answer. */
const UNANSWERED = new Set(["NEW", "TAKEN"]);

function counted<T>(
  result: ApiResult<T>,
  count: (value: T) => QueueCount | null,
): ApiResult<QueueCount | null> {
  return result.ok ? { ok: true, value: count(result.value) } : result;
}

/**
 * One read per queue, each through the endpoint the queue's own screen uses.
 *
 * Null is "this queue is not this account's", which only the chat reports can
 * answer: an administrator holds chat:moderate and no board seat, and the API
 * tells them so instead of handing them a queue. The row is then left out
 * rather than showing a count that would describe rooms they may not see.
 *
 * Each filters on the server where the endpoint takes a state, so the count is
 * read from the waiting items alone rather than from every item the
 * association ever had.
 */
export const QUEUE_COUNTS: Readonly<
  Record<QueueId, () => Promise<ApiResult<QueueCount | null>>>
> = {
  issues: async () =>
    counted(await fetchIssueQueue({ status: "NEW" }), (issues) => ({
      count: issues.length,
      more: false,
    })),

  /*
   * One unfiltered page rather than one read per state. The inbox is listed
   * NEW, then TAKEN, then the answered states, so the unanswered threads are
   * the head of the first page: when an answered one appears on it, every
   * unanswered thread has been counted, and when none does and the inbox has
   * more pages, the count is a floor.
   */
  boardMailbox: async () =>
    counted(await fetchBoardMailboxThreads(), (list) => {
      const unanswered = list.threads.filter((thread) =>
        UNANSWERED.has(thread.status),
      ).length;
      return {
        count: unanswered,
        more: list.more && unanswered === list.threads.length,
      };
    }),

  motions: async () =>
    counted(await fetchMotionQueue({ status: "SUBMITTED" }), (queue) => ({
      count: queue.motions.length,
      more: queue.nextCursor !== null,
    })),

  sublets: async () =>
    counted(await fetchSubletQueue({ status: "SUBMITTED" }), (queue) => ({
      count: queue.applications.length,
      more: false,
    })),

  keyOrders: async () =>
    counted(await fetchKeyOrderQueue({ status: "SUBMITTED" }), (queue) => ({
      count: queue.orders.length,
      more: false,
    })),

  // The open half, counted by the server whether or not the page holds it.
  brokerUpdateRequests: async () =>
    counted(await fetchBrokerUpdateRequests(), (queue) => ({
      count: queue.openTotal,
      more: false,
    })),

  // The endpoint answers with the pending requests and no others.
  accountRequests: async () =>
    counted(await fetchSignupRequests(), (requests) => ({
      count: requests.length,
      more: false,
    })),

  /*
   * Open reports only: a struck or dismissed one is resolved and not listed.
   * The first page, and whether the queue said there is a page after it.
   */
  chatReports: async () =>
    counted(await fetchReports(), (queue) =>
      queue.mayModerate
        ? { count: queue.reports.length, more: queue.next !== null }
        : null,
    ),

  // The list holds every proposal waiting for the board, and the decided ones
  // after them.
  importProposals: async () =>
    counted(await fetchImportProposals(), ({ proposals }) => ({
      count: proposals.filter((proposal) => proposal.state === "pending")
        .length,
      more: false,
    })),
};
