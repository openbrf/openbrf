import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { paragraphsContent, type PageContent } from "../site/page-content";
import type { NewsMailerService } from "./news-mailer.service";
import type { NewsSmsService } from "./news-sms.service";
import { NewsWriteError, NewsWriteService } from "./news-write.service";

/**
 * What publishing a news item does, as rules rather than as endpoints.
 *
 * The claim is what this file is for. "The members are mailed once and never
 * again" is a promise the platform makes on the board's behalf, and the way it
 * is kept is one conditional update inside one transaction - so the cases below
 * assert on the shape of that update, on what an edit does not write, and on
 * what a second publish does not do.
 */

const ITEM = {
  id: "news-1",
  slug: "tvattstugan",
  title: "Tvättstugan",
  content: paragraphsContent(["Nya tider gäller från måndag."]) as unknown,
  visibility: "MEMBER" as "MEMBER" | "PUBLIC",
  published: false,
  publishedAt: null,
  emailQueuedAt: null as Date | null,
  smsQueuedAt: null as Date | null,
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  deliveries: [] as {
    channel: string;
    status: string;
    failureReason: string | null;
  }[],
};

interface Fakes {
  service: NewsWriteService;
  news: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  person: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  newsDelivery: { createMany: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  mailer: {
    ensureQueues: ReturnType<typeof vi.fn>;
    enqueueInTransaction: ReturnType<typeof vi.fn>;
  };
  texter: {
    ensureQueues: ReturnType<typeof vi.fn>;
    enqueueInTransaction: ReturnType<typeof vi.fn>;
  };
  /** What the mailer was asked to do, in the order it was asked. */
  order: string[];
}

function build(
  overrides: Partial<typeof ITEM> = {},
  options: { claims?: boolean; members?: string[] } = {},
): Fakes {
  const stored = { ...ITEM, ...overrides };

  const news = {
    findMany: vi.fn().mockResolvedValue([stored]),
    // By id it is the stored item; by slug it is nothing, so an address is
    // free unless a case says otherwise. The two lookups are the same method
    // and only the argument tells them apart.
    findUnique: vi.fn(async (args: { where: { id?: string } }) =>
      args.where.id === undefined ? null : stored,
    ),
    create: vi.fn(async (args: { data: object }) => ({
      ...stored,
      ...args.data,
    })),
    update: vi.fn(async (args: { data: object }) => ({
      ...stored,
      ...args.data,
    })),
    // The claim. One row matched means this call is the mailing; nought means
    // somebody else already claimed it.
    updateMany: vi
      .fn()
      .mockResolvedValue({ count: options.claims === false ? 0 : 1 }),
    delete: vi.fn().mockResolvedValue(stored),
  };
  const person = {
    findMany: vi
      .fn()
      .mockResolvedValue(
        (options.members ?? ["person-1", "person-2"]).map((id) => ({ id })),
      ),
    count: vi.fn().mockResolvedValue(2),
  };
  const newsDelivery = { createMany: vi.fn().mockResolvedValue({ count: 2 }) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const order: string[] = [];
  const mailer = {
    ensureQueues: vi.fn(async () => {
      order.push("ensureQueues");
    }),
    enqueueInTransaction: vi.fn(async () => {
      order.push("enqueue");
    }),
  };
  const texter = {
    ensureQueues: vi.fn(async () => {
      order.push("ensureSmsQueues");
    }),
    enqueueInTransaction: vi.fn(async () => {
      order.push("enqueueSms");
    }),
  };

  const prisma = {
    news,
    person,
    newsDelivery,
    // The transaction client is the same fake: what these tests check is that
    // the claim, the ledger, the audit entries and the job are written by one
    // call, not that Postgres isolates them.
    $transaction: vi.fn(
      async (run: unknown) =>
        await (run as (tx: unknown) => Promise<unknown>)(prisma),
    ),
  };

  return {
    service: new NewsWriteService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      mailer as unknown as NewsMailerService,
      texter as unknown as NewsSmsService,
    ),
    news,
    person,
    newsDelivery,
    audit,
    mailer,
    texter,
    order,
  };
}

async function refusalOf(run: Promise<unknown>): Promise<NewsWriteError> {
  try {
    await run;
  } catch (cause) {
    if (cause instanceof NewsWriteError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("The write was expected to be refused, and was not.");
}

const PLAIN: PageContent = paragraphsContent(["Hej på er."]);

/** Whoever is signed in when an item is written. */
const AUTHOR = "person-board";

describe("writing a news item", () => {
  it("stores it unpublished, so nothing is readable before it is meant to be", async () => {
    const { service, news } = build();

    await service.create({
      slug: "hej",
      title: "Hej",
      content: PLAIN,
      authorPersonId: AUTHOR,
    });

    expect(news.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: false }),
      }),
    );
  });

