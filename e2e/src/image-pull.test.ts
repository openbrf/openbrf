import { describe, expect, it, vi } from "vitest";

import { isTransientPullFailure, pullWithRetry } from "./image-pull";

/** A pull that fails with each of `failures` in turn, then succeeds. */
function pullFailing(...failures: Error[]) {
  const remaining = [...failures];
  return vi.fn(() => {
    const failure = remaining.shift();
    if (failure !== undefined) {
      throw failure;
    }
  });
}

function composeFailure(stderr: string): Error {
  return new Error(`docker compose pull exited with 18:\n${stderr}`);
}

const THROTTLED = composeFailure(
  "db Error toomanyrequests: Rate exceeded\n" +
    "Error response from daemon: toomanyrequests: Rate exceeded",
);

const MISSING_DIGEST = composeFailure(
  "db Error manifest unknown: digest not found\n" +
    "Error response from daemon: manifest unknown: digest not found",
);

describe("pullWithRetry", () => {
  it("pulls once and waits for nothing when the first pull succeeds", () => {
    const pull = pullFailing();
    const wait = vi.fn();

    pullWithRetry(pull, { wait, report: vi.fn() });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("succeeds after a throttled pull, having waited once", () => {
    const pull = pullFailing(THROTTLED);
    const wait = vi.fn();

    pullWithRetry(pull, { wait, report: vi.fn() });

    expect(pull).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls).toEqual([[15_000]]);
  });

  it.each([
    ["a missing digest", MISSING_DIGEST],
    [
      "a refused pull",
      composeFailure(
        "pull access denied for openbrf/nothing, repository does not exist",
      ),
    ],
    [
      "an invalid compose configuration",
      composeFailure("services.db.image: invalid reference format"),
    ],
    [
      "a daemon that is not running",
      composeFailure(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      ),
    ],
    [
      "a missing docker executable",
      Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
    ],
    [
      "a missing image beside a throttled one",
      composeFailure(
        "app Error toomanyrequests: Rate exceeded\n" +
          "db Error manifest unknown: digest not found",
      ),
    ],
  ])("throws %s at once, without waiting", (_, failure) => {
    const pull = pullFailing(failure);
    const wait = vi.fn();

    expect(() => pullWithRetry(pull, { wait, report: vi.fn() })).toThrow(
      failure,
    );
    expect(pull).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt and throws that attempt's own failure", () => {
    const last = composeFailure(
      "Error response from daemon: 503 Service Unavailable",
    );
    const pull = pullFailing(THROTTLED, THROTTLED, THROTTLED, last);
    const wait = vi.fn();
    const report = vi.fn();

    let thrown: unknown;
    try {
      pullWithRetry(pull, { wait, report });
    } catch (failure) {
      thrown = failure;
    }

    expect(thrown).toBe(last);
    expect(pull).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[15_000], [30_000], [45_000]]);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("makes no more attempts than it is given", () => {
    const pull = pullFailing(THROTTLED, THROTTLED);
    const wait = vi.fn();

    expect(() =>
      pullWithRetry(pull, { attempts: 2, wait, report: vi.fn() }),
    ).toThrow(THROTTLED);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientPullFailure", () => {
  it.each([
    "toomanyrequests: Rate exceeded",
    "toomanyrequests: You have reached your unauthenticated pull rate limit.",
    "429 Too Many Requests",
    "received unexpected HTTP status: 502 Bad Gateway",
    "received unexpected HTTP status: 503 Service Unavailable",
    "net/http: TLS handshake timeout",
    "dial tcp 52.0.0.1:443: i/o timeout",
    "read tcp 10.1.0.4:41234->52.0.0.1:443: read: connection reset by peer",
    "unexpected EOF",
    "Client.Timeout exceeded while awaiting headers",
    "dial tcp: lookup public.ecr.aws: Temporary failure in name resolution",
  ])("retries %s", (stderr) => {
    expect(isTransientPullFailure(composeFailure(stderr))).toBe(true);
  });

  it.each([
    ["an unrecognised failure", composeFailure("something else went wrong")],
    [
      "a pull that ran into its timeout",
      Object.assign(new Error("spawnSync docker ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    ],
    ["a value that is not an error", "toomanyrequests"],
  ])("does not retry %s", (_, failure) => {
    expect(isTransientPullFailure(failure)).toBe(false);
  });
});
