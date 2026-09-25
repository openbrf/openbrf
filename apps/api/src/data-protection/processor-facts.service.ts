import { Inject, Injectable } from "@nestjs/common";

import { boardMailboxConfigured } from "../board-mailbox/board-mailbox-settings";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { connectedAppHost, type ProcessorFacts } from "./processors";

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
    const [association, plugins, connectedApps, unencryptedStoredFiles] =
      await Promise.all([
        this.prisma.association.findUnique({
          where: { id: 1 },
          select: {
            smtpHost: true,
            smtpFromAddress: true,
            smsDriver: true,
            smsGatewayUrl: true,
            boardMailboxAddress: true,
            boardMailboxPop3Host: true,
            boardMailboxPop3User: true,
            // Only to tell whether a password is set. It is never decrypted
            // here: the record names the mailbox, not what opens it.
            boardMailboxPop3PasswordCipher: true,
          },
        }),
        this.prisma.installedPlugin.findMany({
          select: { id: true, packageName: true, version: true },
          orderBy: [{ id: "asc" }],
        }),
        /*
         * Only the clients somebody has actually allowed to act. A client row is
         * written as soon as an app presents its metadata document, and a
         * registration hands nobody anything: a row asking the board to classify
         * an app no member has connected would be a false entry in the art. 28
         * record, the way a gateway on an instance with no SMS provider would be.
         *
         * One row per client rather than per consent: an app forty households
         * connected is one recipient.
         */
        this.prisma.oauthClient.findMany({
          where: { consents: { some: {} } },
          select: {
            id: true,
            name: true,
            clientDiscoveryId: true,
            uri: true,
          },
          orderBy: [{ id: "asc" }],
        }),
        this.prisma.mediaFile.count({
          where: {
            OR: [
              { encryption: "NONE" },
              { unencryptedStorageKey: { not: null } },
            ],
          },
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
      connectedApps: connectedApps.map((client) => ({
        id: client.id,
        name: client.name,
        host: connectedAppHost(client),
      })),
      unencryptedStoredFiles,
      mailbox:
        association !== null && boardMailboxConfigured(association)
          ? {
              host: association.boardMailboxPop3Host,
              address: association.boardMailboxAddress,
            }
          : null,
    };
  }
}
