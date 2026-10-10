import { Client } from "pg";

import {
  BASE_URL_VARIABLE,
  databaseName,
  maintenanceUrl,
  quoteIdentifier,
  withDatabase,
} from "./integration-database";

/**
 * One connection to `url`, for as long as `use` takes.
 *
 * For a suite that works on a database other than the worker's, or that runs
 * statements the application's own connection never would, as a deploy
 * script does.
 */
export async function withClient<T>(
  url: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

export interface ScratchDatabases {
  /**
   * An empty database on the test cluster, as a first deploy meets it before
   * any migration has run, and its connection string. One that a run before
   * left behind under the same label is dropped first.
   */
  create(label: string): Promise<string>;
  /** Drops every database `create` made. */
  dropAll(): Promise<void>;
}

/**
 * Empty databases beside the worker's own, for a suite that runs a deploy
 * script against one: the scripts work on fixed schemas, and the worker's
 * database already holds them.
 *
 * Named after the worker and `label`, so two workers never share one; a suite
 * that makes several gives each a label of its own. The suite drops them in
 * an `afterEach` or `afterAll` with `dropAll`.
 */
export function scratchDatabases(): ScratchDatabases {
  const created: string[] = [];

  function baseUrl(): string {
    const url = process.env[BASE_URL_VARIABLE] ?? process.env.DATABASE_URL;
    if (url === undefined || url === "") {
      throw new Error("Integration tests need DATABASE_URL to be set.");
    }
    return url;
  }

  return {
    async create(label) {
      const url = baseUrl();
      const name = `${databaseName(url)}_test_${process.env.VITEST_POOL_ID ?? "1"}_${label}`;
      await withClient(maintenanceUrl(url), async (client) => {
        await client.query(
          `drop database if exists ${quoteIdentifier(name)} with (force)`,
        );
        await client.query(`create database ${quoteIdentifier(name)}`);
      });
      created.push(name);
      return withDatabase(url, name);
    },

    async dropAll() {
      if (created.length === 0) {
        return;
      }
      await withClient(maintenanceUrl(baseUrl()), async (client) => {
        for (const name of created.splice(0)) {
          await client.query(
            `drop database if exists ${quoteIdentifier(name)} with (force)`,
          );
        }
      });
    },
  };
}
