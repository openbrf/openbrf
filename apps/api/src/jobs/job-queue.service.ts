import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PgBoss } from "pg-boss";

import { ENV } from "../config/config.module";
import { applicationDatabaseUrl, type Env } from "../config/env";

/**
 * Schema pg-boss keeps its tables in. Separate from the application schema so
 * the queue never collides with a migration, and so privileges can be granted
 * independently (see prisma/sql/harden-runtime-role.sql).
 */
export const JOB_SCHEMA = "pgboss";

/** Queue pool size. One association generates very little job traffic. */
const JOB_POOL_SIZE = 2;

/** Queues read at a time, the most pg-boss hands out by default. */
const QUEUE_PAGE_SIZE = 1000;

/**
 * pg-boss's own queue, which a cron schedule's due occurrences wait on until a
 * worker sends each to the schedule's queue (see {@link
 * JobQueueService.deleteQueuesUnder}).
 */
const FORWARD_QUEUE = "__pgboss__send-it";

/**
 * How long a deletion waits for an occurrence a worker is sending. Sending one
 * is a single insert, so one that takes longer has a worker that stopped, and
 * pg-boss hands it out again only once it expires.
 */
const FORWARD_DRAIN_MS = 10_000;

/** Between two reads of the occurrences still to be sent. */
const FORWARD_POLL_MS = 100;

/**
 * The key a cron schedule's data is kept under, beside the queue it was made
 * for: see {@link JobQueueService.schedule}. Named so that no data a caller
 * schedules is likely to carry it.
 */
const SCHEDULED_FOR = "openbrf:scheduledFor";

/** A cron schedule's data, with the queue it was made for. */
interface Scheduled<Data> {
  [SCHEDULED_FOR]: string;
  data: Data;
}

/** The data of a job a cron schedule sent, or null for any other job. */
function scheduledOf<Data>(data: unknown): Scheduled<Data> | null {
  if (typeof data !== "object" || data === null || !("data" in data)) {
    return null;
  }
  return typeof (data as Record<string, unknown>)[SCHEDULED_FOR] === "string"
    ? (data as Scheduled<Data>)
    : null;
}

/**
 * The prefix every queue of one plugin is named under: the queues it names
 * through `host.jobs`, and the one its finance events wait on.
 *
 * A plugin id is lower-case letters, digits and `_`, so no id is another's
 * prefix once the `/` closes it, and removing one plugin's queues by prefix
 * never reaches another's.
 */
export function pluginQueuePrefix(pluginId: string): string {
  return `plugin/${pluginId}/`;
}

export type JobHandler<Data extends object> = (
  data: Data,
) => Promise<void> | void;

/**
 * How a job behaves when it fails or outlives its worker.
 *
 * A narrow subset of what the queue backend accepts, declared here so a feature
 * module states its retry policy without reaching into pg-boss's own types.
 */
export interface JobSendOptions {
  /** Attempts after the first before the job is given up on. */
  retryLimit?: number;
  /** Seconds before the first retry. */
  retryDelay?: number;
  /** Whether each retry waits longer than the one before it. */
  retryBackoff?: boolean;
  /** Seconds a job may run before the queue decides its worker is gone. */
  expireInSeconds?: number;
  /** Queue a job lands on once its retries are spent. */
  deadLetter?: string;
}

/**
 * The part of an open database transaction a job insert needs.
 *
 * Structural rather than Prisma's own client type: what the queue asks for is
 * somewhere to run one statement, and saying so keeps the jobs module from
 * depending on the shape of the ORM.
 */
export interface TransactionalSql {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * A transaction, in the terms the queue backend takes a connection in.
 *
 * pg-boss will insert the job through whatever runs the statement, so handing
 * it the caller's transaction is what makes the job commit with the rows that
 * decided to send it.
 */
function transactionalDb(tx: TransactionalSql) {
  return {
    executeSql: async (
      text: string,
      values?: unknown[],
    ): Promise<{ rows: unknown[] }> => ({
      rows: await tx.$queryRawUnsafe<unknown[]>(text, ...(values ?? [])),
    }),
  };
}

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
      connectionString: applicationDatabaseUrl(env),
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
    // A start still in flight is drained before the flag is read. `started` is
    // set by start()'s own continuation, so a shutdown arriving while
    // boss.start() is awaited would see it false, return, and leave a backend
    // that finishes starting a moment later with nothing to stop it: connections
    // held and a worker polling for jobs in a process that has closed. A start
    // that failed is not this method's to report - its caller already has the
    // rejection - and it leaves nothing running to stop.
    await this.starting?.catch(() => undefined);

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

