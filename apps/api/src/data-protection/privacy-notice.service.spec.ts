import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { PRIVACY_NOTICE_SECTIONS } from "../site/pages.service";
import {
  PrivacyNoticeError,
  PrivacyNoticeService,
} from "./privacy-notice.service";

/**
 * The append against a board member saving the same page at the same moment.
 *
 * Asserted here rather than through HTTP because the window is between two
 * statements inside one transaction, which a request from outside cannot be
 * made to land in. What the fakes stand in for is the claim losing: the write
 * is matched on the revision it composed on, so a save that committed in
 * between leaves it matching nothing.
 */

/** The heading text is the translation key, so a test can write one by name. */
const t = ((key: string) => key) as unknown as TFunction;

function heading(section: (typeof PRIVACY_NOTICE_SECTIONS)[number]) {
  return {
    type: "heading",
    level: 2,
    runs: [{ text: `site.privacyNotice.sections.${section}` }],
  };
}

function paragraph(text: string) {
  return { type: "paragraph", runs: [{ text }] };
}

interface Read {
  content: { version: 1; blocks: unknown[] };
  revision: number;
}

function build(options: { reads: Read[]; claims: number[] }) {
  const reads = [...options.reads];
  const claims = [...options.claims];

  const tx = {
    page: {
      findUniqueOrThrow: vi.fn(
        async () => reads.shift() ?? options.reads.at(-1),
      ),
      updateMany: vi.fn(async () => ({ count: claims.shift() ?? 0 })),
    },
  };
  const prisma = {
    page: {
      // The lookup by slug and the coverage read afterwards both land here.
      findUnique: vi.fn(async () => ({
        id: "page-1",
        content: options.reads.at(-1)?.content ?? { version: 1, blocks: [] },
        published: true,
        visibility: "PUBLIC",
      })),
    },
    association: {
      findUnique: vi.fn(async () => ({ defaultLocale: "sv" })),
    },
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const i18n = { translatorFor: vi.fn(() => t) };

  return {
    service: new PrivacyNoticeService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      i18n as unknown as I18nService,
    ),
    tx,
    audit,
  };
}

describe("appending the missing headings", () => {
  it("composes on the page as a board member's save left it, not on the read it lost to", async () => {
    /*
     * The first read is the page before the board saved; the claim on it
     * matches nothing because the save moved the revision. The second read is
     * the page as the save left it - a paragraph of the board's own, and the
     * controller heading the board wrote itself. The write that lands has to
     * keep both, and must not append the controller heading a second time.
     */
    const { service, tx, audit } = build({
      reads: [
        {
          content: { version: 1, blocks: [paragraph("Ingress.")] },
          revision: 4,
        },
        {
          content: {
            version: 1,
            blocks: [
              paragraph("Ingress."),
              heading("controller"),
              paragraph("Styrelsens nya text."),
            ],
          },
          revision: 5,
        },
      ],
      claims: [0, 1],
    });

    await service.appendMissing("person-1");

    expect(tx.page.updateMany).toHaveBeenCalledTimes(2);
    const [, second] = tx.page.updateMany.mock.calls as unknown as [
      unknown,
      [
        {
          where: { id: string; revision: number };
          data: { content: { blocks: { runs?: { text: string }[] }[] } };
        },
      ],
    ];
    const write = second[0];
    // Claimed on the revision the second read returned.
    expect(write.where).toEqual({ id: "page-1", revision: 5 });

    const blocks = write.data.content.blocks;
    // The board's three blocks, first and unchanged.
    expect(blocks.slice(0, 3)).toEqual([
      paragraph("Ingress."),
      heading("controller"),
      paragraph("Styrelsens nya text."),
    ]);
    // And the heading the board had already written is not appended again.
    const controllerHeadings = blocks.filter(
      (block) =>
        block.runs?.[0]?.text === "site.privacyNotice.sections.controller",
    );
    expect(controllerHeadings).toHaveLength(1);

    // One entry, for the write that landed, naming what that write added.
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0] as unknown as [
      { context: { sections: string[] } },
    ];
    expect(entry.context.sections).not.toContain("controller");
  });

  it("writes nothing when the board has added every heading in the meantime", async () => {
    const { service, tx, audit } = build({
      reads: [
        {
          content: {
            version: 1,
            blocks: [
              ...PRIVACY_NOTICE_SECTIONS.map((section) => heading(section)),
              { type: "controllerContact" },
            ],
          },
          revision: 5,
        },
      ],
      claims: [],
    });

    await service.appendMissing("person-1");

    expect(tx.page.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("gives up with a conflict rather than spinning while somebody keeps saving", async () => {
    const { service, tx, audit } = build({
      reads: [{ content: { version: 1, blocks: [] }, revision: 4 }],
      claims: [0, 0, 0],
    });

    const refusal = await service.appendMissing("person-1").then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PrivacyNoticeError);
    expect((refusal as PrivacyNoticeError).reason).toBe("notice-changed");
    expect((refusal as PrivacyNoticeError).status).toBe(409);
    expect(tx.page.updateMany).toHaveBeenCalledTimes(3);
    // Nothing landed, so nothing is recorded as having been added.
    expect(audit.record).not.toHaveBeenCalled();
  });
});
