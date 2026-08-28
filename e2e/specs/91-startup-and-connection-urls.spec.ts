import { expect, test } from "@playwright/test";
import pg from "pg";

import { jsonBodyOrNothing } from "../src/api";
import { runInAppContainer, stack } from "../src/stack";

/**
 * What the deployed image does with the database password, and what it does
 * with a request that is nobody's.
 *
 * Not one of the numbered exit criteria, and none of it is visible from a
 * screen. The password reaches the instance through a connection URL, where the
 * characters an operator may well have in a password are delimiters, and it
 * reaches the container's log the moment anything reports an error that carries
 * the command line it was passed on. A container log is shipped off the host,
 * readable by anyone with Docker access, and the first thing pasted into a bug
 * report.
 */

/** Never the real one: this run has to be able to say it saw no password. */
const DECOY_PASSWORD = "this-must-never-be-logged-4f19";

/**
 * A socket directory no message about connection URLs would name by itself, so
 * a run can tell the URL it passed in from the example in an error message.
 */
const DECOY_SOCKET = "/var/run/openbrf-probe-4f19";

test("the first-boot check reports a failure without the database URL", () => {
  // Thirty attempts, a second apart, before the check gives up.
  test.setTimeout(150_000);

  const { status, output } = runInAppContainer(
    ["node", "/app/docker/first-boot.mjs"],
    {
      // Nothing listens on port 1, so the wait runs out and the failure path
      // is the one that reports it.
      DATABASE_URL: `postgresql://openbrf:${DECOY_PASSWORD}@127.0.0.1:1/openbrf`,
      // A directory of its own, so the check looks for a key, finds none and
      // goes on to the database instead of stopping at the real instance's key.
      OPENBRF_DATA_DIR: "/tmp/first-boot-probe",
      OPENBRF_ENCRYPTION_KEY: "",
    },
    150_000,
  );

  expect(status, "the check refuses to carry on without a database").toBe(1);
  expect(output).toContain("did not accept a connection");

  // psql takes the connection string as an argument, and Node puts the whole
  // command line into the error it throws for a command that failed.
  expect(
    output.includes(DECOY_PASSWORD),
    "the startup log holds no database password",
  ).toBe(false);
  expect(
    output.includes("postgresql://"),
    "the startup log holds no connection URL",
  ).toBe(false);
});

test("a connection URL that cannot be taken apart is refused, not passed on", () => {
  // libpq accepts an authority whose host is empty; the URL parser does not.
  // Such a URL cannot be split, so the password in it cannot be moved out of
  // psql's arguments, and the image refuses the boot rather than putting it
  // there. Prisma rejects the same shape (P1013), so nothing that could have
  // migrated is being turned away.
  const unsplittable = `postgresql://openbrf:${DECOY_PASSWORD}@/openbrf?host=${DECOY_SOCKET}`;

  for (const subcommand of ["without-password", "password"]) {
    const { status, output } = runInAppContainer(
      ["node", "/app/docker/database-url.mjs", subcommand, "DATABASE_URL"],
      { DATABASE_URL: unsplittable },
      60_000,
    );

    expect(status, `${subcommand} refuses`).toBe(1);
    // The refusal names the variable to fix and the shape to write.
    expect(output, subcommand).toContain("DATABASE_URL");
    expect(output, subcommand).toContain(
      "postgresql://user:password@localhost/database?host=",
    );
    expect(
      output.includes(DECOY_PASSWORD),
      `${subcommand} echoes no password`,
    ).toBe(false);
    expect(
      output.includes(DECOY_SOCKET),
      `${subcommand} echoes nothing from the URL`,
    ).toBe(false);
  }

  // And the caller stops with it, before psql is reached at all. Were the URL
  // passed on whole instead, this would spend thirty seconds connecting with
  // the password in /proc/<pid>/cmdline.
  const firstBoot = runInAppContainer(
    ["node", "/app/docker/first-boot.mjs"],
    {
      DATABASE_URL: unsplittable,
      OPENBRF_DATA_DIR: "/tmp/unsplittable-probe",
      OPENBRF_ENCRYPTION_KEY: "",
    },
    60_000,
  );

  expect(firstBoot.status, "the first-boot check refuses it too").toBe(1);
  expect(firstBoot.output).toContain("DATABASE_URL");
  expect(
    firstBoot.output.includes(DECOY_PASSWORD),
    "the startup log holds no database password",
  ).toBe(false);

  // A Unix socket connection is not what is being refused: the spelling that
  // names a host and puts the directory in a query parameter is the one Prisma
  // documents, and it is split like any other.
  const socket = runInAppContainer(
    [
      "node",
      "/app/docker/database-url.mjs",
      "without-password",
      "DATABASE_URL",
    ],
    {
      DATABASE_URL: `postgresql://openbrf:${DECOY_PASSWORD}@localhost/openbrf?host=${DECOY_SOCKET}`,
    },
    60_000,
  );

  expect(socket.status, "a socket URL that parses still works").toBe(0);
  expect(socket.output.trim()).toBe(
    `postgresql://openbrf@localhost/openbrf?host=${DECOY_SOCKET}`,
  );
});

test("a password holding URL delimiters reaches the database intact", async () => {
  // Both passwords in stack.env carry ":", "/" and "@". Raw, each of them moves
  // the boundaries of the URL they sit in - a different host, a different port,
  // a truncated name - so this is what percent-encoding is for.
  expect(stack.databaseUrl).toContain("%3A");
  expect(stack.databaseUrl).toContain("%2F");
  expect(stack.databaseUrl).toContain("%40");

  // The role the entrypoint created from that password, reached with a URL
  // built the same way. The application connecting at all is the other half of
  // this, and every spec before this one depends on it.
  const client = new pg.Client({ connectionString: stack.runtimeDatabaseUrl });
  await client.connect();
  try {
    const answer = await client.query<{ reachable: number }>(
      "SELECT 1 AS reachable",
    );
    expect(answer.rows).toEqual([{ reachable: 1 }]);
  } finally {
    await client.end();
  }
});

test("an unknown API path answers JSON, and a client route answers the client", async ({
  request,
}) => {
  // One container serves both, so the last route a request meets decides which
  // of the two it belongs to. The query string is part of the request URL and
  // no part of that decision.
  for (const path of ["/api", "/api?probe=1", "/api/not-a-route?probe=1"]) {
    const response = await request.get(`${stack.baseUrl}${path}`, {
      failOnStatusCode: false,
    });
    expect(response.status(), path).toBe(404);
    expect(jsonBodyOrNothing(await response.text()), path).toEqual({
      reason: "not-found",
    });
  }

  // And a route the client router owns is the client's, on a reload as much as
  // on a first visit.
  const client = await request.get(`${stack.baseUrl}/settings`, {
    failOnStatusCode: false,
  });
  expect(client.status()).toBe(200);
  expect(await client.text()).toContain("<!doctype html>");
});

test("a body that is not JSON is reported by its status", () => {
  // The submit endpoint is called with every status kept, so the body can be a
  // proxy's error page or nothing at all. Reading it has to leave the caller's
  // assertion about the status the thing that fails.
  expect(jsonBodyOrNothing('{"reason":"self-signup-disabled"}')).toEqual({
    reason: "self-signup-disabled",
  });
  expect(jsonBodyOrNothing("<!doctype html><html></html>")).toEqual({});
  expect(jsonBodyOrNothing("")).toEqual({});
  expect(jsonBodyOrNothing("null")).toEqual({});
});
