import { cpus } from "node:os";

/**
 * Gives every integration worker a database of its own.
 *
 * The integration suites assert on triggers, privileges and constraints, so
 * they need a real PostgreSQL instance rather than a mock. What they must not
 * need is each other: several of them write the same statutory tables, and a
 * suite reading a row that another suite is deleting fails for a reason with
 * nothing to do with the behaviour under test. One database per worker removes
 * that contention instead of scheduling around it, which is what lets the
 * suites run at the same time at all.
 *
 * The per-worker databases are clones of a template, made with
 * `CREATE DATABASE ... TEMPLATE`. That is a file copy inside the cluster rather
 * than a replay of the migration history, so a clone costs a fraction of a
 * second however long the migrations themselves take to apply.
 */

/**
 * How many databases to provision, and the ceiling on parallel workers.
 *
 * Held well below the cluster's max_connections, which is 100 by default:
 * every worker keeps a connection pool of its own, and a run that exhausts the
 * cluster surfaces as a connection error in whichever suite happens to ask
 * last rather than as anything that points at the cause. One core is left for
 * the runner itself and for the database, which share the machine here even
 * though they would not in production.
 */
export const INTEGRATION_WORKER_COUNT = Math.max(
  1,
  Math.min(8, cpus().length - 1),
);

/** The database a connection string names, e.g. `openbrf`. */
export function databaseName(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (name === "") {
    throw new Error(`No database in the connection string ${redact(url)}.`);
  }
  return name;
}

/** The same connection string, pointed at another database on that cluster. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * The maintenance connection, used to create and drop the others.
 *
 * `CREATE DATABASE` cannot run from inside the database it is creating a copy
 * of, and a session connected to the template blocks the copy outright, so the
 * provisioning connects to `postgres` instead.
 */
export function maintenanceUrl(url: string): string {
  return withDatabase(url, "postgres");
}

/** The migrated database the per-worker copies are cloned from. */
export function templateDatabaseName(url: string): string {
  return `${databaseName(url)}_test_template`;
}

/** The database belonging to one worker. `poolId` is Vitest's, 1-based. */
export function workerDatabaseName(url: string, poolId: number): string {
  return `${databaseName(url)}_test_${String(poolId)}`;
}

/**
 * Points an optional connection string at a worker's database.
 *
 * A variable that is present but empty is one somebody set aside rather than
 * configured, and `new URL("")` throws. Raising that as a TypeError from a
 * setup file, before any suite has loaded, buries what is really a
 * configuration mistake; returning undefined leaves the value untouched for
 * loadEnv to reject with a message that names it.
 */
export function redirectToWorker(
  url: string | undefined,
  baseUrl: string,
  poolId: number,
): string | undefined {
  if (url === undefined || url === "") {
    return undefined;
  }
  return withDatabase(url, workerDatabaseName(baseUrl, poolId));
}

/**
 * Quotes an identifier for interpolation into SQL.
 *
 * `CREATE DATABASE` takes no parameters - a database name cannot be bound the
 * way a value can - so the names built above are quoted rather than passed.
 * They are derived from the configured connection string and not from anything
 * a test supplies, but a database named through a `.env` someone else wrote is
 * still not something to concatenate raw.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A connection string with its password removed, safe to put in a message. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "the configured connection string";
  }
}