  /**
   * Enqueues a job for immediate processing.
   *
   * Answers the job's id, or null where the backend declined to create one.
   */
  async send<Data extends object>(
    name: string,
    data: Data,
    options?: JobSendOptions,
  ): Promise<string | null> {
    await this.ensureQueue(name);
    if (options?.deadLetter !== undefined) {
      // pg-boss requires the queue a job is dead-lettered to, exactly as it
      // requires the queue the job itself goes on.
      await this.ensureQueue(options.deadLetter);
    }
    return this.boss.send(name, data, options ?? {});
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
    options?: JobSendOptions,
  ): Promise<void> {
    await this.ensureQueue(name);
    if (options?.deadLetter !== undefined) {
      await this.ensureQueue(options.deadLetter);
    }
    await this.boss.sendAfter(name, data, options ?? null, runAt);
  }

  /**
   * Enqueues a job inside a caller's transaction.
   *
   * The job row is written by that transaction, so it commits with the rows
   * that decided to send it or with neither. The alternative - sending after
   * the commit - has no way back when it fails: the rows are written, some of
   * them into registers that refuse to be edited or deleted, and the work the
   * job was going to do is simply lost. That is the difference between "the
   * move-out is recorded" and "the move-out is recorded and the board will be
   * reminded of it".
   *
   * The queue must already exist: `ensureQueue` talks to the database on its
   * own connection, and calling it here would put a queue's creation inside
   * somebody else's transaction. Callers await it before they open one.
   */
  async sendInTransaction<Data extends object>(
    tx: TransactionalSql,
    name: string,
    data: Data,
    options?: JobSendOptions,
  ): Promise<void> {
    await this.boss.send(name, data, {
      ...options,
      db: transactionalDb(tx),
    });
  }

  /**
   * {@link sendInTransaction}, for a job with a time to run at: a date, or a
   * number of seconds after the time the database gives the transaction.
   *
   * Seconds are counted on the database's clock, the one the queue decides by
   * when a job is due, so a caller that records the same moment in the same
   * transaction - `now()` plus those seconds - records exactly when the job
   * becomes due, whatever the instance's own clock says.
   *
   * A dead-letter queue has to exist already, like the queue itself: it would
   * otherwise be created here, inside the caller's transaction.
   */
  async sendAtInTransaction<Data extends object>(
    tx: TransactionalSql,
    name: string,
    data: Data,
    runAt: Date | number,
    options?: JobSendOptions,
  ): Promise<void> {
    const sendOptions = { ...options, db: transactionalDb(tx) };
    // Apart because pg-boss declares each form as an overload of its own.
    if (typeof runAt === "number") {
      await this.boss.sendAfter(name, data, sendOptions, runAt);
    } else {
      await this.boss.sendAfter(name, data, sendOptions, runAt);
    }
  }

  /**
   * Registers a worker for a queue.
   *
   * A job a cron schedule sent reaches the handler only where the schedule
   * was made for the queue as it is now, rather than for one deleted before
   * it under the same name: see {@link schedule}. Any other is completed
   * without it.
   */
  async work<Data extends object>(
    name: string,
    handler: JobHandler<Data>,
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.work<Data | Scheduled<Data>>(name, async (jobs) => {
      // Read once a batch, only for a batch holding a scheduled job, and
      // before any handler runs: a read that fails then fails the batch with
      // none of it done, rather than having it run again.
      const current = jobs.some((job) => scheduledOf(job.data) !== null)
        ? await this.queueGeneration(name)
        : null;
      let dropped = 0;
      for (const job of jobs) {
        const scheduled = scheduledOf<Data>(job.data);
        if (scheduled === null) {
          await handler(job.data as Data);
          continue;
        }
        if (scheduled[SCHEDULED_FOR] !== current) {
          dropped += 1;
          continue;
        }
        await handler(scheduled.data);
      }
      if (dropped > 0) {
        // The queue is left unnamed: a plugin names its own part of it.
        this.logger.warn(
          `Completed ${dropped} job(s) without running them: a cron schedule ` +
            "made for a queue deleted before theirs sent them.",
        );
      }
    });
  }

