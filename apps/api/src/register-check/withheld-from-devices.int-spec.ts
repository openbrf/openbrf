import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { PrismaService } from "../database/prisma.service";
import { derivedAudience } from "../feed/feed-audience";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { RegisterCheckService } from "./register-check.service";
import { WithheldFromDevicesService } from "./withheld-from-devices.service";

/**
 * Which news an editor's mark may speak of (ADR 0032), against a real
 * database.
 *
 * The audience filter is a query, so a stub of the database would answer for
 * itself. Here the register check withholds every text it is handed, which
 * leaves the query as the only thing that decides which items are marked: the
 * item written to Alla is, and the items confined to Styrelsen or
 * Administratörer are answered as if they did not exist.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaService;
let service: WithheldFromDevicesService;

const suffix = runSuffix();
const AUTHOR_ID = `withheld-author-${suffix}`;
const ids = {
  house: `withheld-news-house-${suffix}`,
  board: `withheld-news-board-${suffix}`,
  admin: `withheld-news-admin-${suffix}`,
};

beforeAll(async () => {
  prisma = new PrismaService(env);
  await prisma.$connect();
  const registerCheck = {
    matches: vi.fn(async (items: readonly unknown[]) =>
      items.map(() => [{ words: "Svensson", protectedOnly: false }]),
    ),
  } as unknown as RegisterCheckService;
  service = new WithheldFromDevicesService(prisma, registerCheck);

  const body = {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Hej" }] }],
  };
  for (const [id, kind] of [
    [ids.house, "ALL"],
    [ids.board, "BOARD"],
    [ids.admin, "ADMIN"],
  ] as const) {
    const audience = await derivedAudience(prisma, kind);
    await prisma.news.create({
      data: {
        id,
        slug: id,
        title: `Från styrelsen ${kind}`,
        content: body,
        visibility: "MEMBER",
        published: true,
        publishedAt: new Date(),
        authorPersonId: AUTHOR_ID,
        post: {
          create: {
            audienceId: audience.id,
            authorPersonId: AUTHOR_ID,
            byBoard: true,
          },
        },
      },
    });
  }
});

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  try {
    await prisma.news.deleteMany({
      where: { id: { in: Object.values(ids) } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe("WithheldFromDevicesService.news", () => {
  it("marks the item written to Alla and leaves out the ones confined to Styrelsen or Administratörer", async () => {
    const marked = await service.news(Object.values(ids));

    expect(marked.map((item) => item.id)).toEqual([ids.house]);
  });
});
