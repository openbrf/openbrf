import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import {
  BASE_URL_VARIABLE,
  maintenanceUrl,
  quoteIdentifier,
  templateDatabaseName,
  withDatabase,
  workerDatabaseName,
} from "./integration-database";

export interface ApplicationOnOwnDatabase {
  app: NestFastifyApplication;
  prisma: PrismaService;
  /** Closes the application and drops its database. */
  close: () => Promise<void>;
}

/**
 * The application, on a database of its own cloned from the migrated template:
 * no account, no association, nothing any other suite wrote.
 *
 * For a state a worker's shared database cannot be put in without undoing what
 * the suites before it wrote - an unclaimed instance, a board register with
 * no seat on it. Emptying a table other suites filled is not something a test
 * should do to any database, so the suite gets one where the table was never
 * filled.
 *
 * ConfigModule reads process.env while the module compiles, so the database
 * variables and `environment` are set for that moment and put back straight
 * after. A value of `""` stands for "unset": the environment file is loaded
 * again while the module compiles and fills in only what is unset, and the
 * schema reads an empty value as absent.
 *
 * @param label names the database beside the worker's own, so two suites, or
 * two cases in one suite, never share one.
 */
export async function applicationOnOwnDatabase(
  label: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ApplicationOnOwnDatabase> {
  const baseUrl = process.env[BASE_URL_VARIABLE];
  if (baseUrl === undefined) {
    throw new Error(
      `${BASE_URL_VARIABLE} is not set: the worker's setup file did not run`,
    );
  }
  const poolId = Number(process.env.VITEST_POOL_ID ?? "1");
  const database = `${workerDatabaseName(baseUrl, poolId)}_${label}`;

  const maintenance = new Client({ connectionString: maintenanceUrl(baseUrl) });
  await maintenance.connect();
  try {
    await maintenance.query(
      `drop database if exists ${quoteIdentifier(database)} with (force)`,
    );
    await maintenance.query(
      `create database ${quoteIdentifier(database)} template ${quoteIdentifier(
        templateDatabaseName(baseUrl),
      )}`,
    );
  } finally {
    await maintenance.end();
  }

  const overridden = ["DATABASE_URL", "DATABASE_URL_RUNTIME"].concat(
    Object.keys(environment),
  );
  const saved = Object.fromEntries(
    overridden.map((name) => [name, process.env[name]]),
  );
  process.env.DATABASE_URL = withDatabase(baseUrl, database);
  const runtimeUrl = saved.DATABASE_URL_RUNTIME;
  if (runtimeUrl !== undefined && runtimeUrl !== "") {
    process.env.DATABASE_URL_RUNTIME = withDatabase(runtimeUrl, database);
  }
  Object.assign(process.env, environment);

  let built: NestFastifyApplication;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    built = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await built.init();
    await built.getHttpAdapter().getInstance().ready();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }

  return {
    app: built,
    prisma: built.get(PrismaService),
    close: async () => {
      await built.close();
      const dropping = new Client({
        connectionString: maintenanceUrl(baseUrl),
      });
      await dropping.connect();
      try {
        await dropping.query(
          `drop database if exists ${quoteIdentifier(database)} with (force)`,
        );
      } finally {
        await dropping.end();
      }
    },
  };
}
