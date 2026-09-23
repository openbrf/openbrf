import { z } from "zod";

/**
 * Environment variables are parsed once at boot and never read from
 * process.env again, so a missing or malformed value fails immediately with a
 * readable message instead of surfacing as undefined deep in a request.
 *
 * The variables themselves are documented for operators in .env.example.
 */

/**
 * Environment values are always strings, so booleans need an explicit
 * transform rather than z.boolean(). Anything other than "true" is false.
 */
function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? defaultValue : value === "true",
    );
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/**
 * Whether a client could reach this instance at the address given.
 *
 * Loopback is allowed unencrypted because that is what a development instance
 * and the end-to-end stack run on; everything else must be https, since the
 * address leaves this process in a discovery document and a token's audience.
 * Deliberately not a regular expression: a URL is parsed by the parser, and a
 * pattern that agreed with it on the easy cases would disagree on the ones
 * that matter.
 */
function isReachableAppUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  /*
   * A bare origin and nothing else. This value is not only dialled: it is the
   * base every sign-in link is built on, it is published verbatim in the
   * discovery documents, and it is the audience every access token is bound
   * to. Credentials written into it would be published to anyone who reads a
   * discovery document, and a path would be dropped silently rather than
   * honoured - the resource URL is resolved from an absolute path, so
   * `https://brf.example/base` yields `https://brf.example/api/...` and an
   * operator who meant to mount the instance under a prefix gets an audience
   * that is not where their instance is. Refusing the value names the variable
   * at boot instead.
   */
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  // The parser always returns an IPv6 host bracketed, so the bracketed form is
  // the only one that can appear here; an unbracketed one does not survive
  // parsing to reach this line.
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

/**
 * Hard ceiling on the configured upload limit, 32 MiB.
 *
 * The limit is what stops a request from filling the disk or the heap, and an
 * operator who mistypes it has removed that protection rather than relaxed it.
 * A bound the configuration cannot exceed keeps the failure a boot error.
 *
 * The ceiling is this low because an upload is held in memory in full while it
 * is dealt with: the multipart parser reads it into a buffer, the type is
 * identified from those bytes, a checksum is taken over them, the file is
 * sealed into a second buffer of about the same size (ADR 0015), and the S3
 * driver hashes that again to sign the request. One request therefore costs a
 * small multiple of the file, and concurrent uploads multiply that again, so the
 * ceiling is what a self-hosted instance in a modest container can survive
 * rather than what a file format might justify. Raising it is a decision that
 * belongs with an upload path that streams end to end.
 */
const MAX_UPLOAD_CEILING_BYTES = 32 * 1024 * 1024;

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The schema owner's connection: migrations, the job schema install and the
   * seed CLI. Optional, and absent from a production server's environment: the
   * owner can disable the statutory archive triggers, so the container
   * entrypoint drops it once the deploy steps that need it have run, and the
   * process that serves requests holds DATABASE_URL_RUNTIME alone.
   */
  DATABASE_URL: z.string().min(1).optional(),
  /**
   * Non-owner connection for the application. Production sets this to the
   * openbrf_app role so the statutory archive guards cannot be bypassed
   * (see prisma/sql/harden-runtime-role.sql).
   */
  DATABASE_URL_RUNTIME: z.string().min(1).optional(),

  /**
   * Public base URL, used to build invitation and magic links.
   *
   * Also the origin of the OAuth protected resource, which is the audience
   * every access token is issued for, so it must be an address a client can
   * actually reach: https, or loopback for a development instance. That mirrors
   * what the sign-in library validates when it is constructed, and turns a
   * stack trace out of somebody else's package into an error naming this
   * variable. Changing it after tokens have been issued invalidates them all,
   * which docs/deployment.md states.
   */
  APP_URL: z
    .string()
    .min(1)
    .refine(
      isReachableAppUrl,
      "must be an https URL, or http on localhost, and carry no credentials, path, query or fragment",
    )
    .default("http://localhost:5173"),

  /** Holds uploads, keys, installed plugins and installed themes. */
  OPENBRF_DATA_DIR: z.string().min(1).default("./.data"),

  /**
   * Field encryption key, 32 bytes hex encoded. When absent the key is read
   * from, or generated into, the data volume (ADR 0002).
   */
  OPENBRF_ENCRYPTION_KEY: z
    .string()
    .regex(HEX_32_BYTES, "must be 32 bytes hex encoded (64 hex characters)")
    .optional(),

  BETTER_AUTH_SECRET: z.string().min(16),

  /**
   * Where uploaded files are kept. "local" writes under OPENBRF_DATA_DIR,
   * "s3" into an S3-compatible bucket. Neither changes how files are served:
   * the API streams the bytes from its own origin in both cases.
   */
  OPENBRF_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),

  OPENBRF_S3_ENDPOINT: z.string().min(1).optional(),
  OPENBRF_S3_REGION: z.string().min(1).default("us-east-1"),
  OPENBRF_S3_BUCKET: z.string().min(1).optional(),
  OPENBRF_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  OPENBRF_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /**
   * Bucket in the path rather than in the host name. Self-hosted servers
   * generally require it; AWS S3 itself does not.
   */
  OPENBRF_S3_FORCE_PATH_STYLE: envBoolean(false),

  /** Largest upload accepted, in bytes. Enforced while the body is read. */
  OPENBRF_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_UPLOAD_CEILING_BYTES)
    .default(10 * 1024 * 1024),

  /**
   * How many calls one connected app's token may make in a minute.
   *
   * A bound on what a single connection can do to an instance, not a quota a
   * cooperative is billed against. Each call costs a token lookup, an account
   * lookup and a capability query, and the connections this bounds are
   * programs rather than people, so an unbounded one is a load an association
   * never agreed to. Counted per process; token-rate-limit.ts says what that
   * means.
   */
  OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  OPENBRF_PLUGINS_ENABLED: envBoolean(true),
  OPENBRF_CATALOG_URL: z.string().min(1).optional(),
  OPENBRF_CATALOG_TOKEN: z.string().min(1).optional(),
  OPENBRF_UNCURATED_PLUGINS_ENABLED: envBoolean(false),
  /**
   * Reinstall plugins at boot when the data volume does not carry them.
   *
   * Off by default, because on a normal deployment /data/plugins is a volume
   * and an empty one means something is wrong that a silent reinstall would
   * hide. It exists for deployments with no persistent volume at all, where an
   * empty installation directory on every boot is the expected state and the
   * database is the only record of what should be running.
   */
  OPENBRF_PLUGINS_REINSTALL_ON_BOOT: envBoolean(false),
  /**
   * Refuse every action that writes, whatever the caller may do.
   *
   * An instance-wide switch above every per-caller check, for the operator who
   * wants a connected app read-only while they watch what it does. It is not a
   * permission and it cannot be narrowed per person: the point is that the
   * answer does not depend on who asked, so a refusal cannot be used to probe
   * what a token would otherwise reach.
   */
  OPENBRF_ACTIONS_READ_ONLY: envBoolean(false),
});

