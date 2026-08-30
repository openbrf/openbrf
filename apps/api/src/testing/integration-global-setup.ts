import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { loadNearestEnvFile } from "../config/load-env-file";
import {
  INTEGRATION_WORKER_COUNT,
  maintenanceUrl,
  quoteIdentifier,
  redact,
  templateDatabaseName,
  withDatabase,
  workerDatabaseName,
} from "./integration-database";

/**
 * Provisions the databases the integration workers run against.
 *
 * Runs once per `pnpm test:int`, before any worker starts. It brings a
 * template database up to the current migrations and then clones it once per
 * worker, so each worker opens a schema that is migrated, empty and its own.
 *
 * The template is rebuilt only when the migrations change. Applying them is
 * the expensive half of the work and their content is what decides whether the
 * result is still current, so the fingerprint below is stored in the template
 * and compared on the next run.
 *
 * Nothing here touches the database named in DATABASE_URL. That one belongs to
 * whoever is developing against it - it holds their seed data and it may well
 * have a dev server connected - and a test run is not entitled to either
 * disturb it or wait for it to be idle.
 */

/**
 * The package root, which is where the runner was started.
 *
 * Resolved from the working directory rather than from this file's own
 * location, for the reason loadNearestEnvFile gives: the API is CommonJS in
 * production and ESM under Vitest, and neither __dirname nor import.meta
 * exists in both. `pnpm test:int` runs in the package, directly or through
 * turbo, so the working directory is the package root; the check below says so
 * plainly rather than failing later on a path that does not exist.
 */
const apiDirectory = process.cwd();
const migrationsDirectory = join(apiDirectory, "prisma", "migrations");

/** The table the template carries to say which migrations it was built from. */
const FINGERPRINT_TABLE = "_openbrf_test_template";

/**
 * Identifies the migration history by content, not just by name.
 *
 * An edited migration keeps its directory name, and during development that is
 * the common case rather than the exotic one: the file is rewritten in place
 * until it is right. A template rebuilt only when a name appears would go on
 * serving the superseded schema, and the suites would fail against a database
 * that no longer matches the one the application creates.
 */
function migrationsFingerprint(): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(migrationsDirectory, {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sql = join(migrationsDirectory, entry.name, "migration.sql");
    if (!existsSync(sql)) {
      continue;
    }
    hash.update(entry.name);
    hash.update(readFileSync(sql));
  }
  return hash.digest("hex");
}

async function currentFingerprint(
  client: Client,
  template: string,
  templateUrl: string,
): Promise<string | undefined> {
  const { rowCount } = await client.query(
    "select 1 from pg_database where datname = $1",
    [template],
  );
  if (rowCount === 0) {
    return undefined;
  }

  const templateClient = new Client({ connectionString: templateUrl });
  await templateClient.connect();
  try {
    const result = await templateClient.query<{ fingerprint: string }>(
      `select fingerprint from ${quoteIdentifier(FINGERPRINT_TABLE)} limit 1`,
    );
    return result.rows[0]?.fingerprint;
  } catch {
    // No marker table, so the template predates this scheme or was left
    // half-built by an interrupted run. Either way it gets rebuilt.
    return undefined;
  } finally {
    await templateClient.end();
  }
}

function run(
  command: string,
  args: readonly string[],
  databaseUrl: string,
): void {
  try {
    execFileSync(command, args, {
      cwd: apiDirectory,
      stdio: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        // The template is the owner's to build. A runtime role that cannot
        // create tables would fail here, and it is not what migrations run as.
        DATABASE_URL_RUNTIME: undefined,
      },
    });
  } catch (cause) {
    // execFileSync captures the child's output instead of forwarding it, so a
    // failed migration would otherwise surface as a bare non-zero exit code.
    const output = cause as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `Building the integration test template failed while running ` +
        `${command} ${args.join(" ")}:\n` +
        `${output.stdout?.toString() ?? ""}${output.stderr?.toString() ?? ""}`,
      { cause },
    );
  }
}

async function buildTemplate(
  client: Client,
  template: string,
  templateUrl: string,
  fingerprint: string,
): Promise<void> {
  const quoted = quoteIdentifier(template);
  // FORCE closes sessions a previous run left behind; without it a stale
  // connection makes the drop hang rather than fail.
  await client.query(`drop database if exists ${quoted} with (force)`);
  await client.query(`create database ${quoted}`);

  run(
    join(apiDirectory, "node_modules", ".bin", "prisma"),
    ["migrate", "deploy"],
    templateUrl,
  );
  run(
    process.execPath,
    [join("scripts", "install-job-schema.mjs")],
    templateUrl,
  );

  const templateClient = new Client({ connectionString: templateUrl });
  await templateClient.connect();
  try {
    await templateClient.query(
      `create table ${quoteIdentifier(FINGERPRINT_TABLE)} (fingerprint text not null)`,
    );
    await templateClient.query(
      `insert into ${quoteIdentifier(FINGERPRINT_TABLE)} (fingerprint) values ($1)`,
      [fingerprint],
    );
  } finally {
    await templateClient.end();
  }
}

export default async function setup(): Promise<void> {
  if (!existsSync(migrationsDirectory)) {
    throw new Error(
      `No migrations at ${migrationsDirectory}. The integration suite has to ` +
        "be started from apps/api, which `pnpm test:int` does.",
    );
  }

  loadNearestEnvFile();
  const baseUrl = process.env.DATABASE_URL;
  if (baseUrl === undefined || baseUrl === "") {
    throw new Error(
      "Integration tests need DATABASE_URL to point at a PostgreSQL cluster " +
        "as the schema owner. Copy .env.example to .env and start the " +
        "database with `docker compose up -d db`.",
    );
  }

  const template = templateDatabaseName(baseUrl);
  const templateUrl = withDatabase(baseUrl, template);

  const client = new Client({ connectionString: maintenanceUrl(baseUrl) });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(
      `Could not reach the database at ${redact(baseUrl)}. Start it with ` +
        "`docker compose up -d db`.",
      { cause },
    );
  }

  try {
    const fingerprint = migrationsFingerprint();
    if (
      (await currentFingerprint(client, template, templateUrl)) !== fingerprint
    ) {
      await buildTemplate(client, template, templateUrl, fingerprint);
    }

    // Recreated per run rather than reused, so a suite always opens an empty
    // database and never inherits rows from the run before it.
    for (let poolId = 1; poolId <= INTEGRATION_WORKER_COUNT; poolId += 1) {
      const worker = quoteIdentifier(workerDatabaseName(baseUrl, poolId));
      await client.query(`drop database if exists ${worker} with (force)`);
      await client.query(
        `create database ${worker} template ${quoteIdentifier(template)}`,
      );
    }
  } finally {
    await client.end();
  }
}