  it("writes down who wrote it, which no later save could tell us", async () => {
    const { service, news } = build();

    await service.create({
      slug: "hej",
      title: "Hej",
      content: PLAIN,
      authorPersonId: AUTHOR,
    });

    expect(news.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorPersonId: AUTHOR }),
      }),
    );
  });

  it("refuses an address that is not shaped like one", async () => {
    const { service } = build();

    const refusal = await refusalOf(
      service.create({
        slug: "Inte En Adress",
        title: "Hej",
        content: PLAIN,
        authorPersonId: AUTHOR,
      }),
    );

    expect(refusal.reason).toBe("invalid-slug");
  });

  it("refuses an address another item already has", async () => {
    const { service, news } = build();
    // Creating looks the address up and nothing else, so one answer is enough.
    news.findUnique.mockResolvedValue({ id: "news-other" });

    const refusal = await refusalOf(
      service.create({
        slug: "hej",
        title: "Hej",
        content: PLAIN,
        authorPersonId: AUTHOR,
      }),
    );

    expect(refusal.reason).toBe("slug-taken");
  });

  it("refuses a block that is not prose, naming where it sits", async () => {
    const { service } = build();

    const refusal = await refusalOf(
      service.create({
        slug: "hej",
        title: "Hej",
        authorPersonId: AUTHOR,
        content: {
          version: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "Hej." }] },
            { type: "image", mediaFileId: "file-1", alt: "" },
          ],
        },
      }),
    );

    expect(refusal.reason).toBe("unsupported-block");
    expect(refusal.details().blocks).toEqual([1]);
  });
});