/**
 * The S3 driver needs a bucket and credentials, and there is no safe default
 * for any of them.
 *
 * Checked here rather than when the first upload arrives, because an instance
 * that boots with half a storage configuration looks healthy until somebody
 * uploads a file, and by then the operator is debugging a failed upload rather
 * than reading a boot error that names the missing variable.
 */
const S3_REQUIRED = [
  "OPENBRF_S3_ENDPOINT",
  "OPENBRF_S3_BUCKET",
  "OPENBRF_S3_ACCESS_KEY_ID",
  "OPENBRF_S3_SECRET_ACCESS_KEY",
] as const;

const envChecked = envSchema.superRefine((value, ctx) => {
  // One of the two connections has to be there, because there is no default
  // that could be right. Which one it is says what the process is for: a deploy
  // step runs as the owner, a server runs as openbrf_app.
  if (
    value.DATABASE_URL === undefined &&
    value.DATABASE_URL_RUNTIME === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message:
        "is required unless DATABASE_URL_RUNTIME is set. One of the two names " +
        "the database this process connects to.",
    });
  }

  if (value.OPENBRF_STORAGE_DRIVER !== "s3") {
    return;
  }
  for (const name of S3_REQUIRED) {
    if (value[name] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: 'is required when OPENBRF_STORAGE_DRIVER is "s3"',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * The connection the application itself opens.
 *
 * DATABASE_URL_RUNTIME wherever it is set, which is everywhere the image runs:
 * that role owns nothing, so the append-only guards on the member register and
 * the audit log are not its to disable. The owner connection is the fallback
 * for a development instance configured with one role, and PrismaService
 * refuses that combination in production.
 */
export function applicationDatabaseUrl(env: Env): string {
  const url = env.DATABASE_URL_RUNTIME ?? env.DATABASE_URL;
  if (url === undefined) {
    throw new Error(
      "Neither DATABASE_URL_RUNTIME nor DATABASE_URL is set, so there is no " +
        "database for the application to connect to.",
    );
  }
  return url;
}

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  ${issues.join("\n  ")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * An empty value means "not set".
 *
 * Compose, Kubernetes and every hosting panel pass an unset optional variable
 * as an empty string rather than omitting it, so `OPENBRF_CATALOG_TOKEN=` has
 * to reach the schema as absent. Otherwise the deployment fails validation for
 * a value the operator deliberately left blank, and `.default()` never
 * applies.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );
}

/**
 * Parses and validates the environment. Throws EnvValidationError listing
 * every problem at once, so an operator fixes one deploy rather than five.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envChecked.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
