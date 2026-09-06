import { HttpStatus, Injectable } from "@nestjs/common";
import type { TFunction } from "i18next";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";
import { I18nService } from "../i18n/i18n.service";
import { readPageContent, type PageBlock } from "../site/page-content";
import {
  PRIVACY_NOTICE_SECTIONS,
  PRIVACY_NOTICE_SLUG,
  type PrivacyNoticeSection,
} from "../site/pages.service";
import type { Prisma } from "../generated/prisma/client";

export class PrivacyNoticeError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "notice-missing";

  constructor() {
    super("The association has no privacy notice page.");
  }
}

export interface PrivacyNoticeCoverage {
  /** Whether a notice page exists at all. */
  exists: boolean;
  /** Whether a visitor with no account can read it. */
  published: boolean;
  sections: { section: PrivacyNoticeSection; present: boolean }[];
  /** Whether the controller's contact details are on the page. */
  controllerContactBlock: boolean;
}

/**
 * Whether the association's privacy notice answers everything GDPR art. 13
 * requires, and the one way the product adds what is missing.
 *
 * The check is a check and not a rewrite. A notice is the association's own
 * account of how it processes personal data, written in its own words, and a
 * product that generated one would be putting words in a board's mouth that the
 * board is legally answerable for. So what this does is compare the headings on
 * the page against the fifteen art. 13 requires and name the ones that are not
 * there.
 *
 * ## What the append writes, and what it never touches
 *
 * Only the missing level-2 headings, and the controller contact block. Never a
 * word of text: the heading is the question, and the answer under it stays the
 * board's to write in the site editor. Every existing block is left byte for
 * byte as it was, which is what makes running this safe on a notice a board has
 * already spent an evening on.
 *
 * The board edits the notice in the site editor and nowhere else. This screen
 * asks a question about it and can add the headings it found missing; it is not
 * a second editor for the same page.
 */
@Injectable()
export class PrivacyNoticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly i18n: I18nService,
  ) {}

  /** Which art. 13 headings the notice carries, and which it does not. */
  async coverage(): Promise<PrivacyNoticeCoverage> {
    const page = await this.prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { content: true, published: true, visibility: true },
    });

    if (page === null) {
      return {
        exists: false,
        published: false,
        sections: PRIVACY_NOTICE_SECTIONS.map((section) => ({
          section,
          present: false,
        })),
        controllerContactBlock: false,
      };
    }

    const t = await this.translator();
    const blocks = readPageContent(page.content).blocks;
    const headings = new Set(
      blocks
        .filter((block) => block.type === "heading")
        .map((block) => headingText(block).trim().toLowerCase()),
    );

    return {
      exists: true,
      published: page.published && page.visibility === "PUBLIC",
      sections: PRIVACY_NOTICE_SECTIONS.map((section) => ({
        section,
        /*
         * Matched on the heading's own text in the association's language,
         * because that is what the board sees. A heading it has reworded reads
         * as missing, which is the honest answer: the check cannot tell a
         * rewritten heading from an absent one, and telling a board a question
         * is answered when the product cannot see the answer would be worse
         * than asking twice.
         */
        present: headings.has(
          t(`site.privacyNotice.sections.${section}`).trim().toLowerCase(),
        ),
      })),
      controllerContactBlock: blocks.some(
        (block) => block.type === "controllerContact",
      ),
    };
  }

  /**
   * Appends the missing headings and the controller contact block.
   *
   * Appended rather than inserted in the article's order, deliberately. The
   * board arranged this page; reordering it to match a list would move text the
   * board wrote under headings it did not intend, and a notice that reads oddly
   * is a great deal better than one that says something the board never wrote.
   */
  async appendMissing(actorPersonId: string): Promise<PrivacyNoticeCoverage> {
    const page = await this.prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { id: true },
    });
    if (page === null) {
      throw new PrivacyNoticeError();
    }

    const before = await this.coverage();
    const missing = before.sections
      .filter((section) => !section.present)
      .map((section) => section.section);

    if (missing.length === 0 && before.controllerContactBlock) {
      return before;
    }

    const t = await this.translator();
    const added: PageBlock[] = [
      ...missing.map((section): PageBlock => ({
        type: "heading",
        level: 2,
        runs: [{ text: t(`site.privacyNotice.sections.${section}`) }],
      })),
      ...(before.controllerContactBlock
        ? []
        : [{ type: "controllerContact" } as PageBlock]),
    ];

    await this.prisma.$transaction(async (tx) => {
      /*
       * Read again here, and this read is the one the write composes on. The
       * board edits this page in the site editor, and a save landing between
       * the read above and this write would otherwise be composed away: the
       * blocks it had just saved would be replaced by the older snapshot plus
       * the appended headings, with no error and nothing to recover from. The
       * page is the association's own art. 13 notice, so leaving every existing
       * block byte for byte as it was means reading it at the moment of the
       * write.
       */
      const current = await tx.page.findUniqueOrThrow({
        where: { id: page.id },
        select: { content: true },
      });
      const existing = readPageContent(current.content);

      await tx.page.update({
        where: { id: page.id },
        data: {
          content: {
            ...existing,
            // Every block the board wrote, unchanged and in its order.
            blocks: [...existing.blocks, ...added],
          } as unknown as Prisma.InputJsonObject,
        },
      });

      await this.audit.record(
        {
          action: "PRIVACY_NOTICE_HEADINGS_ADDED",
          actorPersonId,
          targetKind: "page",
          targetId: page.id,
          // Which questions were added, never the text under them: there is
          // none yet, and the board's own words never enter the log.
          context: {
            sections: missing,
            controllerContactBlock: !before.controllerContactBlock,
          },
        },
        tx,
      );
    });

    return this.coverage();
  }

  /** The association's own language: the notice is one document. */
  private async translator(): Promise<TFunction> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    return this.i18n.translatorFor(association?.defaultLocale);
  }
}

/** The text of a heading block, however its runs are split. */
function headingText(block: PageBlock): string {
  if (block.type !== "heading") {
    return "";
  }
  return block.runs.map((run) => run.text).join("");
}
