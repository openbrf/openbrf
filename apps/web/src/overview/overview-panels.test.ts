import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { OwnBooking } from "../api/bookings";
import type { AttendableOccurrence } from "../api/events";
import type { OwnIssue } from "../api/issues";
import type { OwnKeyOrder } from "../api/key-orders";
import type { OwnMotion } from "../api/motions";
import type { NewsArticle } from "../api/news-reader";
import type { OwnSubletApplication } from "../api/sublets";
import {
  latestNews,
  nextEvents,
  offersAnything,
  overviewPanelsFor,
  upcomingBookings,
  waitingItems,
} from "./overview-panels";

/*
 * Each seat's whole grant, written out rather than imported, so a change to a
 * grant shows up here as a changed expectation rather than as a test that
 * silently follows it. The same lists nav-items.test.ts carries.
 */
const RESIDENT = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
];
const MEMBER = [...RESIDENT, "motions:submit", "sublets:apply"];
const BOARD = [
  "apartmentBinder:manage",
  "association:read",
  "boardPosition:manage",
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "registerReport:export",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "news:comment",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
  "events:manage",
  "motions:handle",
  "meetings:manage",
  "events:attend",
  "memberCharges:manage",
  "fees:manage",
  "dataProtection:manage",
  "boardMailbox:handle",
  "sublets:handle",
  "keyOrders:place",
  "keyOrders:handle",
  "chat:participate",
  "chat:moderate",
];
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

describe("which panels a seat is given", () => {
  it("gives a resident their own matters, bookings, events and news, and nothing to handle", () => {
    expect(overviewPanelsFor(RESIDENT)).toEqual({
      waiting: {
        issues: true,
        motions: false,
        sublets: false,
        keyOrders: true,
      },
      bookings: true,
      events: true,
      news: true,
      toHandle: [],
    });
  });

  it("reads a member's motions and sublet applications as well", () => {
    expect(overviewPanelsFor(MEMBER).waiting).toEqual({
      issues: true,
      motions: true,
      sublets: true,
      keyOrders: true,
    });
    expect(overviewPanelsFor(MEMBER).toHandle).toEqual([]);
  });

  it("gives the board every queue it holds, in order, beside the resident panels", () => {
    const board = overviewPanelsFor(BOARD);
    expect(board.toHandle).toEqual([
      "issues",
      "boardMailbox",
      "motions",
      "sublets",
      "keyOrders",
      "brokerUpdateRequests",
      "accountRequests",
      "chatReports",
    ]);
    expect(board.bookings && board.events && board.news).toBe(true);
    // A board seat holds no tenant-ownership by itself, so no motions of its
    // own to wait on.
    expect(board.waiting).toEqual({
      issues: true,
      motions: false,
      sublets: false,
      keyOrders: true,
    });
  });

  it("gives the property manager the new issues and nothing of the house's", () => {
    expect(overviewPanelsFor(PROPERTY_MANAGER)).toEqual({
      waiting: null,
      bookings: false,
      events: false,
      news: false,
      toHandle: ["issues"],
    });
  });

  it("gives a seat one queue per capability it holds and no other", () => {
    expect(overviewPanelsFor(["sublets:handle"]).toHandle).toEqual(["sublets"]);
    expect(overviewPanelsFor(["chat:moderate"]).toHandle).toEqual([
      "chatReports",
    ]);
    expect(overviewPanelsFor(["signupRequest:decide"]).toHandle).toEqual([
      "accountRequests",
    ]);
  });

  it("offers nothing to an account with no capabilities", () => {
    expect(offersAnything(overviewPanelsFor([]))).toBe(false);
    expect(offersAnything(overviewPanelsFor(["self:manage"]))).toBe(false);
    expect(offersAnything(overviewPanelsFor(PROPERTY_MANAGER))).toBe(true);
  });
});

const issue = (overrides: Partial<OwnIssue>): OwnIssue => ({
  id: "issue",
  status: "NEW",
  typeId: "type",
  typeName: "Tvättstuga",
  location: null,
  description: "",
  apartment: null,
  photos: [],
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  ...overrides,
});

const motion = (overrides: Partial<OwnMotion>): OwnMotion => ({
  id: "motion",
  title: "Cykelställ",
  body: "",
  status: "SUBMITTED",
  submittedAt: "2026-10-02T08:00:00.000Z",
  closedAt: null,
  meeting: null,
  ...overrides,
});

const sublet = (
  overrides: Partial<OwnSubletApplication>,
): OwnSubletApplication => ({
  id: "sublet",
  apartment: null,
  periodFrom: "2027-01-01",
  periodTo: "2027-06-30",
  reason: "",
  status: "SUBMITTED",
  submittedAt: "2026-10-03T08:00:00.000Z",
  closedAt: null,
  decisionNote: null,
  tribunalPermission: null,
  lettingEndedOn: null,
  ...overrides,
});

const keyOrder = (overrides: Partial<OwnKeyOrder>): OwnKeyOrder => ({
  id: "order",
  apartment: null,
  kind: "KEY",
  quantity: 1,
  note: null,
  status: "SUBMITTED",
  submittedAt: "2026-10-04T08:00:00.000Z",
  closedAt: null,
  boardNote: null,
  ...overrides,
});

