import { Logger } from "@nestjs/common";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { hashOpaqueToken } from "../auth/opaque-token";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { SetupClaimService } from "./setup-claim.service";

/**
 * Who may claim a fresh instance (ADR 0023).
 *
 * The token is the only thing standing between an instance that listens and
 * whoever reaches it first, so the assertions are about when a token matches,
 * when one is printed, and that the host's digest never reaches the log.
 */

/** The token a host minted, and the digest it put in the environment. */
const HOST_TOKEN = "host-minted-token-for-the-board-0001";
const HOST_DIGEST = hashOpaqueToken(HOST_TOKEN);

const BASE_ENV = {
  NODE_ENV: "test",
  APP_URL: "https://brf.example.se/",
} as Env;

function build(
  options: {
    digest?: string;
    accounts?: number;
    setupCompletedAt?: Date | null;
  } = {},
) {
  const prisma = {
    user: { count: vi.fn().mockResolvedValue(options.accounts ?? 0) },
    association: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.setupCompletedAt === undefined
            ? null
            : { setupCompletedAt: options.setupCompletedAt },
        ),
    },
  };
  const env = {
    ...BASE_ENV,
    ...(options.digest === undefined
      ? {}
      : { OPENBRF_SETUP_TOKEN_DIGEST: options.digest }),
  } as Env;
  return {
    service: new SetupClaimService(prisma as unknown as PrismaService, env),
    prisma,
  };
}

let logged: MockInstance<Logger["log"]>;
let failed: MockInstance<Logger["error"]>;

beforeEach(() => {
  logged = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  failed = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every line the service logged, as text. */
function lines(): string[] {
  return logged.mock.calls.map((call) => String(call[0]));
}

/** The token out of the one printed link, or a failure if there is none. */
function printedToken(): string {
  const match = lines()
    .join("\n")
    .match(/\/app\/setup#claim=([A-Za-z0-9_-]+) /);
  if (match?.[1] === undefined) {
    throw new Error(`no setup link was logged: ${lines().join(" | ")}`);
  }
  return match[1];
}

describe("a digest from the environment", () => {
  it("matches its own token and no other", () => {
    const { service } = build({ digest: HOST_DIGEST });

    expect(service.matches(HOST_TOKEN)).toBe(true);
    expect(service.matches(`${HOST_TOKEN}x`)).toBe(false);
    expect(service.matches("")).toBe(false);
    // The digest is not the token: whoever reads the environment holds nothing
    // that can be presented.
    expect(service.matches(HOST_DIGEST)).toBe(false);
  });

  it("matches from the start, before anything is announced", () => {
    const { service } = build({ digest: HOST_DIGEST });
    expect(service.matches(HOST_TOKEN)).toBe(true);
  });

  it("is never logged, and neither is a link", async () => {
    const { service } = build({ digest: HOST_DIGEST });

    await service.announce();

    expect(lines()).toEqual([
      "This instance is unclaimed and waits for its setup link.",
    ]);
    expect(lines().join("\n")).not.toContain(HOST_DIGEST);
    expect(lines().join("\n")).not.toContain("#claim=");
  });

  it("is named as the source of the claim", () => {
    expect(build({ digest: HOST_DIGEST }).service.source()).toBe("environment");
  });
});

describe("a token the instance mints", () => {
  it("is minted once, logged as a link built from APP_URL", async () => {
    const { service } = build();

    await service.announce();
    await service.announce();

    // One line however often it is asked: the link already printed is the one
    // the operator is reading, and a second would end the first.
    expect(logged).toHaveBeenCalledTimes(1);
    const [line] = lines();
    // The trailing slash on APP_URL does not double into the path.
    expect(line).toMatch(
      /^This instance is unclaimed\. Open https:\/\/brf\.example\.se\/app\/setup#claim=[A-Za-z0-9_-]{43} to create the first administrator\. The link works until the instance is claimed or restarted\.$/,
    );
    expect(service.matches(printedToken())).toBe(true);
  });

  it("matches nothing before it is announced", () => {
    // A request racing the start is refused rather than let through.
    const { service } = build();
    expect(service.matches("")).toBe(false);
    expect(service.matches("anything")).toBe(false);
  });

  it("is a different token after a restart", async () => {
    const first = build();
    await first.service.announce();
    const firstToken = printedToken();
    logged.mockClear();

    const second = build();
    await second.service.announce();
    const secondToken = printedToken();

    expect(secondToken).not.toBe(firstToken);
    expect(second.service.matches(firstToken)).toBe(false);
    expect(second.service.matches(secondToken)).toBe(true);
  });

  it("ends once spent", async () => {
    const { service } = build();
    await service.announce();
    const token = printedToken();

    service.spend();

    expect(service.matches(token)).toBe(false);
  });

  it("is named as the source of the claim", () => {
    expect(build().service.source()).toBe("log");
  });
});

describe("a claimed instance", () => {
  it("logs nothing once an account exists", async () => {
    const { service } = build({ accounts: 1 });

    await service.announce();

    expect(logged).not.toHaveBeenCalled();
    expect(service.matches("")).toBe(false);
  });

  it("logs nothing once setup was completed, even with no accounts", async () => {
    const { service } = build({
      accounts: 0,
      setupCompletedAt: new Date("2026-08-01T10:00:00Z"),
    });

    await service.announce();

    expect(logged).not.toHaveBeenCalled();
  });

  it("logs nothing when a digest is configured either", async () => {
    const { service } = build({ digest: HOST_DIGEST, accounts: 1 });

    await service.announce();

    expect(logged).not.toHaveBeenCalled();
  });
});

describe("a failure to read the claimed state", () => {
  it("is reported without a link, and mints nothing", async () => {
    const { service, prisma } = build();
    prisma.user.count.mockRejectedValue(new Error("connection refused"));

    await expect(service.announce()).resolves.toBeUndefined();

    expect(logged).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(String(failed.mock.calls[0]?.[0])).toContain("Restart the instance");
    expect(service.matches("")).toBe(false);
  });
});
