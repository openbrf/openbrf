import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import type { ReachablePost } from "./feed-audience";
import {
  ATTACHABLE_HOURS,
  mayReadPostImage,
  UNATTACHED_IMAGE_HOURS,
} from "./feed-image";

/**
 * Who is served an image on a post, decided on the post and nowhere else.
 *
 * Whether somebody may read the post at all is `postFor`, whose own cases are in
 * `feed.service.spec.ts` and `group.int-spec.ts`; it is stubbed here so what
 * these cases show is what an image adds to it. Two things: an erased post has
 * no image to serve, and a struck post's images follow its text - its author and
 * the board, and nobody else in the group.
 */

const postFor = vi.fn();
vi.mock("./feed-audience", () => ({
  postFor: (...args: unknown[]) => postFor(...args),
}));

const holdsBoardSeat = vi.fn();
vi.mock("../mail/board-recipients", () => ({
  holdsBoardSeat: (...args: unknown[]) => holdsBoardSeat(...args),
}));

const NOW = new Date("2026-10-19T09:00:00.000Z");
const db = {} as PrismaService;

function reader(personId: string, capabilities: Capability[] = []): Principal {
  return {
    personId,
    capabilities: new Set(capabilities),
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

function post(overrides: Partial<ReachablePost> = {}): ReachablePost {
  return {
    id: "post-1",
    audience: {
      id: "audience-garden",
      kind: "GROUP",
      name: "Trädgårdsgruppen",
      createdByPersonId: "person-author",
    },
    authorPersonId: "person-author",
    struckAt: null,
    commentsAllowed: true,
    erasedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  postFor.mockReset();
  holdsBoardSeat.mockReset();
  holdsBoardSeat.mockResolvedValue(false);
});

describe("an image on a post", () => {
  it("is served to whoever may read the post, and asks about that post", async () => {
    postFor.mockResolvedValue(post());

    await expect(
      mayReadPostImage(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBe(true);
    expect(postFor).toHaveBeenCalledWith(db, "post-1", "person-neighbour", NOW);
  });

  it("is refused to whoever may not read the post", async () => {
    // An outsider, the administrator and the board outside a report all get
    // null from `postFor`, so all of them get this.
    postFor.mockResolvedValue(null);

    await expect(
      mayReadPostImage(
        db,
        "post-1",
        reader("person-outsider", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBe(false);
  });

  it("is refused on an erased post, to everybody", async () => {
    postFor.mockResolvedValue(post({ erasedAt: NOW, authorPersonId: null }));

    await expect(
      mayReadPostImage(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBe(false);
  });

  it("follows a struck post's text: its author and the board, and nobody else", async () => {
    postFor.mockResolvedValue(post({ struckAt: NOW }));

    await expect(
      mayReadPostImage(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBe(false);
    await expect(
      mayReadPostImage(db, "post-1", reader("person-author"), NOW),
    ).resolves.toBe(true);

    holdsBoardSeat.mockResolvedValue(true);
    await expect(
      mayReadPostImage(
        db,
        "post-1",
        reader("person-chair", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBe(true);
  });

  it("takes neither the capability without a seat nor a seat without the capability as the board", async () => {
    postFor.mockResolvedValue(post({ struckAt: NOW }));

    await expect(
      mayReadPostImage(
        db,
        "post-1",
        reader("person-admin", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBe(false);

    holdsBoardSeat.mockResolvedValue(true);
    await expect(
      mayReadPostImage(db, "post-1", reader("person-seated"), NOW),
    ).resolves.toBe(false);
  });
});

describe("the two windows an upload lives between", () => {
  it("sweeps only what no write would still attach", () => {
    // The gap is what keeps the sweep's delete from meeting a write's insert.
    expect(UNATTACHED_IMAGE_HOURS).toBeGreaterThan(ATTACHABLE_HOURS);
  });
});
