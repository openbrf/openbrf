import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { ProcessingActivityService } from "./processing-activity.service";
import type { ProcessorFactsService } from "./processor-facts.service";

const SENTINEL_ADDRESS = "sentinel.person@example.se";
const SENTINEL_TEXT = "Storgatan 12 lgh 1103, free text out of a row";

describe("ProcessingActivityService.read", () => {
  it("shows the record without a comparison when the product's wording cannot be read, and logs no message", async () => {
    const prisma = {
      association: { findUnique: vi.fn().mockResolvedValue(null) },
      processingActivity: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const facts = {
      read: vi
        .fn()
        .mockRejectedValue(
          new TypeError(`rejected ${SENTINEL_ADDRESS}: ${SENTINEL_TEXT}`),
        ),
    };
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

      expect(record.activities).toEqual([]);
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
