import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import type { ReachablePost } from "./feed-audience";
import {
  ATTACHABLE_HOURS,
  postImageAccess,
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
 *
 * And the one way in from outside the audience: an open report, to an account
 * that answers reports. The reports are answered from rows rather than with a
 * yes, so a rule that dropped "open" or asked about another post would fail.
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

/** The reports standing against posts: which post, and whether answered. */
let reports: { postId: string; resolvedAt: Date | null }[] = [];

const db = {
  postReport: {
    count: vi.fn(
      async (args: {
        where: {
          postId: string;
          resolvedAt: null;
          post: { erasedAt: null };
        };
      }) =>
        reports.filter(
          (report) =>
            report.postId === args.where.postId &&
            report.resolvedAt === args.where.resolvedAt &&
            args.where.post.erasedAt === null,
        ).length,
    ),
  },
} as unknown as PrismaService;

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
    byBoard: false,
    struckAt: null,
    commentsAllowed: true,
    erasedAt: null,
    ...overrides,
    // Standing in for what `postFor` answered, which the mock does.
  } as ReachablePost;
}

beforeEach(() => {
  reports = [];
  postFor.mockReset();
  holdsBoardSeat.mockReset();
  holdsBoardSeat.mockResolvedValue(false);
});

describe("an image on a post", () => {
  it("is served to whoever may read the post, and asks about that post", async () => {
    postFor.mockResolvedValue(post());

    await expect(
      postImageAccess(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBe("audience");
    expect(postFor).toHaveBeenCalledWith(db, "post-1", "person-neighbour", NOW);
  });

  it("is refused to whoever may not read the post", async () => {
    // An outsider, the administrator and the board outside a report all get
    // null from `postFor`, so all of them get this when nothing is reported.
    postFor.mockResolvedValue(null);

    await expect(
      postImageAccess(
        db,
        "post-1",
        reader("person-outsider", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBeNull();
  });

  it("is refused on an erased post, to everybody", async () => {
    postFor.mockResolvedValue(post({ erasedAt: NOW, authorPersonId: null }));

    await expect(
      postImageAccess(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBeNull();
  });

  it("follows a struck post's text: its author and the board, and nobody else", async () => {
    postFor.mockResolvedValue(post({ struckAt: NOW }));

    await expect(
      postImageAccess(db, "post-1", reader("person-neighbour"), NOW),
    ).resolves.toBeNull();
    await expect(
      postImageAccess(db, "post-1", reader("person-author"), NOW),
    ).resolves.toBe("audience");

    holdsBoardSeat.mockResolvedValue(true);
    await expect(
      postImageAccess(
        db,
        "post-1",
        reader("person-chair", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBe("audience");
  });

  it("takes neither the capability without a seat nor a seat without the capability as the board", async () => {
    postFor.mockResolvedValue(post({ struckAt: NOW }));

    await expect(
      postImageAccess(
        db,
        "post-1",
        reader("person-admin", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBeNull();

    holdsBoardSeat.mockResolvedValue(true);
    await expect(
      postImageAccess(db, "post-1", reader("person-seated"), NOW),
    ).resolves.toBeNull();
  });
});

describe("an image on a reported post, to the board outside the group", () => {
  const chair = reader("person-chair", ["chat:moderate"]);

  beforeEach(() => {
    // Outside the group: the post is not in front of them.
    postFor.mockResolvedValue(null);
    holdsBoardSeat.mockResolvedValue(true);
  });

  it("is refused while nothing is reported", async () => {
    await expect(postImageAccess(db, "post-1", chair, NOW)).resolves.toBeNull();
  });

  it("is served through an open report, and says that is how", async () => {
    reports = [{ postId: "post-1", resolvedAt: null }];

    await expect(postImageAccess(db, "post-1", chair, NOW)).resolves.toBe(
      "report",
    );
    expect(holdsBoardSeat).toHaveBeenCalledWith(db, "person-chair", NOW);
  });

  it("is refused once the board has answered the report", async () => {
    reports = [{ postId: "post-1", resolvedAt: NOW }];

    await expect(postImageAccess(db, "post-1", chair, NOW)).resolves.toBeNull();
  });

  it("is refused through a report about another post", async () => {
    reports = [{ postId: "post-2", resolvedAt: null }];

    await expect(postImageAccess(db, "post-1", chair, NOW)).resolves.toBeNull();
  });

  it("opens to neither the capability without a seat nor a seat without the capability", async () => {
    reports = [{ postId: "post-1", resolvedAt: null }];

    // The administrator: every capability and no seat.
    holdsBoardSeat.mockResolvedValue(false);
    await expect(
      postImageAccess(
        db,
        "post-1",
        reader("person-admin", ["chat:moderate"]),
        NOW,
      ),
    ).resolves.toBeNull();

    holdsBoardSeat.mockResolvedValue(true);
    await expect(
      postImageAccess(db, "post-1", reader("person-seated"), NOW),
    ).resolves.toBeNull();
  });

  it("is refused to a resident outside the group, reported or not", async () => {
    reports = [{ postId: "post-1", resolvedAt: null }];
    holdsBoardSeat.mockResolvedValue(false);

    await expect(
      postImageAccess(db, "post-1", reader("person-outsider"), NOW),
    ).resolves.toBeNull();
  });
});

describe("the two windows an upload lives between", () => {
  it("sweeps only what no write would still attach", () => {
    // The gap is what keeps the sweep's delete from meeting a write's insert.
    expect(UNATTACHED_IMAGE_HOURS).toBeGreaterThan(ATTACHABLE_HOURS);
  });
});
