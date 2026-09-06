import { Inject, Injectable } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { ProcessorFacts } from "./processors";

/**
 * What this instance is configured to hand personal data to.
 *
 * One reader, used by both the record of processing and the processor
 * classification, so the two cannot disagree about what the instance does: the
 * record naming a mail server the classification screen has never heard of
 * would be two answers to one question.
 *
 * Read at the moment it is asked rather than cached. The settings change from
 * the settings screen and a plugin is installed from another, and a record
 * describing an instance as it was configured last week is worse than no
 * record: it would be a document the board is answerable for and did not write.
 */
@Injectable()
export class ProcessorFactsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async read(): Promise<ProcessorFacts> {
    const [association, plugins] = await Promise.all([
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: {
          smtpHost: true,
          smtpFromAddress: true,
          smsDriver: true,
          smsGatewayUrl: true,
        },
      }),
      this.prisma.installedPlugin.findMany({
        select: { id: true, packageName: true, version: true },
        orderBy: [{ id: "asc" }],
      }),
    ]);

    return {
      smtpHost: association?.smtpHost ?? null,
      smtpFromAddress: association?.smtpFromAddress ?? null,
      smsDriver: association?.smsDriver ?? null,
      smsGatewayUrl: association?.smsGatewayUrl ?? null,
      storageDriver: this.env.OPENBRF_STORAGE_DRIVER,
      s3Endpoint: this.env.OPENBRF_S3_ENDPOINT ?? null,
      /*
       * The region as configured, which is what the driver signs requests with
       * and not a claim about where the bucket is. The record prints it beside
       * the endpoint so the board can see what it is answering about; placing
       * the bucket is the board's own act.
       */
      s3Region: this.env.OPENBRF_S3_REGION,
      s3Bucket: this.env.OPENBRF_S3_BUCKET ?? null,
      installedPlugins: plugins,
    };
  }
}
