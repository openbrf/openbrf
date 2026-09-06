import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { ProcessingActivityService } from "./processing-activity.service";
import { ProcessorFactsService } from "./processor-facts.service";

/**
 * Writes the record of processing activities from what the instance knows about
 * itself, at boot and after setup completes.
 *
 * At boot rather than only at setup, because an instance that was configured
 * before this existed has a record to write too - and because the fact-derived
 * fields follow the settings, so a board that changed its storage driver last
 * week should find the record saying so this morning.
 *
 * Only once setup has completed. Before that the association row is a shell:
 * seeding then would write a record naming a cooperative with no name, in
 * whatever language the schema defaults to, and the board's first sight of its
 * own art. 30 record would be that.
 *
 * A failure here is logged and swallowed. The record is important and the
 * instance starting is more so: a cooperative that cannot sign in because a
 * background write failed has a worse problem than an unseeded record, and the
 * next start retries it.
 */
@Injectable()
export class DataProtectionSeedService implements OnModuleInit {
  private readonly logger = new Logger(DataProtectionSeedService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly processing: ProcessingActivityService,
    private readonly facts: ProcessorFactsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests seed on their own terms, so a boot hook must not
      // write rows underneath a suite that is counting them.
      return;
    }
    await this.seedIfConfigured();
  }

  /** Seeds the record where the instance has been set up. Public for setup. */
  async seedIfConfigured(): Promise<void> {
    try {
      const association = await this.prisma.association.findUnique({
        where: { id: 1 },
        select: { defaultLocale: true, setupCompletedAt: true },
      });
      if (association?.setupCompletedAt == null) {
        return;
      }

      await this.processing.seed(
        /*
         * The association's own language, not a reader's. The record is one
         * document the board keeps, and a row that changed language depending
         * on who opened the screen would not be one.
         */
        this.i18n.translatorFor(association.defaultLocale),
        await this.facts.read(),
      );
    } catch (cause) {
      this.logger.error(
        "The record of processing activities could not be written. It is " +
          "retried on the next start.",
        cause instanceof Error ? cause.stack : undefined,
      );
    }
  }
}