  /**
   * Registers a recurring job on a cron expression.
   *
   * The data is kept with the queue it was scheduled for, told apart from any
   * other queue ever made under the name by when it was made. pg-boss sends a
   * schedule's occurrence in two steps (see {@link cancelForwardsUnder}), and
   * a cron pass that read the schedule before its queue was deleted can still
   * put the occurrence on after, in this process or in any other, where no
   * deletion can see or wait for it. Sent on once the next queue under the
   * name exists, it is completed there without reaching the handler, because
   * the queue it was scheduled for is gone: that is what {@link work} checks.
   *
   * A schedule goes with its queue, so the jobs of one made since the queue
   * was always run. They would not only where the queue were deleted and
   * made again between the read below and the schedule's write, and the
   * queues deleted are those of a plugin that is not installed, so none of
   * its schedules is being made then.
   *
   * Data a schedule was given before schedules kept their queue reaches the
   * handler as it is: there is no queue to tell it by. Scheduling again under
   * the same name, as the core's own purges and collections do at every
   * start, gives it its queue from then on.
   */
  async schedule<Data extends object>(
    name: string,
    cron: string,
    data: Data,
  ): Promise<void> {
    await this.ensureQueue(name);
    let generation = await this.queueGeneration(name);
    if (generation === null) {
      // Deleted since this process created it, by a removal in another
      // process, so this one's cache still has it: created again.
      this.ensuredQueues.delete(name);
      await this.ensureQueue(name);
      generation = await this.queueGeneration(name);
    }
    if (generation === null) {
      throw new Error("A job queue was deleted while it was being scheduled.");
    }
    const scheduled: Scheduled<Data> = { [SCHEDULED_FOR]: generation, data };
    await this.boss.schedule(name, cron, scheduled);
  }

  /**
   * When the queue under a name was made, to the microsecond, or null where
   * there is none: what tells it from a queue deleted before it under the same
   * name.
   */
  private async queueGeneration(name: string): Promise<string | null> {
    const { rows } = await this.boss.getDb().executeSql(
      `SELECT to_char(created_on AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation
       FROM ${JOB_SCHEMA}.queue WHERE name = $1`,
      [name],
    );
    return (rows as { generation?: string }[])[0]?.generation ?? null;
  }

  /**
   * Deletes every queue whose name starts with `prefix`: the jobs waiting on
   * it, its cron schedules and their occurrences not yet sent to it, and this
   * process's workers on it. Rejects unless a fresh read finds no such queue
   * and no such occurrence waiting or being sent. An occurrence a cron pass
   * puts on later, from a schedule it read before the deletion, never reaches
   * a handler on a queue made under the same name since: see {@link schedule}.
   *
   * For a plugin that was removed, whose queues would otherwise be inherited
   * by the next package installed under its id: the jobs the old package sent
   * itself and the schedules that go on sending them.
   *
   * Every step is one the runtime role holds. A queue is a row in
   * pgboss.queue and its jobs are rows in the shared job table, because the
   * job schema install refuses a queue with a table of its own for every role
   * (scripts/install-job-schema.mjs); deleting the queue row takes its
   * schedules with it, by the schedule table's foreign key. The occurrences
   * not yet sent are rows of the same job table, deleted by a statement of
   * this service's own, since pg-boss deletes jobs only by queue or by id;
   * the counts pg-boss keeps on its own queue catch up at its next monitor
   * pass.
   *
   * The workers are stopped without waiting for a handler that is running. A
   * removed plugin's handler stays in this process until the restart, and one
   * that never returns would otherwise hold its removal; what it does after
   * this, the host services it was given refuse.
   */
  async deleteQueuesUnder(prefix: string): Promise<void> {
    // A prefix not closed by a separator would reach a sibling's queues, and
    // an empty one every queue in the instance.
    if (prefix.length < 2 || !prefix.endsWith("/")) {
      throw new RangeError(
        "A queue prefix has to end with '/' and name something before it.",
      );
    }
    await this.start();
    for (const name of await this.queuesUnder(prefix)) {
      await this.boss.offWork(name, { wait: false });
      await this.boss.deleteQueue(name);
      // Created again on its next use rather than taken for existing.
      this.ensuredQueues.delete(name);
    }

    // pg-boss answers a deletion it did not make as one it did: deleteQueue
    // returns without deleting anything where its own lookup of the queue
    // fails, and that lookup fails on a database error as well as on a queue
    // that is not there. So the queues are read again, and one still there
    // fails the deletion, as a read that fails does.
    const left = await this.queuesUnder(prefix);
    if (left.length > 0) {
      throw new Error(
        `${left.length} job queue(s) under "${prefix}" were not deleted.`,
      );
    }
    await this.cancelForwardsUnder(prefix);
  }

