import { describe, expect, it, vi } from "vite-plus/test";

import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { paragraphsContent } from "../site/page-content";
import { newsText, speaksForBoard } from "./feed-board";

/**
 * Who speaks for the board in the feed, and what a news item says there.
 *
 * Both halves of `speaksForBoard` are asked, every time: a seat without the
 * capability is not enough, and the capability without a seat - the
 * administrator's case - is not either. Whether a seat has ended is the
 * register's own query (`board-recipients.ts`), so the fake answers it.
 */

function principal(capabilities: Capability[]): Principal {
  return {
    personId: "person-astrid",
    capabilities: new Set(capabilities),
    isAdmin: false,
    isBoardMember: true,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

function register(seated: boolean) {
  const findFirst = vi.fn(() =>
    Promise.resolve(seated ? { id: "person-astrid" } : null),
  );
  return {
    db: { person: { findFirst } } as unknown as PrismaService,
    findFirst,
  };
}

describe("speaking for the board", () => {
  const now = new Date("2026-09-17T09:00:00.000Z");

  it("takes a seat that has not ended and the capability that publishes", async () => {
    const { db } = register(true);
    expect(await speaksForBoard(db, principal(["site:manage"]), now)).toBe(
      true,
    );
  });

  it("is not the administrator's, who holds every capability and no seat", async () => {
    const { db } = register(false);
    expect(await speaksForBoard(db, principal(["site:manage"]), now)).toBe(
      false,
    );
  });

  it("is not a seat's alone, without the capability, and asks nothing then", async () => {
    const { db, findFirst } = register(true);
    expect(await speaksForBoard(db, principal(["chat:participate"]), now)).toBe(
      false,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("a news item's text", () => {
  it("is its prose, a blank line between each block", () => {
    expect(
      newsText(
        paragraphsContent(["Tisdag 9-12.", "Fyll en kanna kvällen före."]),
      ),
    ).toBe("Tisdag 9-12.\n\nFyll en kanna kvällen före.");
  });

  it("is nothing for a body nobody can read", () => {
    expect(newsText(null)).toBe("");
    expect(newsText({ blocks: "inte en lista" })).toBe("");
  });
});
