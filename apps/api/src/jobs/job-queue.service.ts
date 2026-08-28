import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PgBoss } from "pg-boss";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";

/**
 * Schema pg-boss keeps its tables in. Separate from the application schema so
 * the queue never collides with a migration, and so privileges can be granted
 * independently (see prisma/sql/harden-runtime-role.sql).
 */
export const JOB_SCHEMA = "pgboss";

/** Queue pool size. One association generates very little job traffic. */
const JOB_POOL_SIZE = 2;

export type JobHandler<Data extends object> = (
  data: Data,
) => Promise<void> | void;

/**
 * Background job queue, backed by PostgreSQL through pg-boss.
 *
 * The queue keeps a small connection pool of its own rather than sharing
 * Prisma's. Sharing was tried first, via pg-boss's `fromPrisma` adapter, and
 * it does not work against Prisma 7: pg-boss checks whether its schema is
 * installed with a query that returns a `regclass` column, and Prisma's raw
 * query interface cannot deserialize that type, so `start()` throws before the
 * queue exists. The dedicated pool is the supported configuration, and it also
 * buys back LISTEN/NOTIFY wakeups instead of polling. It is capped low because
 * one association is 20 to 200 households.
 *
 * Schema installation is not done by the running application in production.
 * The application role deliberately holds no CREATE privilege, so the pgboss
 * schema is installed at deploy time by the owner and the app starts with
 * migrate disabled.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly boss: PgBoss;
  private readonly ensuredQueues = new Set<string>();
  private started = false;
  /** Held while a start is in flight, so parallel callers await the same one. */
  private starting: Promise<void> | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {
    const isProduction = env.NODE_ENV === "production";
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL_RUNTIME ?? env.DATABASE_URL,
      max: JOB_POOL_SIZE,
      application_name: "openbrf-jobs",
      schema: JOB_SCHEMA,
      // In production the schema is installed by the owner at deploy time; the
      // app role cannot create it and must not try.
      migrate: !isProduction,
    });

    this.boss.on("error", (error) => {
      // An unhandled queue error must never take the API down: the address
      // book has to keep working even when a job backend hiccups.
      this.logger.error("Job queue error", error);
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive jobs explicitly rather than having a worker
      // race them.
      return;
    }
    await this.start();
  }

  /**
   * Starts the queue backend, once per process whoever asks first.
   *
   * The promise is memoized rather than a boolean checked before an await:
   * ensureQueue calls start(), several feature modules call ensureQueue, and
   * two of those overlapping would both see `started === false` and start
   * pg-boss twice.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.starting ??= (async () => {
      await this.boss.start();
      this.started = true;
      this.logger.log(`Job queue started (schema "${JOB_SCHEMA}")`);
    })();

    try {
      await this.starting;
    } catch (error) {
      // A failed start must not leave a rejected promise behind for every
      // later caller to await: the next one tries again.
      this.starting = null;
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.started) {
      return;
    }
    // Let in-flight jobs finish rather than abandoning them mid-write; the
    // plugin installer in particular must not be interrupted between its
    // staging and commit steps.
    await this.boss.stop({ graceful: true });
    this.started = false;
    this.starting = null;
  }

  /**
   * Creates the queue if it does not exist. pg-boss requires a queue to exist
   * before a job is sent to it, and doing this lazily keeps each feature
   * module owning its own queue name.
   */
  async ensureQueue(name: string): Promise<void> {
    if (this.ensuredQueues.has(name)) {
      return;
    }
    // Starting here rather than only at boot, because onModuleInit does not
    // start the queue under test: a move-out entered in an integration test
    // still has to leave its board reminder in the queue, and a job silently
    // dropped because nothing had started the backend is the kind of gap a
    // green suite would hide. start() is idempotent for parallel callers as
    // well as sequential ones, and registering a worker is still an explicit
    // act, so nothing races a job under test.
    await this.start();
    await this.boss.createQueue(name);
    this.ensuredQueues.add(name);
  }

  /** Enqueues a job for immediate processing. */
  async send<Data extends object>(name: string, data: Data): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.send(name, data);
  }

  /**
   * Enqueues a job to run at a given time. Used for date-triggered work such
   * as the board's move-out reminder, which fires on the move-out date rather
   * than when the date was entered.
   */
  async sendAt<Data extends object>(
    name: string,
    data: Data,
    runAt: Date,
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.sendAfter(name, data, null, runAt);
  }

  /** Registers a worker for a queue. */
  async work<Data extends object>(
    name: string,
    handler: JobHandler<Data>,
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.work<Data>(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  /** Registers a recurring job on a cron expression. */
  async schedule<Data extends object>(
    name: string,
    cron: string,
    data: Data,
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.schedule(name, cron, data);
  }

  /** Escape hatch for advanced pg-boss usage; prefer the methods above. */
  get instance(): PgBoss {
    return this.boss;
  }
}
