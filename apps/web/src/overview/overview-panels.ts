import type { OwnBooking } from "../api/bookings";
import type { AttendableOccurrence } from "../api/events";
import type { OwnIssue } from "../api/issues";
import type { OwnKeyOrder } from "../api/key-orders";
import type { OwnMotion } from "../api/motions";
import type { NewsArticle } from "../api/news-reader";
import type { OwnSubletApplication } from "../api/sublets";

/**
 * Which panels the overview shows, from the viewer's capabilities alone.
 *
 * Every panel reads an endpoint that refuses a caller without its capability,
 * so a panel is only ever mounted for someone who holds it. Showing one and
 * letting the API refuse it would put an error on the page every time a
 * resident opened it, and a property manager's page would be mostly refusals.
 * The capability list is a copy of what the guard enforces, so this is the same
 * question the API answers, asked before the request rather than after it.
 */

/** The queues "To handle" can list, in the order it lists them. */
export type QueueId =
  | "issues"
  | "boardMailbox"
  | "motions"
  | "sublets"
  | "keyOrders"
  | "accountRequests"
  | "chatReports";

/**
 * Each queue, the capability its endpoint requires, and where it is worked.
 *
 * The account requests are decided on the settings screen, which is where the
 * switch that opens the form is as well.
 */
export const QUEUES: readonly {
  id: QueueId;
  capability: string;
  to: string;
}[] = [
  { id: "issues", capability: "issues:handle", to: "/issues" },
  {
    id: "boardMailbox",
    capability: "boardMailbox:handle",
    to: "/board-mailbox",
  },
  { id: "motions", capability: "motions:handle", to: "/motions" },
  { id: "sublets", capability: "sublets:handle", to: "/sublets" },
  { id: "keyOrders", capability: "keyOrders:handle", to: "/key-orders" },
  {
    id: "accountRequests",
    capability: "signupRequest:decide",
    to: "/settings/account-requests",
  },
  { id: "chatReports", capability: "chat:moderate", to: "/chat" },
];

/** Which of a resident's own intakes the waiting panel reads. */
export interface WaitingSources {
  issues: boolean;
  motions: boolean;
  sublets: boolean;
  keyOrders: boolean;
}

export interface OverviewPanels {
  /** Null when the viewer holds none of the four intakes. */
  waiting: WaitingSources | null;
  bookings: boolean;
  events: boolean;
  news: boolean;
  /** The queues this viewer works, in order; empty hides the panel. */
  toHandle: readonly QueueId[];
}

export function overviewPanelsFor(
  capabilities: readonly string[],
): OverviewPanels {
  const holds = (capability: string): boolean =>
    capabilities.includes(capability);

  const waiting: WaitingSources = {
    issues: holds("issues:report"),
    motions: holds("motions:submit"),
    sublets: holds("sublets:apply"),
    keyOrders: holds("keyOrders:place"),
  };

  return {
    waiting: Object.values(waiting).some(Boolean) ? waiting : null,
    bookings: holds("bookings:book"),
    events: holds("events:attend"),
    news: holds("news:comment"),
    toHandle: QUEUES.filter((queue) => holds(queue.capability)).map(
      (queue) => queue.id,
    ),
  };
}

/** Whether the viewer is offered any panel at all. */
export function offersAnything(panels: OverviewPanels): boolean {
  return (
    panels.waiting !== null ||
    panels.bookings ||
    panels.events ||
    panels.news ||
    panels.toHandle.length > 0
  );
}

/** One matter of the viewer's own that the association has not answered. */
export type WaitingItem =
  | { kind: "issue"; at: string; issue: OwnIssue }
  | { kind: "motion"; at: string; motion: OwnMotion }
  | { kind: "sublet"; at: string; application: OwnSubletApplication }
  | { kind: "keyOrder"; at: string; order: OwnKeyOrder };

/**
 * What is still with the association, newest first.
 *
 * An issue waits until it is done: in progress means somebody is on it, which is
 * still the association's move. The other three wait while they are SUBMITTED,
 * the one state in which the board has not answered; every other state is an
 * answer, or the person's own withdrawal.
 */
export function waitingItems(sources: {
  issues?: readonly OwnIssue[];
  motions?: readonly OwnMotion[];
  sublets?: readonly OwnSubletApplication[];
  keyOrders?: readonly OwnKeyOrder[];
}): WaitingItem[] {
  const items: WaitingItem[] = [
    ...(sources.issues ?? [])
      .filter((issue) => issue.status !== "DONE")
      .map((issue): WaitingItem => ({
        kind: "issue",
        at: issue.createdAt,
        issue,
      })),
    ...(sources.motions ?? [])
      .filter((motion) => motion.status === "SUBMITTED")
      .map((motion): WaitingItem => ({
        kind: "motion",
        at: motion.submittedAt,
        motion,
      })),
    ...(sources.sublets ?? [])
      .filter((application) => application.status === "SUBMITTED")
      .map((application): WaitingItem => ({
        kind: "sublet",
        at: application.submittedAt,
        application,
      })),
    ...(sources.keyOrders ?? [])
      .filter((order) => order.status === "SUBMITTED")
      .map((order): WaitingItem => ({
        kind: "keyOrder",
        at: order.submittedAt,
        order,
      })),
  ];
  return items.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** How many bookings the panel lists before it points at the screen. */
export const BOOKINGS_SHOWN = 5;

/**
 * The bookings still to be used, soonest first.
 *
 * The list the API answers with is already the live and unfinished ones; this
 * keeps the ones that are booked, which leaves out nothing today and keeps a
 * cancelled one off the page should the API ever start to answer with it.
 */
export function upcomingBookings(
  bookings: readonly OwnBooking[],
): OwnBooking[] {
  return bookings
    .filter((booking) => booking.status === "BOOKED")
    .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, BOOKINGS_SHOWN);
}

/** How many dates the events panel lists. */
export const EVENTS_SHOWN = 3;

/**
 * The next dates that go ahead, soonest first.
 *
 * A called-off date is left out here and kept on the calendar, where the
 * reason it is not happening is shown beside it. On a short list it would take
 * a place from a date that is.
 */
export function nextEvents(
  occurrences: readonly AttendableOccurrence[],
): AttendableOccurrence[] {
  return occurrences
    .filter((occurrence) => occurrence.cancelledAt === null)
    .toSorted((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, EVENTS_SHOWN);
}

/** How many news items the panel lists. */
export const NEWS_SHOWN = 3;

/** The newest news items; the API already answers newest first. */
export function latestNews(articles: readonly NewsArticle[]): NewsArticle[] {
  return articles.slice(0, NEWS_SHOWN);
}