  /** The queues whose names start with `prefix`, read a page at a time. */
  private async queuesUnder(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.boss.getQueues(undefined, {
        limit: QUEUE_PAGE_SIZE,
        after,
      });
      for (const { name } of page) {
        if (name.startsWith(prefix)) {
          names.push(name);
        }
      }
      if (page.length < QUEUE_PAGE_SIZE) {
        return names;
      }
      after = page[page.length - 1]?.name;
    }
  }

  /**
   * Deletes the cron occurrences still to be sent to a queue under `prefix`,
   * and waits for any a worker is sending.
   *
   * pg-boss sends a schedule's occurrence in two steps. Its cron pass puts the
   * occurrence on a queue of pg-boss's own, with the schedule's queue named in
   * the job's data, and a worker on that queue sends it on. Deleting the
   * schedule's queue takes the schedule but leaves those jobs, and the worker
   * sends them on without asking whether the schedule is still there: to
   * nothing while the queue is gone, and to the next package's queue once that
   * package has created one under the same name.
   *
   * The waiting ones are deleted, and the ones a worker is sending waited
   * for, until none waits or is being sent. One a worker takes in the
   * meantime is left in place rather than deleted under the worker: it is
   * sent to a queue that no longer exists, or fails and waits again, to be
   * deleted by the next statement.
   *
   * The deletion and the count of what is left are one statement, so they
   * read the job table as it was at one moment. Apart, a sending that failed
   * between them, waiting again for a retry, was neither deleted nor counted
   * as being sent, and the deletion ended with it still to be sent on. Here
   * it was either still being sent at that moment, and is counted, or waiting
   * again already, and is deleted.
   *
   * An occurrence a cron pass puts on after this, having read the schedule
   * before the queue went, is not among them. It is held back where it
   * arrives instead: see {@link schedule}.
   */
  private async cancelForwardsUnder(prefix: string): Promise<void> {
    const db = this.boss.getDb();
    const values = [FORWARD_QUEUE, prefix];
    const deadline = Date.now() + FORWARD_DRAIN_MS;
    for (;;) {
      // The count reads the table as the statement found it, the rows its own
      // deletion took included, so those are left out by id.
      const { rows } = await db.executeSql(
        `WITH cancelled AS (
           DELETE FROM ${JOB_SCHEMA}.job
           WHERE name = $1 AND state IN ('created', 'retry')
             AND starts_with(data->>'name', $2)
           RETURNING id
         )
         SELECT count(*)::int AS sending FROM ${JOB_SCHEMA}.job
         WHERE name = $1 AND state IN ('created', 'retry', 'active')
           AND starts_with(data->>'name', $2)
           AND id NOT IN (SELECT id FROM cancelled)`,
        values,
      );
      const sending = Number((rows as { sending?: number }[])[0]?.sending ?? 0);
      if (sending === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${sending} cron occurrence(s) for queues under "${prefix}" were ` +
            "still being sent; the queues are deleted, the occurrences are not.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, FORWARD_POLL_MS));
    }
  }

  /** Escape hatch for advanced pg-boss usage; prefer the methods above. */
  get instance(): PgBoss {
    return this.boss;
  }
}
