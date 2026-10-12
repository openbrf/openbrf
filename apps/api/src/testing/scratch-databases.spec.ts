import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scratchDatabases } from "./scratch-databases";

const pg = vi.hoisted(() => ({
  queries: [] as string[],
  // One entry per connection, in the order they are opened; a connection
  // beyond the list closes cleanly.
  endFailures: [] as Array<Error | undefined>,
  opened: 0,
}));

vi.mock("pg", () => ({
  Client: class {
    private readonly endFailure = pg.endFailures[pg.opened++];

    connect(): Promise<void> {
      return Promise.resolve();
    }

    query(sql: string): Promise<void> {
      pg.queries.push(sql);
      return Promise.resolve();
    }

    end(): Promise<void> {
      return this.endFailure === undefined
        ? Promise.resolve()
        : Promise.reject(this.endFailure);
    }
  },
}));

/**
 * The cleanup contract of `scratchDatabases`, without a database.
 *
 * `create` closes its maintenance connection after the database was made, and
 * that close can fail. The database exists by then, so the name has to be
 * recorded before the connection is opened: a suite whose `create` threw has no
 * connection string to drop it by, and `dropAll` is the only thing that can.
 * Recording it afterwards leaks one database per failure on the shared test
 * cluster.
 */
describe("scratchDatabases", () => {
  beforeEach(() => {
    pg.queries.length = 0;
    pg.endFailures.length = 0;
    pg.opened = 0;
    vi.stubEnv(
      "OPENBRF_TEST_BASE_DATABASE_URL",
      "postgres://u:p@localhost:5432/openbrf",
    );
    vi.stubEnv("VITEST_POOL_ID", "3");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops a database whose maintenance connection failed to close after it was made", async () => {
    pg.endFailures.push(new Error("connection reset"));
    const scratch = scratchDatabases();

    await expect(scratch.create("deploy")).rejects.toThrow("connection reset");
    expect(pg.queries).toContain('create database "openbrf_test_3_deploy"');
    pg.queries.length = 0;

    await scratch.dropAll();

    expect(pg.queries).toEqual([
      'drop database if exists "openbrf_test_3_deploy" with (force)',
    ]);
  });
});
