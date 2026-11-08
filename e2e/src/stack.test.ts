import { execFileSync, spawnSync } from "node:child_process";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { startStack } from "./stack";

// No process is started and nothing is written: the commands are recorded, and
// the files the mail certificate and the fixture catalog would go to are left
// alone. stack.env is
// still read, so the stack is addressed as the suite addresses it.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

/** Every command run, in order, as the program and the arguments after `-p`'s files. */
function commands(): string[] {
  const calls = [
    ...vi.mocked(execFileSync).mock.calls.map((call, index) => ({
      order: vi.mocked(execFileSync).mock.invocationCallOrder[index] ?? 0,
      program: call[0],
      args: call[1] ?? [],
    })),
    ...vi.mocked(spawnSync).mock.calls.map((call, index) => ({
      order: vi.mocked(spawnSync).mock.invocationCallOrder[index] ?? 0,
      program: call[0],
      args: (call[1] ?? []) as readonly string[],
    })),
  ];
  return calls
    .toSorted((a, b) => a.order - b.order)
    .map(({ program, args }) => {
      if (program !== "docker") {
        return program;
      }
      if (args[0] !== "compose") {
        return `docker ${args.join(" ")}`;
      }
      const envFile = args.indexOf("--env-file");
      return `docker compose ${args.slice(envFile + 2).join(" ")}`;
    });
}

/** The id `docker compose ps` answers with for the application container. */
const APP_CONTAINER = "0123456789ab";

/**
 * Docker, as far as startStack asks it anything: the application container's
 * id, and the gateway of its network. Every other command answers nothing.
 */
function dockerAnswering(gateway: string) {
  return ((program: string, args?: readonly string[]) => {
    if (program !== "docker") {
      return "";
    }
    if (args?.[0] === "compose" && args.includes("ps")) {
      return `${APP_CONTAINER}\n`;
    }
    if (args?.[0] === "inspect") {
      return `${gateway} \n`;
    }
    return "";
  }) as unknown as typeof execFileSync;
}

describe("startStack", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // A developer's machine, whatever runs these tests.
    vi.stubEnv("CI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to pull the pins as they are in CI", () => {
    vi.stubEnv("CI", "true");

    expect(() => startStack()).toThrow(/OPENBRF_IMAGE_MIRROR is not/);
    expect(commands()).toEqual([]);
  });

  const pulled = {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };

  it("pulls the registry images before it builds and starts the stack", () => {
    vi.mocked(execFileSync).mockImplementation(dockerAnswering("172.18.0.1"));
    vi.mocked(spawnSync).mockReturnValue(pulled);

    startStack();

    expect(commands()).toEqual([
      "docker compose down --volumes --remove-orphans",
      "openssl",
      // The fixture catalog, packed by scripts/build-fixture-catalog.mjs.
      "node",
      "docker compose pull --ignore-buildable",
      "docker compose up --build --detach --wait",
      // Then where the suite's requests will come from.
      "docker compose ps --all --quiet app",
      `docker inspect --format {{range .NetworkSettings.Networks}}{{.Gateway}} {{end}} ${APP_CONTAINER}`,
    ]);
  });

  it("passes a gateway from a daemon whose address pools are in 10.0.0.0/8", () => {
    vi.mocked(execFileSync).mockImplementation(dockerAnswering("10.128.10.1"));
    vi.mocked(spawnSync).mockReturnValue(pulled);

    expect(() => startStack()).not.toThrow();
  });

  it("stops at start when the gateway is outside TRUSTED_PROXIES", () => {
    vi.mocked(execFileSync).mockImplementation(dockerAnswering("100.80.0.1"));
    vi.mocked(spawnSync).mockReturnValue(pulled);

    expect(() => startStack()).toThrow(
      /gateway 100\.80\.0\.1 is not in TRUSTED_PROXIES \(10\.0\.0\.0\/8,.*in .*stack\.env\./,
    );
  });

  it("checks the TRUSTED_PROXIES the environment gives, which Compose prefers", async () => {
    vi.stubEnv("TRUSTED_PROXIES", "172.16.0.0/12");
    vi.resetModules();
    const childProcess = await import("node:child_process");
    const { startStack: start } = await import("./stack");
    vi.mocked(childProcess.execFileSync).mockImplementation(
      dockerAnswering("10.128.10.1"),
    );
    vi.mocked(childProcess.spawnSync).mockReturnValue(pulled);

    try {
      expect(() => start()).toThrow(
        /gateway 10\.128\.10\.1 is not in TRUSTED_PROXIES \(172\.16\.0\.0\/12\).*the TRUSTED_PROXIES this process was started with/,
      );
    } finally {
      vi.resetModules();
    }
  });

  it("starts nothing when the pull fails for good", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "Error response from daemon: manifest unknown: digest not found",
      status: 18,
      signal: null,
    });

    expect(() => startStack()).toThrow(/manifest unknown: digest not found/);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(commands()).not.toContain(
      "docker compose up --build --detach --wait",
    );
  });
});

describe("startStack with a CI image mirror", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const refs = {
    postgres: {
      upstream: `postgres:18-alpine@${digest}`,
      pull: `ghcr.io/openbrf/ci-mirror/postgres:18-alpine@${digest}`,
    },
    node: {
      upstream: `public.ecr.aws/docker/library/node:26-slim@${digest}`,
      pull: `ghcr.io/openbrf/ci-mirror/node:26-slim@${digest}`,
    },
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("points the database and the build's base image at the mirror", async () => {
    vi.stubEnv("OPENBRF_IMAGE_MIRROR", "ghcr.io/openbrf/ci-mirror");
    vi.resetModules();
    // Imported again after the reset, so that these are the mocks the freshly
    // loaded stack module calls.
    const childProcess = await import("node:child_process");
    const fs = await import("node:fs");
    const { startStack: start } = await import("./stack");
    const docker = dockerAnswering("172.18.0.1");
    vi.mocked(childProcess.execFileSync).mockImplementation((program, args) =>
      program === "node" ? JSON.stringify(refs) : docker(program, args),
    );
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    start();

    const [path, content] = vi.mocked(fs.writeFileSync).mock.calls[0] ?? [];
    const build = {
      build: {
        additional_contexts: {
          [refs.node.upstream]: `docker-image://${refs.node.pull}`,
        },
      },
    };
    expect(JSON.parse(content as string)).toEqual({
      services: {
        db: { image: refs.postgres.pull },
        "superuser-password": build,
        "schema-owner": build,
        migrate: build,
        app: build,
      },
    });
    // Every compose call reads the overlay, the first `down` included, and
    // the overlay is written before it.
    const composeCalls = [
      ...vi.mocked(childProcess.execFileSync).mock.calls,
      ...vi.mocked(childProcess.spawnSync).mock.calls,
    ]
      .filter(([program]) => program === "docker")
      .map(([, args]) => (args ?? []) as readonly string[])
      // Of the program's own commands; `docker inspect` reads no compose file.
      .filter((args) => args[0] === "compose");
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const args of composeCalls) {
      expect(args.join(" ")).toContain(`-f ${String(path)} --env-file`);
    }
    const execCalls = vi.mocked(childProcess.execFileSync).mock;
    const firstDown = execCalls.calls.findIndex(
      ([program, args]) => program === "docker" && args?.includes("down"),
    );
    expect(
      vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0],
    ).toBeLessThan(execCalls.invocationCallOrder[firstDown] ?? 0);
  });
});
