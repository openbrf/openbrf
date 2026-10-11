import { execFileSync, spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startStack } from "./stack";

// No process is started and nothing is written: the commands are recorded, and
// the files the mail certificate would go to are left alone. stack.env is
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