describe("what is waiting on the association", () => {
  it("keeps open issues and unanswered submissions, newest first", () => {
    const items = waitingItems({
      issues: [
        issue({ id: "new", status: "NEW" }),
        issue({
          id: "doing",
          status: "IN_PROGRESS",
          createdAt: "2026-10-05T08:00:00.000Z",
        }),
        issue({ id: "done", status: "DONE" }),
      ],
      motions: [
        motion({ id: "open" }),
        motion({ id: "received", status: "ACKNOWLEDGED" }),
        motion({ id: "withdrawn", status: "WITHDRAWN" }),
      ],
      sublets: [
        sublet({ id: "open" }),
        sublet({ id: "consented", status: "CONSENTED" }),
        sublet({ id: "refused", status: "REFUSED" }),
      ],
      keyOrders: [
        keyOrder({ id: "open" }),
        keyOrder({ id: "handed", status: "HANDED_OVER" }),
        keyOrder({ id: "declined", status: "DECLINED" }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "issue",
      "keyOrder",
      "sublet",
      "motion",
      "issue",
    ]);
    expect(items[0]?.kind === "issue" && items[0].issue.id).toBe("doing");
    expect(items.at(-1)?.kind === "issue" && items.at(-1)).toMatchObject({
      issue: { id: "new" },
    });
  });

  it("is empty when everything has been answered", () => {
    expect(
      waitingItems({
        issues: [issue({ status: "DONE" })],
        motions: [motion({ status: "ACKNOWLEDGED" })],
      }),
    ).toEqual([]);
    expect(waitingItems({})).toEqual([]);
  });
});

const booking = (overrides: Partial<OwnBooking>): OwnBooking => ({
  id: "booking",
  resourceId: "laundry",
  resourceName: "Tvättstugan",
  mode: "TIME_SLOTS",
  status: "BOOKED",
  startsAt: "2026-10-20T07:00:00.000Z",
  endsAt: "2026-10-20T09:00:00.000Z",
  apartment: null,
  ...overrides,
});

describe("the upcoming bookings", () => {
  it("keeps the booked ones, soonest first, five at most", () => {
    const bookings = [
      booking({ id: "later", startsAt: "2026-10-25T07:00:00.000Z" }),
      booking({ id: "cancelled", status: "CANCELLED" }),
      booking({ id: "sooner", startsAt: "2026-10-19T07:00:00.000Z" }),
      ...["a", "b", "c", "d", "e"].map((id) =>
        booking({ id, startsAt: "2026-11-01T07:00:00.000Z" }),
      ),
    ];

    const upcoming = upcomingBookings(bookings);
    expect(upcoming).toHaveLength(5);
    expect(upcoming.slice(0, 2).map((item) => item.id)).toEqual([
      "sooner",
      "later",
    ]);
    expect(upcoming.map((item) => item.id)).not.toContain("cancelled");
  });

  describe("while one is under way", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps it, at the head of the list", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));

      const upcoming = upcomingBookings([
        booking({ id: "next", startsAt: "2026-10-22T07:00:00.000Z" }),
        booking({
          id: "now",
          startsAt: "2026-10-20T07:00:00.000Z",
          endsAt: "2026-10-20T09:00:00.000Z",
        }),
      ]);
      expect(upcoming.map((item) => item.id)).toEqual(["now", "next"]);
    });
  });
});

const occurrence = (
  overrides: Partial<AttendableOccurrence>,
): AttendableOccurrence => ({
  occurrenceId: "occurrence",
  eventId: "event",
  title: "Städdag",
  description: null,
  category: null,
  location: null,
  startsAt: "2026-10-24T08:00:00.000Z",
  endsAt: "2026-10-24T12:00:00.000Z",
  on: "2026-10-24",
  cancelledAt: null,
  begun: false,
  visibility: "MEMBER",
  signupOpen: true,
  capacity: null,
  placesTaken: 0,
  placesLeft: null,
  own: null,
  ...overrides,
});

describe("the next events", () => {
  it("lists the next three dates that go ahead", () => {
    const next = nextEvents([
      occurrence({ occurrenceId: "4", startsAt: "2026-12-01T08:00:00.000Z" }),
      occurrence({ occurrenceId: "1", startsAt: "2026-10-20T08:00:00.000Z" }),
      occurrence({
        occurrenceId: "off",
        startsAt: "2026-10-21T08:00:00.000Z",
        cancelledAt: "2026-10-10T08:00:00.000Z",
      }),
      occurrence({ occurrenceId: "2", startsAt: "2026-10-22T08:00:00.000Z" }),
      occurrence({ occurrenceId: "3", startsAt: "2026-11-01T08:00:00.000Z" }),
    ]);
    expect(next.map((item) => item.occurrenceId)).toEqual(["1", "2", "3"]);
  });
});

describe("the latest news", () => {
  it("is the first three of what the API answers, which is newest first", () => {
    const article = (id: string): NewsArticle => ({
      id,
      slug: id,
      title: id,
      content: { version: 1, blocks: [] },
      publishedAt: "2026-10-01T08:00:00.000Z",
      commentsAllowed: true,
    });
    expect(
      latestNews(["a", "b", "c", "d"].map(article)).map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
  });
});
