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
      const envFile = args.indexOf("--env-file");
      return `docker compose ${args.slice(envFile + 2).join(" ")}`;
    });
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

  it("pulls the registry images before it builds and starts the stack", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    });

    startStack();

    expect(commands()).toEqual([
      "docker compose down --volumes --remove-orphans",
      "openssl",
      // The fixture catalog, packed by scripts/build-fixture-catalog.mjs.
      "node",
      "docker compose pull --ignore-buildable",
      "docker compose up --build --detach --wait",
    ]);
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
    vi.mocked(childProcess.execFileSync).mockImplementation((program) =>
      program === "node" ? JSON.stringify(refs) : Buffer.alloc(0),
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
      .map(([, args]) => (args ?? []) as readonly string[]);
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
