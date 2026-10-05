import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { DataProtectionSeedService } from "./data-protection-seed.service";
import type { ProcessingActivityService } from "./processing-activity.service";
import type { ProcessorAgreementService } from "./processor-agreement.service";
import type { ProcessorFactsService } from "./processor-facts.service";
import type { ProcessorFacts } from "./processors";

/**
 * Which seeds the boot hook runs, and on what. What each seed writes is
 * asserted against the database in the integration suite; this is the wiring.
 */

const t = ((key: string) => key) as unknown as TFunction;
const facts = { storageDriver: "local" } as ProcessorFacts;

function build(options: { setupCompletedAt: Date | null }) {
  const prisma = {
    association: {
      findUnique: vi.fn(async () => ({
        defaultLocale: "sv",
        setupCompletedAt: options.setupCompletedAt,
      })),
    },
  };
  const i18n = { translatorFor: vi.fn(() => t) };
  const processing = { seed: vi.fn(async () => undefined) };
  const agreements = { seed: vi.fn(async () => undefined) };
  const factsService = { read: vi.fn(async () => facts) };

  const service = new DataProtectionSeedService(
    { NODE_ENV: "production" } as Env,
    prisma as unknown as PrismaService,
    i18n as unknown as I18nService,
    processing as unknown as ProcessingActivityService,
    agreements as unknown as ProcessorAgreementService,
    factsService as unknown as ProcessorFactsService,
  );
  return { service, i18n, processing, agreements, factsService };
}

describe("DataProtectionSeedService", () => {
  it("classifies storage from the same facts the record of processing is written from", async () => {
    const { service, i18n, processing, agreements, factsService } = build({
      setupCompletedAt: new Date("2026-01-01"),
    });

    await service.seedIfConfigured();

    expect(i18n.translatorFor).toHaveBeenCalledWith("sv");
    // Read once, so the two records cannot describe two configurations.
    expect(factsService.read).toHaveBeenCalledTimes(1);
    expect(processing.seed).toHaveBeenCalledWith(t, facts);
    expect(agreements.seed).toHaveBeenCalledWith(facts, t);
  });

  it("seeds neither before setup has completed", async () => {
    const { service, processing, agreements } = build({
      setupCompletedAt: null,
    });

    await service.seedIfConfigured();

    expect(processing.seed).not.toHaveBeenCalled();
    expect(agreements.seed).not.toHaveBeenCalled();
  });

  it("logs a failed seed rather than stopping the instance from starting", async () => {
    const { service, agreements } = build({
      setupCompletedAt: new Date("2026-01-01"),
    });
    agreements.seed.mockRejectedValueOnce(new Error("no database"));

    await expect(service.seedIfConfigured()).resolves.toBeUndefined();
  });
});
