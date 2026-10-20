import type { AudienceView, PostCommentView, PostView } from "@openbrf/shared";

import type { Viewer } from "../api/instance";

/**
 * The people, audiences and posts the feed's tests are written about.
 *
 * Fictional, and shaped exactly as the API answers, so a test states the facts
 * it is about and nothing else. Not a test file itself: the suites import it.
 */

export const ASTRID = "person-astrid";
export const BO = "person-bo";

/** An account reading the feed, holding these capabilities. */
export function viewer(capabilities: readonly string[] = []): Viewer {
  return {
    personId: ASTRID,
    firstName: "Astrid",
    lastName: "Lindqvist",
    preferredLocale: "sv",
    capabilities: ["chat:participate", ...capabilities],
    housingCooperative: null,
  };
}

export const ALL: AudienceView = {
  id: "audience-all",
  kind: "ALL",
  name: null,
  unread: 0,
  lastPostAt: "2026-09-17T09:00:00.000Z",
};

export const BOARD: AudienceView = {
  id: "audience-board",
  kind: "BOARD",
  name: null,
  unread: 0,
  lastPostAt: "2026-09-17T09:00:00.000Z",
};

export const STAIRWELL: AudienceView = {
  id: "audience-stairwell",
  kind: "GROUP",
  name: "Uppgång C",
  unread: 0,
  lastPostAt: "2026-09-17T09:00:00.000Z",
};

export const GARDEN: AudienceView = {
  id: "audience-garden",
  kind: "GROUP",
  name: "Trädgårdsgruppen",
  unread: 0,
  lastPostAt: "2026-09-17T09:00:00.000Z",
};

/** A post nobody has reacted to, to Alla, from Bo, unless the facts say otherwise. */
export function post(
  facts: Partial<PostView> & Pick<PostView, "id">,
): PostView {
  return {
    audience: { id: ALL.id, kind: "ALL", name: null },
    author: { kind: "person", personId: BO, name: "Bo Ek" },
    byBoard: false,
    body: "Tvättstugan är stängd på torsdag.",
    images: [],
    news: null,
    important: false,
    pinned: false,
    commentsAllowed: true,
    scheduledAt: null,
    createdAt: "2026-09-17T09:00:00.000Z",
    editedAt: null,
    struckAt: null,
    erasedAt: null,
    likes: 0,
    liked: false,
    comments: 0,
    readBy: 0,
    ...facts,
  };
}

/** A comment from Bo, unless the facts say otherwise. */
export function comment(
  facts: Partial<PostCommentView> & Pick<PostCommentView, "id">,
): PostCommentView {
  return {
    postId: "post-1",
    author: { kind: "person", personId: BO, name: "Bo Ek" },
    byBoard: false,
    body: "Tack för att du säger till.",
    createdAt: "2026-09-17T10:00:00.000Z",
    editedAt: null,
    struckAt: null,
    likes: 0,
    liked: false,
    ...facts,
  };
}

/** An answer the API gave. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** A refusal the API gave. */
export function refused(
  status: number,
  reason: string,
): { ok: false; failure: { status: number; reason: string } } {
  return { ok: false, failure: { status, reason } };
}

/**
 * An IntersectionObserver the test drives: `seeAll` reports every observed
 * element as half on screen, which is what marks a post read.
 */
export function installIntersectionObserver(): { seeAll: () => void } {
  const observers: {
    callback: IntersectionObserverCallback;
    targets: Element[];
    instance: IntersectionObserver;
  }[] = [];

  class FakeObserver {
    private readonly entry: (typeof observers)[number];

    constructor(callback: IntersectionObserverCallback) {
      this.entry = {
        callback,
        targets: [],
        instance: this as unknown as IntersectionObserver,
      };
      observers.push(this.entry);
    }

    observe(target: Element): void {
      this.entry.targets.push(target);
    }

    disconnect(): void {
      this.entry.targets = [];
    }

    unobserve(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    FakeObserver as unknown as typeof IntersectionObserver;

  return {
    seeAll: () => {
      for (const observer of observers) {
        if (observer.targets.length === 0) {
          continue;
        }
        observer.callback(
          observer.targets.map(
            (target) =>
              ({
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                rootBounds: null,
                intersectionRect: target.getBoundingClientRect(),
                boundingClientRect: target.getBoundingClientRect(),
                time: 0,
              }) as IntersectionObserverEntry,
          ),
          observer.instance,
        );
      }
    },
  };
}
