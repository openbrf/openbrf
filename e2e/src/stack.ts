import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Where mailpit's certificate and key are written, one directory per profile.
 *
 * Each profile writes a new pair on every start, so a shared directory would
 * let a capture replace the key under a suite run that is still going, and that
 * run's application would then refuse its own mailpit.
 */
const MAIL_TLS_DIR = resolve(e2eRoot, ".mail-tls", PROJECT_NAME);

/** The environment of every compose call that reads the overlay. */
const COMPOSE_ENV = { ...process.env, OPENBRF_E2E_MAIL_TLS_DIR: MAIL_TLS_DIR };

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
  /**
   * The schema owner's connection, openbrf_owner: reads of the append-only
   * audit log and the service-tier rows a spec cannot produce over HTTP. Not
   * the superuser, which only the database container holds.
   */
  databaseUrl: connectionUrl("openbrf_owner", "OWNER_DB_PASSWORD"),
  /**
   * The connection the application itself uses: openbrf_app, as the entrypoint
   * created and constrained it. Nothing in the suite should reach for this to
   * set data up - it is here so a spec can prove what that role can and cannot
   * do, which is only meaningful against the role the deployed image made.
   */
  runtimeDatabaseUrl: connectionUrl("openbrf_app", "RUNTIME_DB_PASSWORD"),
  /**
   * The three passwords exactly as stack.env spells them, unencoded.
   *
   * Here so a spec can search the containers' logs and environments for them.
   * The URLs above carry them percent-encoded, which is not the form a leak
   * would take if something printed the value rather than the URL it sits in.
   */
  superuserPassword: required("POSTGRES_PASSWORD"),
  ownerPassword: required("OWNER_DB_PASSWORD"),
  runtimePassword: required("RUNTIME_DB_PASSWORD"),
  /** Reachable from the app container, not from the host. */
  smtpHost: "mailpit",
  smtpPort: 1025,
  /**
   * The mailbox the board's address is collected from, as the application
   * reaches it: inside the compose network, never from the host.
   *
   * Mailpit speaks POP3 as well as SMTP, so the same container stands in for
   * both halves of an association's mail provider - which is what lets the board
   * mailbox spec drive a real protocol rather than a stub. The credentials are
   * the ones the overlay gives the container.
   */
  pop3Host: "mailpit",
  pop3Port: 1110,
  pop3User: "styrelsen",
  pop3Password: "brevladelosen",
} as const;

/**
 * Where the single-page application lives, under the origin.
 *
 * The API serves the association's own public pages at the root, so everything
 * the client router owns sits below one prefix. It is written once here rather
 * than spelled out at every navigation, because a suite that hard-codes the
 * prefix in fifty places is a suite that cannot be told the prefix moved.
 */
export const APP_BASE_PATH = "/app";

/**
 * A client route as a path to navigate to.
 *
 * Leading-slash paths resolve against `use.baseURL`, which stays the origin -
 * the API helpers address `${stack.baseUrl}/api/...` at the root and must keep
 * doing so. Only the client's own routes go through here.
 */
