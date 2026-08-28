import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The compose stack the suite runs against.
 *
 * Everything here addresses the production image through the production compose
 * file plus one overlay. There is no dev server anywhere in the suite: a run
 * that passes has exercised the artefact a housing cooperative installs,
 * including the entrypoint's migrations, its key provisioning and the
 * constrained database role the application connects as.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "../..");
export const e2eRoot = resolve(here, "..");

/**
 * Which stack this process drives.
 *
 * The screenshot task runs one of its own, under its own compose project and on
 * its own ports, selected with OPENBRF_E2E_PROFILE=screenshots. Two reasons,
 * and the second is the important one:
 *
 *   - a capture and a suite run can happen at the same time without fighting
 *     over a container, a volume or a port;
 *   - the two instances hold different data. The suite creates people carrying
 *     a personal identity number and a phone number in order to test masking,
 *     and a capture writes images that end up in a public pull request.
 */
const PROFILES = {
  e2e: { project: "openbrf-e2e", envFile: "stack.env" },
  screenshots: { project: "openbrf-shots", envFile: "screenshots.env" },
} as const;

const profile =
  process.env.OPENBRF_E2E_PROFILE === "screenshots"
    ? PROFILES.screenshots
    : PROFILES.e2e;

export const PROJECT_NAME = profile.project;

const ENV_FILE = resolve(e2eRoot, profile.envFile);

const COMPOSE_ARGS = [
  "compose",
  "-p",
  PROJECT_NAME,
  "-f",
  resolve(repositoryRoot, "docker-compose.prod.yml"),
  "-f",
  resolve(e2eRoot, "docker-compose.e2e.yml"),
  "--env-file",
  ENV_FILE,
];

/** Reads stack.env so the suite and the stack cannot drift apart. */
function readStackEnv(): Readonly<Record<string, string>> {
  const entries = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
  return Object.fromEntries(entries);
}

const env = readStackEnv();

function required(name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is missing from ${ENV_FILE}`);
  }
  return value;
}

/**
 * One connection URL, with the password percent-encoded.
 *
 * A password is a URL component. The suite gives both roles one containing :,
 * / and @ on purpose, because that is what the entrypoint has to survive when
 * it assembles the application's own URLs, and a suite that only ever used hex
 * would never notice it stopped.
 */
function connectionUrl(role: string, passwordVariable: string): string {
  return `postgresql://${role}:${encodeURIComponent(required(passwordVariable))}@127.0.0.1:${required("E2E_DB_PORT")}/openbrf`;
}

export const stack = {
  baseUrl: required("APP_URL"),
  mailpitUrl: `http://127.0.0.1:${required("E2E_MAILPIT_PORT")}`,
  /** The owner connection, used only to read the append-only audit log. */
  databaseUrl: connectionUrl("openbrf", "POSTGRES_PASSWORD"),
  /**
   * The connection the application itself uses: openbrf_app, as the entrypoint
   * created and constrained it. Nothing in the suite should reach for this to
   * set data up - it is here so a spec can prove what that role can and cannot
   * do, which is only meaningful against the role the deployed image made.
   */
  runtimeDatabaseUrl: connectionUrl("openbrf_app", "RUNTIME_DB_PASSWORD"),
  /** Reachable from the app container, not from the host. */
  smtpHost: "mailpit",
  smtpPort: 1025,
} as const;

function compose(args: readonly string[], timeoutMs: number): void {
  execFileSync("docker", [...COMPOSE_ARGS, ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

/**
 * Builds the image and starts the stack from empty volumes.
 *
 * The volumes are destroyed first because the first spec asserts on first-boot
 * behaviour, which an instance only has once. `-p openbrf-e2e` scopes that
 * removal to this stack's own volumes, never a development or production one.
 */
export function startStack(): void {
  compose(["down", "--volumes", "--remove-orphans"], 5 * 60_000);
  compose(["up", "--build", "--detach", "--wait"], 30 * 60_000);
}

export function stopStack(): void {
  compose(["down", "--volumes", "--remove-orphans"], 5 * 60_000);
}

/**
 * Runs a command inside the application container and returns what it wrote.
 *
 * The entrypoint's own scripts are the deployed artefact too, and they talk to
 * psql, which lives in the image rather than on the machine driving the suite.
 * Only the command's own streams are returned: an error object from the runner
 * would carry the docker command line, and this exists to check what a script
 * does and does not put in a log.
 */
export function runInAppContainer(
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
): { status: number; output: string } {
  const overrides = Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  try {
    const stdout = execFileSync(
      "docker",
      // No pseudo-TTY: the two streams stay apart, and nothing here is
      // attached to a terminal in CI.
      [...COMPOSE_ARGS, "exec", "-T", ...overrides, "app", ...command],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { status: 0, output: stdout };
  } catch (failure) {
    const result = failure as {
      status?: number | null;
      stdout?: string | null;
      stderr?: string | null;
    };
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

/**
 * The production compose file resolved against an env file holding exactly
 * these variables, as `docker compose config` renders it.
 *
 * Without the e2e overlay and without stack.env, because what an operator
 * following docs/deployment.md runs is docker-compose.prod.yml and their own
 * .env.production. A variable that file does not name never reaches the image,
 * however carefully it is set, so the rendering is where a documented
 * configuration path can be shown to exist at all. Nothing is started.
 */
export function productionComposeConfig(
  variables: Readonly<Record<string, string>>,
): { status: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "openbrf-compose-"));
  const envFile = join(directory, "env");
  writeFileSync(
    envFile,
    Object.entries(variables)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
  try {
    return {
      status: 0,
      output: execFileSync(
        "docker",
        [
          "compose",
          // A project of its own, and `config` starts nothing, so this can
          // never reach the suite's containers or anyone else's.
          "-p",
          `${PROJECT_NAME}-config`,
          "-f",
          resolve(repositoryRoot, "docker-compose.prod.yml"),
          "--env-file",
          envFile,
          "config",
          "--format",
          "json",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      ),
    };
  } catch (failure) {
    const result = failure as {
      status?: number | null;
      stdout?: string | null;
      stderr?: string | null;
    };
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Prints the application's logs. Called when the suite fails, not otherwise. */
export function printAppLogs(): void {
  try {
    compose(["logs", "--no-color", "--tail", "200", "app"], 60_000);
  } catch {
    // Best effort: a missing container must not mask the real failure.
  }
}
