import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { ProcessingActivityService } from "./processing-activity.service";
import type { ProcessorFactsService } from "./processor-facts.service";

const SENTINEL_ADDRESS = "sentinel.person@example.se";
const SENTINEL_TEXT = "Storgatan 12 lgh 1103, free text out of a row";

/** A seeded row the board has edited: the one kind the comparison is for. */
const EDITED_ROW = {
  id: "activity-key-orders",
  name: "Nyckelbeställningar",
  purpose: "Hantera beställningar av nycklar och taggar.",
  legalBasis: "CONTRACT",
  legalBasisNote: null,
  dataSubjectCategories: ["member"],
  personalDataCategories: ["name", "apartment"],
  recipients: null,
  thirdCountryTransfer: false,
  thirdCountrySafeguards: null,
  retention: "Tills nyckeln lämnas tillbaka, enligt styrelsen.",
  securityMeasures: null,
  source: "SERVICE_DATA",
  sourceKey: "keyOrders",
  endedAt: null,
  recordedByPersonId: null,
  updatedByPersonId: "person-board",
  revision: 3,
};

/** A row the board recorded itself: there is no product text to compare. */
const RECORDED_ROW = {
  ...EDITED_ROW,
  id: "activity-board-recorded",
  name: "Styrelsens egen behandling",
  source: "BOARD",
  sourceKey: null,
  recordedByPersonId: "person-board",
  revision: 1,
};

/** A configuration that cannot be read, with personal data in its message. */
function failingFacts() {
  return {
    read: vi
      .fn()
      .mockRejectedValue(
        new TypeError(`rejected ${SENTINEL_ADDRESS}: ${SENTINEL_TEXT}`),
      ),
  };
}

describe("ProcessingActivityService.read", () => {
  it("shows the record without a comparison when the product's wording cannot be read, says so on the edited rows, and logs no message", async () => {
    const prisma = {
      association: { findUnique: vi.fn().mockResolvedValue(null) },
      processingActivity: {
        findMany: vi.fn().mockResolvedValue([EDITED_ROW, RECORDED_ROW]),
      },
    };
    const facts = failingFacts();
    const service = new ProcessingActivityService(
      prisma as unknown as PrismaService,
      {} as AuditLogService,
      {} as I18nService,
      facts as unknown as ProcessorFactsService,
    );
    const warned = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    try {
      const record = await service.read();

      // The stored rows stand as they are, only without a comparison. The
      // edited row says it could not be compared rather than that it agrees;
      // the board's own row had nothing to compare against either way.
      expect(record.activities).toEqual([
        expect.objectContaining({
          activityId: EDITED_ROW.id,
          name: EDITED_ROW.name,
          retention: EDITED_ROW.retention,
          revision: EDITED_ROW.revision,
          seeded: false,
          productDiffers: false,
          productText: {},
          productTextUnavailable: true,
        }),
        expect.objectContaining({
          activityId: RECORDED_ROW.id,
          productDiffers: false,
          productText: {},
          productTextUnavailable: false,
        }),
      ]);
      expect(warned).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warned.mock.calls);
      expect(logged).toContain("TypeError");
      expect(logged).not.toContain(SENTINEL_ADDRESS);
      expect(logged).not.toContain(SENTINEL_TEXT);
    } finally {
      warned.mockRestore();
    }
  });
});

describe("ProcessingActivityService.end", () => {
  it("keeps an ending that committed when the comparison fails afterwards", async () => {
    const ended = { ...EDITED_ROW, endedAt: new Date(), revision: 4 };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      processingActivity: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: EDITED_ROW.id, endedAt: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(ended),
      },
    };
    const committed = vi.fn();
    const prisma = {
      association: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => {
        const result = await work(tx);
        committed();
        return result;
      }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const facts = failingFacts();
    const service = new ProcessingActivityService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      {} as I18nService,
      facts as unknown as ProcessorFactsService,
    );
    const warned = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    try {
      const view = await service.end(EDITED_ROW.id, "person-board");

      // The comparison was attempted after the transaction committed, not
      // inside it, so its failure had nothing to roll back.
      expect(committed).toHaveBeenCalledTimes(1);
      expect(facts.read).toHaveBeenCalledTimes(1);
      expect(facts.read.mock.invocationCallOrder[0]).toBeGreaterThan(
        committed.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(view).toEqual(
        expect.objectContaining({
          activityId: EDITED_ROW.id,
          revision: 4,
          productDiffers: false,
          productText: {},
          productTextUnavailable: true,
        }),
      );
      expect(JSON.stringify(warned.mock.calls)).not.toContain(SENTINEL_TEXT);
    } finally {
      warned.mockRestore();
    }
  });
});
