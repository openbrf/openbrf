import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The production stack as a platform that shares one set of variables across
 * a stack runs it: every variable reaches every service, whatever each
 * service's own `environment:` in the compose file says.
 *
 * Coolify does this, and it is what a 0.1.0 instance did not survive: its
 * application's container was handed the superuser's and the owner's
 * passwords, and its entrypoint rightly refused to start with them. The
 * stack is rendered as docker-compose.prod.yml and an env file of the kind
 * docs/deployment.md has such an operator write, and then every service is
 * given the union of every service's environment through an override, before
 * anything starts.
 *
 * Node built-ins only, and nothing from the rest of the suite, so it runs
 * outside Playwright as well, against a compose project of the caller's.
 */

/** A stack started this way, and what can be asked of it. */
export type SharedEnvironmentStack = {
  /**
   * `docker compose up --wait`, from whatever the volumes hold: the whole
   * stack, or these services and what they depend on.
   */
  readonly up: (services?: readonly string[]) => void;
  /** Removes the containers and the volumes. */
  readonly down: () => void;
  /** A file inside a volume, as a one-off container of `service` reads it. */
  readonly readFile: (service: string, path: string) => string;
  /**
   * Runs `service` once more in a container of its own, with its own command
   * or with `command` in place of its entrypoint, `input` on its standard
   * input, and returns what it wrote.
   */
  readonly runOnce: (
    service: string,
    command?: readonly string[],
    input?: string,
  ) => { status: number; output: string };
  /**
   * Runs `command` in a running service's container, with `input` on its
   * standard input, and returns what it wrote.
   */
  readonly exec: (
    service: string,
    command: readonly string[],
    input?: string,
  ) => { status: number; output: string };
  /** What a service's containers have written to their log. */
  readonly logsOf: (service: string) => string;
  /** The environment a running service's container was started with. */
  readonly environmentOf: (service: string) => readonly string[];
  /** Every process's environment in a running service's container. */
  readonly processEnvironmentsOf: (service: string) => string;
  /** The container's health, as its health check reports it. */
  readonly healthOf: (service: string) => string;
};

export type SharedEnvironmentOptions = {
  /** The compose project, which nothing else may use. */
  readonly project: string;
  /** The image the instance's services run, already built or pulled. */
  readonly image: string;
  /** The database image, when it is to come from elsewhere than its pin. */
  readonly databaseImage?: string;
  /** The repository whose docker-compose.prod.yml is started. */
  readonly repositoryRoot: string;
  /**
   * Has the database log every statement it is sent, which no platform does,
   * so that a test can read in its log what reached the server.
   */
  readonly logStatements?: boolean;
};

/** The image every one of the instance's own services runs. */
const PUBLISHED_IMAGE = "ghcr.io/openbrf/openbrf:";

type RenderedConfig = {
  services: Record<
    string,
    { image: string; environment?: Record<string, string | null> }
  >;
};

/**
 * Prepares the stack: the env file an operator on such a platform writes, and
 * the override that gives every service every variable. Starts nothing.
 */
export function sharedEnvironmentStack(
  options: SharedEnvironmentOptions,
): SharedEnvironmentStack {
  const directory = mkdtempSync(join(tmpdir(), "openbrf-shared-env-"));
  const envFile = join(directory, "env");
  const override = join(directory, "shared.json");
  const composeFile = resolve(
    options.repositoryRoot,
    "docker-compose.prod.yml",
  );

  // What docs/deployment.md, "On a platform that shares every variable", has
  // an operator set: the release, the address and the one secret. Nothing
  // else, and no database password in particular. The address is loopback
  // because nothing outside the stack reaches it; the health check asks from
  // inside the container.
  writeFileSync(
    envFile,
    [
      "OPENBRF_VERSION=shared-environment",
      "APP_URL=http://localhost:3000",
      `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const compose = (
    args: readonly string[],
    files: readonly string[] = [composeFile, override],
    input?: string,
  ): string =>
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        options.project,
        ...files.flatMap((file) => ["-f", file]),
        "--env-file",
        envFile,
        ...args,
      ],
      {
        cwd: options.repositoryRoot,
        encoding: "utf8",
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 10 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        ...(input === undefined ? {} : { input }),
      },
    );

  const rendered = JSON.parse(
    compose(["config", "--format", "json"], [composeFile]),
  ) as RenderedConfig;

  // Every service's environment, folded into one. A name two services give
  // different values would make the union depend on the order it was read
  // in, and the run would test less than it says: refused rather than
  // guessed at.
  const shared: Record<string, string> = {};
  for (const [name, service] of Object.entries(rendered.services)) {
    for (const [variable, value] of Object.entries(service.environment ?? {})) {
      const text = value ?? "";
      if (variable in shared && shared[variable] !== text) {
        throw new Error(
          `${variable} has a value in ${name} that another service does not ` +
            "share, so the union of their environments is not one stack's " +
            "variables",
        );
      }
      shared[variable] = text;
    }
  }

  writeFileSync(
    override,
    JSON.stringify({
      services: Object.fromEntries(
        Object.entries(rendered.services).map(([name, service]) => [
          name,
          {
            environment: shared,
            ...(service.image.startsWith(PUBLISHED_IMAGE)
              ? { image: options.image, pull_policy: "never" }
              : {}),
            ...(name === "db" && options.databaseImage !== undefined
              ? { image: options.databaseImage }
              : {}),
            ...(name === "db" && options.logStatements === true
              ? { command: ["postgres", "-c", "log_statement=all"] }
              : {}),
          },
        ]),
      ),
    }),
  );

  const containerOf = (service: string): string => {
    const id = compose(["ps", "--quiet", service]).trim();
    if (id === "") {
      throw new Error(`${service} has no running container`);
    }
    return id;
  };

  // A command's status and output, whether or not it succeeded.
  const attempt = (
    args: readonly string[],
    input?: string,
  ): { status: number; output: string } => {
    try {
      return { status: 0, output: compose(args, undefined, input) };
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
  };

  const runOnce: SharedEnvironmentStack["runOnce"] = (
    service,
    command,
    input,
  ) => {
    const [entrypoint, ...args] = command ?? [];
    return attempt(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        ...(entrypoint === undefined ? [] : ["--entrypoint", entrypoint]),
        service,
        ...args,
      ],
      input,
    );
  };

  return {
    up: (services = []) => {
      compose([
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "300",
        ...services,
      ]);
    },
    down: () => {
      try {
        compose(["down", "--volumes", "--remove-orphans"]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    runOnce,
    exec: (service, command, input) =>
      attempt(["exec", "-T", service, ...command], input),
    logsOf: (service) => compose(["logs", "--no-color", service]),
    readFile: (service, path) => {
      const { status, output } = runOnce(service, ["cat", path]);
      if (status !== 0) {
        throw new Error(`${service} could not read ${path}: ${output}`);
      }
      return output;
    },
    environmentOf: (service) =>
      JSON.parse(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{json .Config.Env}}", containerOf(service)],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      ) as string[],
    processEnvironmentsOf: (service) =>
      compose([
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        'for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null; echo; done',
      ]),
    healthOf: (service) =>
      execFileSync(
        "docker",
        [
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          containerOf(service),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim(),
  };
}
