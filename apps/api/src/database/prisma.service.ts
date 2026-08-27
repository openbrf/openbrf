import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";

/**
 * The database client.
 *
 * Prisma 7 has no built-in connection handling: it takes a driver adapter, so
 * the connection string is resolved here rather than in the schema.
 *
 * In production the application connects as a non-owner role
 * (DATABASE_URL_RUNTIME) that holds no UPDATE or DELETE on the statutory
 * archive tables. That is what makes the append-only guards unbypassable
 * rather than merely inconvenient: a table owner can disable a trigger, so the
 * application must not be the owner. See prisma/sql/harden-runtime-role.sql.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    const connectionString = env.DATABASE_URL_RUNTIME ?? env.DATABASE_URL;
    super({ adapter: new PrismaPg({ connectionString }) });

    if (
      env.NODE_ENV === "production" &&
      env.DATABASE_URL_RUNTIME === undefined
    ) {
      PrismaService.logger.warn(
        "DATABASE_URL_RUNTIME is not set, so the application connects as the " +
          "schema owner. The statutory archive triggers can be disabled by " +
          "the owner: apply prisma/sql/harden-runtime-role.sql and set " +
          "DATABASE_URL_RUNTIME to close that gap.",
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
