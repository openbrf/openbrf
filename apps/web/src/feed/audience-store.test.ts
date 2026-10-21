import type { AudienceListView } from "@openbrf/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  audienceSnapshot,
  markAudienceReadInStore,
  reloadAudiences,
  subscribeToAudiences,
  totalUnread,
} from "./audience-store";
import { ALL, ok, refused, STAIRWELL } from "./feed-fixtures";

/**
 * The one list of audiences the feed and the navigation read.
 *
 * **One read at a time.** A reload asked for while one is on its way is run
 * once more after it, never beside it and never dropped: the answer on its way
 * may be from before a group was made.
 *
 * **Nothing is kept for nobody.** Once the last reader lets go, the list goes,
 * and an answer still on its way is not applied.
 */

const fetchAudiences = vi.fn();

vi.mock("../api/feed", () => ({
  fetchAudiences: () => fetchAudiences(),
}));

function listOf(...unread: number[]): AudienceListView {
  return {
    audiences: [ALL, STAIRWELL]
      .slice(0, unread.length)
      .map((audience, index) => ({ ...audience, unread: unread[index] ?? 0 })),
    mayCreateGroup: true,
    mayPostAsBoard: false,
  };
}

/** An answer the test lets go of when it chooses. */
function held<T>(): { promise: Promise<T>; answer: (value: T) => void } {
  let answer: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

let release: () => void = () => undefined;

beforeEach(() => {
  fetchAudiences.mockReset();
  release = subscribeToAudiences(() => undefined);
});

afterEach(() => {
  release();
});

describe("the list of audiences", () => {
  it("is what the server last answered, with the unread summed", async () => {
    fetchAudiences.mockResolvedValue(ok(listOf(2, 3)));
    expect(await reloadAudiences()).toBe(true);
    expect(totalUnread(audienceSnapshot())).toBe(5);
  });

  it("asks once more after the read on its way, rather than beside it", async () => {
    const first = held<ReturnType<typeof ok>>();
    fetchAudiences
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(listOf(7)));

    const asked = reloadAudiences();
    // Two more asks while the first is on its way are one more read.
    void reloadAudiences();
    void reloadAudiences();
    expect(fetchAudiences).toHaveBeenCalledTimes(1);

    first.answer(ok(listOf(1)));
    await asked;
    expect(fetchAudiences).toHaveBeenCalledTimes(2);
    expect(totalUnread(audienceSnapshot())).toBe(7);
  });

  it("lets a mount or a poll share the read on its way instead of asking again", async () => {
    const first = held<ReturnType<typeof ok>>();
    fetchAudiences.mockReturnValueOnce(first.promise);

    const asked = reloadAudiences({ joinInFlight: true });
    void reloadAudiences({ joinInFlight: true });
    void reloadAudiences({ joinInFlight: true });

    first.answer(ok(listOf(4)));
    await asked;
    expect(fetchAudiences).toHaveBeenCalledTimes(1);
    expect(totalUnread(audienceSnapshot())).toBe(4);
  });

  it("keeps the list beside a read that failed, and counts nothing from it", async () => {
    fetchAudiences.mockResolvedValueOnce(ok(listOf(2)));
    await reloadAudiences();
    fetchAudiences.mockResolvedValueOnce(refused(0, "offline"));
    expect(await reloadAudiences()).toBe(false);

    expect(audienceSnapshot().list?.audiences).toHaveLength(1);
    expect(audienceSnapshot().failure).toBe("failed");
    expect(totalUnread(audienceSnapshot())).toBeNull();
  });

  it("says a refusal by the guard is not offered rather than failed", async () => {
    fetchAudiences.mockResolvedValue(refused(403, "forbidden"));
    await reloadAudiences();
    expect(audienceSnapshot().failure).toBe("notOffered");
  });

  it("takes an audience down to none once its marker lands", async () => {
    fetchAudiences.mockResolvedValue(ok(listOf(2, 3)));
    await reloadAudiences();
    markAudienceReadInStore(ALL.id, "2026-09-18T08:00:00.000Z");
    expect(totalUnread(audienceSnapshot())).toBe(3);
  });

  it("moves the marker to the instant the server acknowledged, and never back", async () => {
    fetchAudiences.mockResolvedValue(
      ok({
        audiences: [{ ...ALL, unread: 2, readAt: "2026-09-17T12:00:00.000Z" }],
        mayCreateGroup: true,
        mayPostAsBoard: false,
      }),
    );
    await reloadAudiences();
    const marker = () => audienceSnapshot().list?.audiences[0]?.readAt;

    markAudienceReadInStore(ALL.id, "2026-09-18T08:00:00.000Z");
    expect(marker()).toBe("2026-09-18T08:00:00.000Z");

    // An acknowledgement that arrives late, for an earlier instant.
    markAudienceReadInStore(ALL.id, "2026-09-17T13:00:00.000Z");
    expect(marker()).toBe("2026-09-18T08:00:00.000Z");
  });

  it("does not let a read that left before a marker landed take it back", async () => {
    const markerOf = (readAt: string, unread: number) =>
      ok({
        audiences: [{ ...ALL, unread, readAt }],
        mayCreateGroup: true,
        mayPostAsBoard: false,
      });
    fetchAudiences.mockResolvedValueOnce(
      markerOf("2026-09-17T12:00:00.000Z", 1),
    );
    await reloadAudiences();
    const marker = () => audienceSnapshot().list?.audiences[0]?.readAt;

    // A poll leaves, the marker lands, and then the poll answers.
    const stale = held<ReturnType<typeof ok>>();
    const fresh = held<ReturnType<typeof ok>>();
    fetchAudiences
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const asked = reloadAudiences();
    markAudienceReadInStore(ALL.id, "2026-09-18T08:00:00.000Z");
    expect(totalUnread(audienceSnapshot())).toBe(0);

    stale.answer(markerOf("2026-09-17T12:00:00.000Z", 1));
    await new Promise((settled) => setTimeout(settled, 0));
    expect(marker()).toBe("2026-09-18T08:00:00.000Z");
    expect(totalUnread(audienceSnapshot())).toBe(0);
    expect(fetchAudiences).toHaveBeenCalledTimes(3);

    // The read made after the marker is applied, with what arrived since.
    fresh.answer(markerOf("2026-09-18T08:00:00.000Z", 2));
    expect(await asked).toBe(true);
    expect(marker()).toBe("2026-09-18T08:00:00.000Z");
    expect(totalUnread(audienceSnapshot())).toBe(2);
  });

  it("is let go with its last reader, and an answer on its way is not applied", async () => {
    const late = held<ReturnType<typeof ok>>();
    fetchAudiences.mockResolvedValueOnce(ok(listOf(2)));
    await reloadAudiences();

    fetchAudiences.mockReturnValueOnce(late.promise);
    const asked = reloadAudiences();
    release();
    expect(audienceSnapshot().list).toBeNull();

    late.answer(ok(listOf(9)));
    await asked;
    expect(audienceSnapshot().list).toBeNull();
    release = subscribeToAudiences(() => undefined);
  });
});