describe("the personal identity number guardrail", () => {
  it("refuses a published item that carries one, naming where", async () => {
    const { service } = build({ published: true });

    const refusal = await refusalOf(
      service.update("news-1", {
        slug: "tvattstugan",
        title: "Tvättstugan",
        content: paragraphsContent(["Kontakta 811228-9874 om nyckeln."]),
      }),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.details().locations).toEqual([
      { part: "block", index: 0, offset: 9 },
    ]);
  });

  it("lets a draft hold anything, because nobody can read a draft", async () => {
    const { service, news } = build({ published: false });

    await service.update("news-1", {
      slug: "tvattstugan",
      title: "Tvättstugan",
      content: paragraphsContent(["Kontakta 811228-9874 om nyckeln."]),
    });

    expect(news.update).toHaveBeenCalled();
  });

  it("refuses to move an item the members have already been mailed", async () => {
    const { service, news } = build({
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    const refusal = await refusalOf(
      service.update("news-1", {
        slug: "tvattstugan-nya-tider",
        title: "Tvättstugan",
        content: paragraphsContent(["Nya tider gäller från måndag."]),
      }),
    );

    expect(refusal.reason).toBe("address-mailed");
    expect(news.update).not.toHaveBeenCalled();
  });

  it("still corrects a mailed item at the address it was mailed at", async () => {
    const { service, news } = build({
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    await service.update("news-1", {
      slug: "tvattstugan",
      title: "Tvättstugan, rättad",
      content: paragraphsContent(["Nya tider gäller från måndag."]),
    });

    expect(news.update).toHaveBeenCalled();
  });

  it("refuses to publish an item that carries one", async () => {
    const { service } = build({
      content: paragraphsContent(["Ring 811228-9874."]),
    });

    const refusal = await refusalOf(
      service.publish("news-1", { published: true, actorPersonId: "board-1" }),
    );

    expect(refusal.reason).toBe("personal-identity-number");
  });
});

describe("the mailing, which happens once", () => {
  it("claims the column only while it is null", async () => {
    const { service, news } = build();

    await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(news.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailQueuedAt: null }),
      }),
    );
  });

  it("snapshots the members into the ledger and enqueues in the transaction", async () => {
    const { service, newsDelivery, mailer, audit } = build();

    const published = await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(published.mailedTo).toBe(2);
    expect(newsDelivery.createMany).toHaveBeenCalledWith({
      data: [
        { newsId: "news-1", personId: "person-1", channel: "EMAIL" },
        { newsId: "news-1", personId: "person-2", channel: "EMAIL" },
      ],
    });
    expect(mailer.enqueueInTransaction).toHaveBeenCalled();
    expect(audit.record.mock.calls.map((call) => call[0].action)).toEqual([
      "NEWS_PUBLISHED",
      "NEWS_EMAILED",
    ]);
  });

  it("creates the queues before the transaction opens", async () => {
    const { service, order } = build();

    await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(order).toEqual(["ensureQueues", "enqueue"]);
  });

  it("writes nothing for the loser of two concurrent publishes", async () => {
    const { service, newsDelivery, mailer, audit } = build(
      {},
      {
        claims: false,
      },
    );

    const published = await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(published.mailedTo).toBeNull();
    expect(newsDelivery.createMany).not.toHaveBeenCalled();
    expect(mailer.enqueueInTransaction).not.toHaveBeenCalled();
    expect(audit.record.mock.calls.map((call) => call[0].action)).toEqual([
      "NEWS_PUBLISHED",
    ]);
  });

  it("is not claimed again by a republish of an item that was mailed", async () => {
    const { service, news, newsDelivery } = build({
      published: false,
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(news.updateMany).not.toHaveBeenCalled();
    expect(newsDelivery.createMany).not.toHaveBeenCalled();
  });

  it("is not claimed when the board did not ask for it", async () => {
    const { service, news, mailer } = build();

    await service.publish("news-1", {
      published: true,
      sendEmail: false,
      actorPersonId: "board-1",
    });

    expect(news.updateMany).not.toHaveBeenCalled();
    expect(mailer.ensureQueues).not.toHaveBeenCalled();
  });

  it("writes nothing at all for a publish that changes nothing", async () => {
    const { service, news, audit } = build({
      published: true,
      visibility: "PUBLIC",
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    await service.publish("news-1", {
      published: true,
      visibility: "PUBLIC",
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(news.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("is not claimed by taking the item down", async () => {
    const { service, news } = build({ published: true });

    await service.publish("news-1", {
      published: false,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(news.updateMany).not.toHaveBeenCalled();
  });
});

describe("editing a published item", () => {
  it("never writes the column that says it was mailed", async () => {
    const { service, news } = build({
      published: true,
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    await service.update("news-1", {
      slug: "tvattstugan",
      title: "Tvättstugan igen",
      content: paragraphsContent(["En rättelse."]),
    });

    const written = news.update.mock.calls[0]?.[0] as { data: object };
    expect(Object.keys(written.data).sort()).toEqual([
      "content",
      "slug",
      "title",
    ]);
    expect(news.updateMany).not.toHaveBeenCalled();
  });
});

describe("the SMS mailing, which happens once and separately", () => {
  it("claims its own column, and only when the board asks for it", async () => {
    const { service, news } = build();

    const published = await service.publish("news-1", {
      published: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(published.textedTo).toBe(2);
    expect(news.updateMany).toHaveBeenCalledWith({
      where: { id: "news-1", smsQueuedAt: null },
      data: { smsQueuedAt: expect.any(Date) },
    });
  });

  it("does not claim the mailing when only the text message was asked for", async () => {
    // The two columns are two decisions. Asking for the channel that is still
    // available must not re-send the one that is not.
    const { service, news, mailer } = build();

    const published = await service.publish("news-1", {
      published: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(published.mailedTo).toBeNull();
    expect(mailer.enqueueInTransaction).not.toHaveBeenCalled();
    expect(news.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailQueuedAt: null }),
      }),
    );
  });

  it("can be claimed afterwards on an item that was already mailed", async () => {
    const { service, texter, mailer } = build({
      published: true,
      emailQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    const published = await service.publish("news-1", {
      published: true,
      sendEmail: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(published.mailedTo).toBeNull();
    expect(published.textedTo).toBe(2);
    expect(mailer.enqueueInTransaction).not.toHaveBeenCalled();
    expect(texter.enqueueInTransaction).toHaveBeenCalled();
  });

  it("writes its own ledger rows, its own audit entry and its own job", async () => {
    const { service, newsDelivery, texter, audit } = build();

    await service.publish("news-1", {
      published: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(newsDelivery.createMany).toHaveBeenCalledWith({
      data: [
        { newsId: "news-1", personId: "person-1", channel: "SMS" },
        { newsId: "news-1", personId: "person-2", channel: "SMS" },
      ],
    });
    expect(texter.enqueueInTransaction).toHaveBeenCalled();
    expect(audit.record.mock.calls.map((call) => call[0].action)).toEqual([
      "NEWS_PUBLISHED",
      "NEWS_TEXTED",
    ]);
  });

  it("claims both channels in one publish, each on its own condition", async () => {
    const { service, mailer, texter, audit } = build();

    const published = await service.publish("news-1", {
      published: true,
      sendEmail: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(published.mailedTo).toBe(2);
    expect(published.textedTo).toBe(2);
    expect(mailer.enqueueInTransaction).toHaveBeenCalled();
    expect(texter.enqueueInTransaction).toHaveBeenCalled();
    expect(audit.record.mock.calls.map((call) => call[0].action)).toEqual([
      "NEWS_PUBLISHED",
      "NEWS_EMAILED",
      "NEWS_TEXTED",
    ]);
  });

  it("is not offered again once the column carries a date", async () => {
    const { service, texter } = build({
      published: true,
      smsQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    const published = await service.publish("news-1", {
      published: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(published.textedTo).toBeNull();
    expect(texter.ensureQueues).not.toHaveBeenCalled();
    expect(texter.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it("refuses a rename once the address has been texted", async () => {
    // The link in a text message is the only copy of the address a member has,
    // and there is no sender to write back to.
    const { service } = build({
      published: true,
      smsQueuedAt: new Date("2026-09-01T09:00:00.000Z"),
    });

    await expect(
      service.update("news-1", {
        slug: "nya-tider",
        title: "Tvättstugan",
        content: paragraphsContent(["Nya tider."]),
      }),
    ).rejects.toMatchObject({ reason: "address-mailed" });
  });
});

describe("who a mailing goes to", () => {
  it("is the members with an address, and nobody else", async () => {
    const { service, person } = build();

    await service.publish("news-1", {
      published: true,
      sendEmail: true,
      actorPersonId: "board-1",
    });

    expect(person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailCipher: { not: null },
          residencies: {
            some: {
              role: "MEMBER",
              OR: [
                { movedOutOn: null },
                { movedOutOn: { gt: expect.any(Date) } },
              ],
            },
          },
        },
      }),
    );
  });

  it("is the members with a number when the channel is SMS", async () => {
    // A member the association holds no number for is left out of the snapshot
    // rather than written into it and failed: being unreachable one way is an
    // absence from that ledger, not a column of failures on the board's screen.
    const { service, person } = build();

    await service.publish("news-1", {
      published: true,
      sendSms: true,
      actorPersonId: "board-1",
    });

    expect(person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phoneCipher: { not: null } }),
      }),
    );
  });

  it("counts the two audiences separately", async () => {
    const { service, person } = build();
    person.count.mockResolvedValueOnce(40).mockResolvedValueOnce(12);

    expect(await service.recipientCounts()).toEqual({ email: 40, sms: 12 });
  });
});
