import { HttpStatus } from "@nestjs/common";
import { Client, DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { domainResponse } from "../testing/domain-response";
import {
  PACKAGE_BUSY_RETRY_AFTER_SECONDS,
  PACKAGE_LOCK_LIMITS,
  PackageBusyError,
  PackageLock,
  type PackageLockLimits,
  PackageLockLostError,
} from "./package-lock";

/**
 * What the lock's failures answer with. The waiting itself is tested against
 * a database in package-lock.int-spec.ts.
 */

describe("the answers the package lock fails with", () => {
  it("answers a busy package as a refusal worth retrying, with its own reason", () => {
    const { status, headers, body } = domainResponse(
      new PackageBusyError("The theme nordic is being changed."),
    );

    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(headers["retry-after"]).toBe(
      String(PACKAGE_BUSY_RETRY_AFTER_SECONDS),
    );
    expect(body["reason"]).toBe("package-busy");
  });

  it("answers a lost lock as the server's failure, with its own reason", () => {
    const { status, body } = domainResponse(
      new PackageLockLostError("theme", "nordic", new Error("terminated")),
    );

    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body["reason"]).toBe("package-lock-lost");
  });
});

/**
 * A server whose `lc_messages` is not English translates the severity that
 * tells an ended session from a refused query, and the database the
 * integration tests run against cannot be made to. So the session is stood in
 * for here: the wait fails with the server's error, and whether the session
 * answers the question that follows is what is under test.
 */
describe("a wait that fails", () => {
  const env = { DATABASE_URL: "postgresql://openbrf@localhost/openbrf" };

  /** A DatabaseError as the server sends it. */
  function fromServer(severity: string, code: string): DatabaseError {
    const error = new DatabaseError("translated", 0, "error");
    error.severity = severity;
    error.code = code;
    return error;
  }

  /**
   * A connection that is gone, as the driver reports it: an `error` event on
   * the client first, then the query it fails.
   */
  function dropped(client: Client, message: string): Promise<never> {
    const error = new Error(message);
    client.emit("error", error);
    return Promise.reject(error);
  }

  const after = (milliseconds: number, rows: unknown[]): Promise<unknown> =>
    new Promise((resolve) => setTimeout(() => resolve({ rows }), milliseconds));

  /**
   * Runs the lock over a session whose wait fails with `waitFails`, and whose
   * answer to the next query is `answer`.
   */
  async function waitFailing(
    waitFails: Error,
    answer: (client: Client) => Promise<unknown>,
    limits: Partial<PackageLockLimits> = {},
  ): Promise<{
    error: unknown;
    entered: boolean;
    queries: unknown[];
    closed: boolean;
  }> {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const end = vi.spyOn(Client.prototype, "end").mockResolvedValue(undefined);
    const queries: unknown[] = [];
    vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: Client,
      query: unknown,
    ) {
      queries.push(query);
      switch (queries.length) {
        case 1:
          return Promise.resolve({ rows: [] });
        case 2:
          return Promise.reject(waitFails);
        default:
          return answer(this);
      }
    } as never);

    let entered = false;
    const error = await new PackageLock(env as Env, {
      ...PACKAGE_LOCK_LIMITS,
      ...limits,
    })
      .run("theme", "nordic", async () => {
        entered = true;
      })
      .catch((caught: unknown) => caught);
    return { error, entered, queries, closed: end.mock.calls.length === 1 };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a lost lock when the connection drops as the session is asked", async () => {
    const { error, entered, queries } = await waitFailing(
      fromServer("FATALT", "57P01"),
      (client) => dropped(client, "Connection terminated unexpectedly"),
    );

    expect(entered).toBe(false);
    expect(error).toBeInstanceOf(PackageLockLostError);
    // The drop the driver reported is what ended the lock.
    expect((error as PackageLockLostError).cause).toMatchObject({
      message: "Connection terminated unexpectedly",
    });
    expect(queries).toHaveLength(3);
  });

  it("answers the query's own failure when the session answers", async () => {
    const refused = fromServer("FEL", "57014");
    const { error, entered } = await waitFailing(refused, () =>
      Promise.resolve({ rows: [{ "?column?": 1 }] }),
    );

    expect(entered).toBe(false);
    expect(error).toBe(refused);
  });

  it("asks the session after a failure that is not the server's", async () => {
    const { error } = await waitFailing(
      new Error("read ECONNRESET"),
      (client) =>
        dropped(
          client,
          "Client has encountered a connection error and is not queryable",
        ),
    );

    expect(error).toBeInstanceOf(PackageLockLostError);
  });

  it("answers a lost lock when the session's answer says it ended", async () => {
    const { error } = await waitFailing(fromServer("FATALT", "57P01"), () =>
      Promise.reject(fromServer("FATAL", "57P01")),
    );

    expect(error).toBeInstanceOf(PackageLockLostError);
  });

  /*
   * The review's case, seen against PostgreSQL 18: a Swedish server, and a
   * session that answers - only later than the lock gives it. Not answering in
   * time does not make it gone, so the wait's own failure stands.
   */
  it("keeps the query's own failure when the session answers late", async () => {
    const refused = fromServer("FEL", "57014");
    const { error, entered, closed } = await waitFailing(
      refused,
      () => after(100, [{ "?column?": 1 }]),
      { connectMs: 20 },
    );

    expect(entered).toBe(false);
    expect(error).toBe(refused);
    expect(closed).toBe(true);
  });

  it("keeps the query's own failure when the session never answers, and closes it", async () => {
    const fatal = fromServer("FATALT", "57P01");
    const { error, closed } = await waitFailing(
      fatal,
      () => new Promise<never>(() => undefined),
      { connectMs: 20 },
    );

    expect(error).toBe(fatal);
    expect(closed).toBe(true);
  });

  /*
   * A question the session refuses and goes on after says nothing about the
   * wait before it, whatever language the refusal is in.
   */
  it.each(["ERROR", "FEL"])(
    "keeps the query's own failure when the question is cancelled with %s",
    async (severity) => {
      const refused = fromServer("FEL", "57014");
      const { error, entered } = await waitFailing(refused, () =>
        Promise.reject(fromServer(severity, "57014")),
      );

      expect(entered).toBe(false);
      expect(error).toBe(refused);
    },
  );

  it("does not ask when the severity says the session ended", async () => {
    const { error, queries } = await waitFailing(
      fromServer("FATAL", "25P04"),
      () => Promise.resolve({ rows: [] }),
    );

    expect(error).toBeInstanceOf(PackageLockLostError);
    expect(queries).toHaveLength(2);
  });
});