export function appPath(path = ""): string {
  if (path === "" || path === "/") {
    return APP_BASE_PATH;
  }
  return `${APP_BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

function compose(args: readonly string[], timeoutMs: number): void {
  execFileSync("docker", [...COMPOSE_ARGS, ...args], {
    cwd: repositoryRoot,
    env: COMPOSE_ENV,
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
  writeMailTls();
  compose(["up", "--build", "--detach", "--wait"], 30 * 60_000);
}

/**
 * A certificate for mailpit, made for this run.
 *
 * The application requires STARTTLS of an SMTP server that is not on its own
 * loopback, and verifies the certificate, so mailpit needs one issued to the
 * name the application dials. Self-signed and trusted by the application alone,
 * through NODE_EXTRA_CA_CERTS in the overlay. Made fresh rather than committed,
 * so no private key sits in the repository, and short-lived for the same
 * reason. Readable by anyone, because the containers do not run as the user
 * who wrote it; it protects nothing outside this stack.
 */
function writeMailTls(): void {
  rmSync(MAIL_TLS_DIR, { recursive: true, force: true });
  mkdirSync(MAIL_TLS_DIR, { recursive: true });
  const key = join(MAIL_TLS_DIR, "mailpit.key");
  const certificate = join(MAIL_TLS_DIR, "mailpit.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "7",
      "-subj",
      `/CN=${stack.smtpHost}`,
      "-addext",
      `subjectAltName=DNS:${stack.smtpHost}`,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 },
  );
  chmodSync(key, 0o644);
  chmodSync(certificate, 0o644);
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
 *
 * `input` is written to the command's standard input. It is how a spec hands a
 * value to the command without putting it in that command's environment or
 * arguments - which matters when what the command looks for is a secret that
 * must be in neither.
 */
export function runInAppContainer(
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  input?: string,
): { status: number; output: string } {
  return runInService("app", command, environment, timeoutMs, input);
}

/**
 * Runs SQL in the database container as the superuser, over its local socket,
 * as docs/deployment.md has an operator do it.
 *
 * For the states only the superuser can produce or put right - a membership it
 * granted to openbrf_app, or the ownership an instance installed before the
 * schema owner existed left with it. The suite's own connections are the
 * owner's and the application's.
 */
export function runAsSuperuser(
  psqlArguments: readonly string[],
  timeoutMs = 60_000,
): { status: number; output: string } {
  return runInService(
    "db",
    [
      "psql",
      "--quiet",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=on",
      "-U",
      "openbrf",
      "-d",
      "openbrf",
      ...psqlArguments,
    ],
    {},
    timeoutMs,
  );
}

/**
 * Runs the schema-owner service once more, as `up` runs it before every deploy:
 * a container of its own, from the stack's env file, that applies
 * docker/schema-owner.sql as the superuser and exits. `environment` overrides
 * what the env file gives the service.
 */
export function runSchemaOwner(
  environment: Readonly<Record<string, string>> = {},
  timeoutMs = 120_000,
): {
  status: number;
  output: string;
} {
  const overrides = Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  try {
    const stdout = execFileSync(
      "docker",
      [
        ...COMPOSE_ARGS,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        ...overrides,
        "schema-owner",
      ],
      {
        cwd: repositoryRoot,
        env: COMPOSE_ENV,
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

function runInService(
  service: "app" | "db",
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  input?: string,
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
      [...COMPOSE_ARGS, "exec", "-T", ...overrides, service, ...command],
      {
        cwd: repositoryRoot,
        env: COMPOSE_ENV,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        ...(input === undefined ? {} : { input }),
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

/**
 * One container's whole log, as it would be shipped off the host:
 * `schema-owner` for the owner's creation, `migrate` for the deploy steps, `app`
 * for the application.
 *
 * Read rather than printed: a spec asserts on what is and is not in it. This is
 * the boot that actually ran - the key provisioning, the migrations and the
 * step that reads the owner's password out of DATABASE_URL in the one, the
 * start in the other - so it is the only place the question "did any of that
 * print a credential" has a real answer.
 */
export function serviceLogs(
  service: "schema-owner" | "migrate" | "app",
): string {
  return execFileSync(
    "docker",
    [...COMPOSE_ARGS, "logs", "--no-color", service],
    {
      cwd: repositoryRoot,
      env: COMPOSE_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      // A boot log is small, but the default cap is 1 MiB and a truncated read
      // would quietly turn this into a weaker check than it looks.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/**
 * The setup link an unclaimed instance printed to its log (ADR 0023).
 *
 * The stack sets no digest, so the instance mints the link itself and the
 * suite reads it where an operator would. The last link in the log, because
 * the log spans the container's restarts, and every start before the claim
 * prints a new link and ends the one before it.
 *
 * Polled for a while: the line is written once the server listens and has
 * read that the instance is unclaimed, which can land a moment after the
 * health check that let the stack come up.
 */
export async function claimLinkFromLog(timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const links = [
      ...serviceLogs("app").matchAll(
        /(https?:\/\/\S+\/app\/setup#claim=[A-Za-z0-9_-]+)/g,
      ),
    ];
    const last = links.at(-1)?.[1];
    if (last !== undefined) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "the application's log holds no setup link: the instance is claimed " +
          "already, or it was started with OPENBRF_SETUP_TOKEN_DIGEST",
      );
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
}

/** The token out of a setup link: what follows `#claim=`. */
export function claimTokenOf(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("claim");
  if (token === null || token === "") {
    throw new Error(`no token on the setup link ${link}`);
  }
  return token;
}

/** Prints the instance's logs. Called when the suite fails, not otherwise. */
export function printAppLogs(): void {
  try {
    compose(
      ["logs", "--no-color", "--tail", "200", "schema-owner", "migrate", "app"],
      60_000,
    );
  } catch {
    // Best effort: a missing container must not mask the real failure.
  }
}
