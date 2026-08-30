import { describe, expect, it } from "vitest";

import {
  INTEGRATION_WORKER_COUNT,
  databaseName,
  maintenanceUrl,
  quoteIdentifier,
  redact,
  redirectToWorker,
  templateDatabaseName,
  withDatabase,
  workerDatabaseName,
} from "./integration-database";

/**
 * The naming a parallel integration run depends on.
 *
 * Two workers that resolve to the same database is the one fault this module
 * can produce, and it does not announce itself: the suites still pass most of
 * the time, and fail as an unrelated row appearing in someone else's
 * assertion. So the properties are asserted here, without a database, rather
 * than trusted to hold.
 */

const BASE = "postgresql://openbrf:secret@localhost:5432/openbrf";

describe("databaseName", () => {
  it("reads the database out of a connection string", () => {
    expect(databaseName(BASE)).toBe("openbrf");
  });

  it("refuses a connection string that names no database", () => {
    expect(() =>
      databaseName("postgresql://openbrf:secret@localhost:5432"),
    ).toThrow(/No database/);
  });
});

describe("withDatabase", () => {
  it("keeps the cluster and the credentials", () => {
    const moved = new URL(withDatabase(BASE, "other"));
    expect(moved.host).toBe("localhost:5432");
    expect(moved.username).toBe("openbrf");
    expect(moved.password).toBe("secret");
    expect(moved.pathname).toBe("/other");
  });

  it("replaces the database rather than appending to it", () => {
    // The worker setup file re-derives from the untouched base URL, but a
    // second application must not compound either.
    expect(databaseName(withDatabase(withDatabase(BASE, "a"), "b"))).toBe("b");
  });

  it("carries connection parameters through", () => {
    const withParameters = `${BASE}?sslmode=require`;
    expect(withDatabase(withParameters, "other")).toContain("sslmode=require");
  });
});

describe("maintenanceUrl", () => {
  it("points at the one database that is never a template or a clone", () => {
    expect(databaseName(maintenanceUrl(BASE))).toBe("postgres");
  });
});

describe("worker and template names", () => {
  it("gives every worker a database of its own", () => {
    const names = new Set(
      Array.from({ length: INTEGRATION_WORKER_COUNT }, (_, index) =>
        workerDatabaseName(BASE, index + 1),
      ),
    );
    expect(names.size).toBe(INTEGRATION_WORKER_COUNT);
  });

  it("never gives a worker the database being developed in", () => {
    for (let poolId = 1; poolId <= INTEGRATION_WORKER_COUNT; poolId += 1) {
      expect(workerDatabaseName(BASE, poolId)).not.toBe(databaseName(BASE));
    }
  });

  it("keeps the template apart from every worker", () => {
    const template = templateDatabaseName(BASE);
    expect(template).not.toBe(databaseName(BASE));
    for (let poolId = 1; poolId <= INTEGRATION_WORKER_COUNT; poolId += 1) {
      expect(workerDatabaseName(BASE, poolId)).not.toBe(template);
    }
  });

  it("provisions at least one database", () => {
    expect(INTEGRATION_WORKER_COUNT).toBeGreaterThanOrEqual(1);
  });
});

describe("quoteIdentifier", () => {
  it("quotes a plain name", () => {
    expect(quoteIdentifier("openbrf_test_1")).toBe('"openbrf_test_1"');
  });

  it("doubles an embedded quote, so the name cannot end early", () => {
    expect(quoteIdentifier('a"; drop database openbrf; --')).toBe(
      '"a""; drop database openbrf; --"',
    );
  });
});

describe("redact", () => {
  it("drops the password, so a message can carry the rest", () => {
    const message = redact(BASE);
    expect(message).not.toContain("secret");
    expect(message).toContain("localhost:5432");
  });

  it("says something usable when the string is not a URL at all", () => {
    expect(redact("not a url")).toBe("the configured connection string");
  });
});

describe("redirectToWorker", () => {
  it("points a configured connection string at the worker's database", () => {
    const redirected = redirectToWorker(BASE, BASE, 3);
    expect(redirected).toBeDefined();
    expect(databaseName(redirected ?? "")).toBe(workerDatabaseName(BASE, 3));
  });

  it("leaves an unset variable unset", () => {
    expect(redirectToWorker(undefined, BASE, 1)).toBeUndefined();
  });

  it("treats a variable that is set but empty as unset", () => {
    // DATABASE_URL_RUNTIME= in a .env is set aside, not configured. Parsing it
    // would throw a TypeError out of a setup file and stop every worker before
    // it loaded a suite, in place of the configuration error loadEnv gives.
    expect(redirectToWorker("", BASE, 1)).toBeUndefined();
  });

  it("redirects a role other than the one in DATABASE_URL", () => {
    // The runtime role names the same cluster and the same database, so it
    // follows the redirection while keeping its own credentials.
    const runtime = "postgresql://openbrf_app:apppass@localhost:5432/openbrf";
    const redirected = new URL(redirectToWorker(runtime, BASE, 2) ?? "");
    expect(redirected.username).toBe("openbrf_app");
    expect(redirected.password).toBe("apppass");
    expect(redirected.pathname).toBe(`/${workerDatabaseName(BASE, 2)}`);
  });
});
