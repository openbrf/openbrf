import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

import { pullWithRetry } from "./image-pull";

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
  e2e: { project: "openbrf-e2e", envFile: "stack.env", catalogKind: "all" },
  screenshots: {
    project: "openbrf-shots",
    envFile: "screenshots.env",
    catalogKind: "theme",
  },
} as const;

const profile: (typeof PROFILES)[keyof typeof PROFILES] =
  process.env.OPENBRF_E2E_PROFILE === "screenshots"
    ? PROFILES.screenshots
    : PROFILES.e2e;

export const PROJECT_NAME = profile.project;

const ENV_FILE = resolve(e2eRoot, profile.envFile);

/**
 * The overlay that points the stack at CI's copies of its third-party images,
 * written by writeMirrorOverlay, or undefined where OPENBRF_IMAGE_MIRROR names
 * no mirror and the pins are pulled as they are.
 *
 * Outside the repository and per profile, for the reasons the catalog below is.
 */
const MIRROR_OVERLAY =
  (process.env.OPENBRF_IMAGE_MIRROR ?? "") === ""
    ? undefined
    : join(tmpdir(), `${PROJECT_NAME}-image-mirror.json`);

const COMPOSE_ARGS = [
  "compose",
  "-p",
  PROJECT_NAME,
  "-f",
  resolve(repositoryRoot, "docker-compose.prod.yml"),
  "-f",
  resolve(e2eRoot, "docker-compose.e2e.yml"),
  ...(MIRROR_OVERLAY === undefined ? [] : ["-f", MIRROR_OVERLAY]),
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

/**
 * Where the fixture catalog is written, and mounted from.
 *
 * Outside the repository, because nothing in it is worth keeping: it is rebuilt
 * on every start, and its tarballs are already rebuilt from fixtures by anyone
 * who wants them. Per profile for the reason the certificate is.
 */
const CATALOG_DIR = join(tmpdir(), `${PROJECT_NAME}-catalog`);

/**
 * The sign-in secret of this run's stack.
 *
 * Generated rather than read from the env file: the application refuses a
 * secret that is short, has too few different characters or is written into the
 * repository, and the stack runs in production mode. The value lives only in
 * this process and in the stack it starts, and the volumes it signed anything
 * into are destroyed with it. Compose gives the environment precedence over
 * `--env-file`, so no entry is needed there.
 */
const AUTH_SECRET = randomBytes(48).toString("base64");

/**
 * The environment of every `docker compose` call against the suite's stack.
 * Each one interpolates the compose files again, `logs` and `exec` included, so
 * a call without these fails on the overlay's required variables.
 */
const COMPOSE_ENV = {
  ...process.env,
  BETTER_AUTH_SECRET: AUTH_SECRET,
  OPENBRF_E2E_MAIL_TLS_DIR: MAIL_TLS_DIR,
  OPENBRF_E2E_CATALOG_DIR: CATALOG_DIR,
};

/** Reads stack.env so the suite and the stack cannot drift apart. */
function readStackEnv(): Readonly<Record<string, string>> {
  const entries = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      // Without this a typo would be sliced into a nonsense name, and what
      // failed would be a later lookup reporting a variable as missing.
      if (separator <= 0) {
        throw new Error(`${ENV_FILE}: "${line}" is not NAME=value`);
      }
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
 *
 * The fixture catalog is written between the two, while nothing has it mounted.
 */
export function startStack(): void {
  // Without a mirror the stack pulls the pins as they are, which in CI spends
  // the anonymous quotas the mirror is there to avoid, and still passes until
  // a quota runs out. Refused, so that a variable lost on the way here (a
  // task runner's environment filter, say) fails the run that loses it.
  if (MIRROR_OVERLAY === undefined && (process.env.CI ?? "") !== "") {
    throw new Error(
      "CI is set but OPENBRF_IMAGE_MIRROR is not, so the stack would pull " +
        "its images from metered registries. Set it as .github/workflows/" +
        "ci.yml does, and pass it through turbo.json to this task.",
    );
  }
  // First, because every compose call names the overlay, `down` included.
  if (MIRROR_OVERLAY !== undefined) {
    writeMirrorOverlay(MIRROR_OVERLAY);
  }
  compose(["down", "--volumes", "--remove-orphans"], 5 * 60_000);
  writeMailTls();
  writeFixtureCatalog();
  pullImages();
  compose(["up", "--build", "--detach", "--wait"], 30 * 60_000);
}

/**
 * Pulls the stack's registry images, retrying a throttled or transient failure
 * (see image-pull.ts) and nothing else. Images built from the repository are
 * left to `up --build`.
 */
function pullImages(): void {
  pullWithRetry(pullOnce);
}

/**
 * One `compose pull`, failing with what compose wrote to its error stream.
 *
 * That stream is where compose reports progress and a registry's answer, and
 * it is read to tell a throttled pull from a missing image, so it is captured
 * rather than inherited and then passed on whole, success or not.
 */
function pullOnce(): void {
  const result = spawnSync(
    "docker",
    [...COMPOSE_ARGS, "pull", "--ignore-buildable"],
    {
      cwd: repositoryRoot,
      env: COMPOSE_ENV,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "pipe"],
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  process.stderr.write(result.stderr ?? "");
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `docker compose pull exited with ${result.status ?? result.signal}:\n${result.stderr}`,
    );
  }
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

/**
 * The fixtures and a catalog index offering them, for either stack.
 *
 * The curated catalog lists no theme yet, so a stack reading it can never show
 * a screen about a catalog entry, and the suite would have to read the network
 * to install anything. This is the index the API's own suites install from,
 * built by the same script, with its artifact URLs naming where
 * docker-compose.e2e.yml mounts it. The suite installs the fixture plugin and
 * the fixture themes through the real download, digest and unpack path, so it
 * is given both kinds; the walk only lists the themes and installs nothing.
 */
function writeFixtureCatalog(): void {
  rmSync(CATALOG_DIR, { recursive: true, force: true });
  mkdirSync(CATALOG_DIR, { recursive: true });
  execFileSync(
    "node",
    [
      resolve(repositoryRoot, "scripts", "build-fixture-catalog.mjs"),
      "--kind",
      profile.catalogKind,
      "--out",
      CATALOG_DIR,
      "--url-prefix",
      "file:///catalog/",
    ],
    { cwd: repositoryRoot, stdio: "inherit", timeout: 15 * 60_000 },
  );
}

/** The services that build the instance's image (docker-compose.e2e.yml). */
const BUILT_SERVICES = [
  "superuser-password",
  "schema-owner",
  "migrate",
  "app",
] as const;

/**
 * The overlay that swaps the stack's PostgreSQL image and the build's base
 * image for their copies in the CI image mirror, as scripts/ci-images.mjs
 * names them: the same tags and digests, from a registry CI's own token pulls
 * from without a quota.
 *
 * The base image is swapped with a named build context, which BuildKit uses in
 * place of the image a FROM line names, so the Dockerfile keeps the reference
 * an operator's build pulls.
 */
function writeMirrorOverlay(path: string): void {
  const refs = mirrorRefs();
  const build = {
    build: {
      additional_contexts: {
        [refs.node.upstream]: `docker-image://${refs.node.pull}`,
      },
    },
  };
  writeFileSync(
    path,
    JSON.stringify({
      services: {
        db: { image: refs.postgres.pull },
        ...Object.fromEntries(BUILT_SERVICES.map((name) => [name, build])),
      },
    }),
  );
}

/** The mirror's copies of the pinned images, as scripts/ci-images.mjs names them. */
function mirrorRefs(): Record<
  "postgres" | "node",
  { upstream: string; pull: string }
> {
  return JSON.parse(
    execFileSync(
      "node",
      [resolve(repositoryRoot, "scripts", "ci-images.mjs"), "refs"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
    ),
  ) as Record<"postgres" | "node", { upstream: string; pull: string }>;
}

/**
 * The image the suite's stack builds from this checkout, under the tag
 * stack.env gives it, for a spec that starts a stack of its own from it.
 */
export const builtImage = required("E2E_IMAGE");

/**
 * The database image a stack of a spec's own pulls: CI's copy of the pin where
 * OPENBRF_IMAGE_MIRROR names a mirror, as the suite's own stack does, and the
 * pin itself otherwise.
 */
export function databaseImage(): string | undefined {
  return MIRROR_OVERLAY === undefined ? undefined : mirrorRefs().postgres.pull;
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
  return runOneShot("schema-owner", environment, timeoutMs);
}

/**
 * Runs the migrate service once more, as `up` runs it before every deploy: the
 * deploy steps in docker/entrypoint.sh, as the schema owner, in a container of
 * their own. `environment` overrides what the env file gives the service.
 */
export function runMigrate(
  environment: Readonly<Record<string, string>> = {},
  timeoutMs = 180_000,
): {
  status: number;
  output: string;
} {
  return runOneShot("migrate", environment, timeoutMs);
}

function runOneShot(
  service: "schema-owner" | "migrate",
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
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
        service,
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
 * Runs a command in a new application container, through the entrypoint.
 *
 * `docker compose run` rather than `exec`, and the difference is the point.
 * `exec` joins the server's container past its entrypoint, so the command would
 * start without the runtime database URL the entrypoint assembles and without
 * the owner's credentials having been dropped. A new container goes through the
 * same entrypoint an operator's own `run` does, with the server's image,
 * environment and volumes, and is removed afterwards. It publishes no port and
 * starts nothing it depends on, because the stack is already up.
 *
 * Both streams are returned whatever the exit code, so a failure can be read
 * in the assertion that reports it.
 */
export function runInNewAppContainer(
  command: readonly string[],
  timeoutMs: number,
): { status: number; output: string } {
  const result = spawnSync(
    "docker",
    [...COMPOSE_ARGS, "run", "--rm", "--no-deps", "-T", "app", ...command],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * When the application container's current process started.
 *
 * The server replaces itself by exiting and leaving the rest to the
 * supervisor, which here is the restart policy in docker-compose.prod.yml, so
 * every replacement is a new start of the same container. Read from Docker
 * rather than from the instance: a process cannot be asked when it started
 * while it is the one being replaced.
 */
export function appStartedAt(): Date {
  const containerId = execFileSync(
    "docker",
    // --all, because between one process and the next the container is not
    // running, and without it the container would not be listed at all.
    [...COMPOSE_ARGS, "ps", "--all", "--quiet", "app"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  ).trim();
  if (containerId === "") {
    throw new Error("The application container does not exist.");
  }
  const startedAt = execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.StartedAt}}", containerId],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  ).trim();
  return new Date(startedAt);
}

/**
 * The production compose file resolved against an env file holding exactly
 * these variables, as `docker compose config` renders it, with the files in
 * `overlays` added after it, named relative to the repository root.
 *
 * Without the e2e overlay and without stack.env, because what an operator
 * following docs/deployment.md runs is docker-compose.prod.yml and their own
 * .env.production. A variable that file does not name never reaches the image,
 * however carefully it is set, so the rendering is where a documented
 * configuration path can be shown to exist at all. Nothing is started.
 */
export function productionComposeConfig(
  variables: Readonly<Record<string, string>>,
  overlays: readonly string[] = [],
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
          ...overlays.flatMap((overlay) => [
            "-f",
            resolve(repositoryRoot, overlay),
          ]),
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
 * `superuser-password` for the superuser's password, `schema-owner` for the
 * owner's creation, `migrate` for the deploy steps, `app` for the application.
 *
 * Read rather than printed: a spec asserts on what is and is not in it. This is
 * the boot that actually ran - the key provisioning, the migrations and the
 * step that reads the owner's password out of DATABASE_URL in the one, the
 * start in the other - so it is the only place the question "did any of that
 * print a credential" has a real answer.
 */
export function serviceLogs(
  service: "superuser-password" | "schema-owner" | "migrate" | "app",
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

/**
 * Where teardown leaves the stack's logs: `test-results/app.log` at the
 * repository root, beside what Playwright writes there for a failed test, so
 * CI can keep the whole directory.
 */
export const STACK_LOG_FILE = resolve(repositoryRoot, "test-results/app.log");

/**
 * Writes the deploy steps' and the application's logs to STACK_LOG_FILE.
 *
 * Called before the stack is removed, because removing it removes them: a
 * failure caused by an exception on the server would otherwise leave only the
 * browser's half of the story, and the stack trace that explains it would have
 * to be reproduced locally.
 */
export function saveStackLogs(): void {
  try {
    const logs = (
      ["superuser-password", "schema-owner", "migrate", "app"] as const
    )
      .map((service) => `=== ${service}\n${serviceLogs(service)}`)
      .join("\n");
    mkdirSync(dirname(STACK_LOG_FILE), { recursive: true });
    writeFileSync(STACK_LOG_FILE, logs);
  } catch (failure) {
    // Best effort: a missing container must not mask the real failure.
    console.warn(`could not save the stack's logs: ${String(failure)}`);
  }
}
